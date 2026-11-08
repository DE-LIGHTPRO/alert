// Switches the whole codebase between public-signal layouts in one command.
//
//   node scripts/set-signal-layout.mjs v1   # 9 signals: max 64/16/64/8
//   node scripts/set-signal-layout.mjs v2   # 6 signals: max 24/16/60/8
//
// WHY THIS IS A SCRIPT AND NOT A CHECKLIST.
//
// The signal count appears in more than twenty places across six files: the adapter's
// constants and offsets, the IGroth16Verifier and IAlertVerifier interfaces,
// AlertEscrow.settle, the stub in DeployDemo, the LiveTrade driver, every helper and
// assertion in AlertEscrow.t.sol, and the settle ABI string in web/app.js.
//
// Solidity catches a file it disagrees with. Nothing catches web/app.js disagreeing
// with the chain except a real proof failing to settle, which is the worst place to
// find out. Doing this by hand at 3am, on the one night it matters, is how a digit gets
// missed.
//
// The layouts come from the packing rule: a field of max length L occupies
// ceil(L / 31) signals, plus one for the DKIM public key hash. Section 8.1 of
// docs/blueprint-spec.md has the tables. The GENERATED VERIFIER is still the authority:
// read the array size out of its verifyProof signature and pick the layout that matches,
// or add one here if it matches neither.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

const LAYOUTS = {
  v1: { count: 9, senderAt: 0, senderN: 3, amountAt: 3, amountN: 1, nullAt: 4, nullN: 3, recipAt: 7, recipN: 1 },
  v2: { count: 6, senderAt: 0, senderN: 1, amountAt: 1, amountN: 1, nullAt: 2, nullN: 2, recipAt: 4, recipN: 1 },
};

const want = process.argv[2];
const L = LAYOUTS[want];
if (!L) {
  console.error(`usage: node scripts/set-signal-layout.mjs <${Object.keys(LAYOUTS).join("|")}>`);
  process.exit(1);
}

// Every file that names the array size. web/app.js is in here on purpose: it is the one
// the compiler cannot check.
const FILES = [
  "contracts/src/AlertProofAdapter.sol",
  "contracts/src/AlertEscrow.sol",
  "contracts/src/IAlertVerifier.sol",
  "contracts/script/LiveTrade.s.sol",
  "contracts/script/DeployDemo.s.sol",
  "contracts/test/AlertEscrow.t.sol",
  // The mock verifier implements IGroth16Verifier, so its signature must move too.
  // Missing it was caught by solc ("should be marked as abstract") rather than by this
  // list, which is the Solidity side doing the job web/app.js has nobody to do for it.
  "contracts/test/mocks/Mocks.sol",
  "web/app.js",
];

const SIZES = Object.values(LAYOUTS).map((l) => l.count);
let changed = 0;
let touchedArrays = 0;

for (const rel of FILES) {
  const path = join(ROOT, rel);
  const before = readFileSync(path, "utf8");
  let after = before;

  // uint256[N] in Solidity, and uint256[N] inside the settle ABI string in app.js.
  for (const n of SIZES) {
    const hits = after.match(new RegExp(`uint256\\[${n}\\]`, "g"));
    if (hits) touchedArrays += hits.length;
    after = after.replace(new RegExp(`uint256\\[${n}\\]`, "g"), `uint256[${L.count}]`);
  }

  if (rel.endsWith("AlertProofAdapter.sol")) {
    const set = (src, name, value) =>
      src.replace(
        new RegExp(`(uint256 (?:internal|public) constant ${name} = )\\d+`),
        `$1${value}`
      );
    after = set(after, "SENDER_AT", L.senderAt);
    after = set(after, "SENDER_N", L.senderN);
    after = set(after, "AMOUNT_AT", L.amountAt);
    after = set(after, "AMOUNT_N", L.amountN);
    after = set(after, "NULLIFIER_AT", L.nullAt);
    after = set(after, "NULLIFIER_N", L.nullN);
    after = set(after, "RECIPIENT_AT", L.recipAt);
    after = set(after, "RECIPIENT_N", L.recipN);
    after = set(after, "SIGNAL_COUNT", L.count);
  }

  // AlertEscrow.t.sol builds signal arrays from its own copy of the offsets. Leaving
  // them behind compiles at v1 and silently packs fields into the wrong slots at any
  // other layout, or fails on an out-of-bounds index, which is how this was found.
  if (rel.endsWith("AlertEscrow.t.sol")) {
    const body = new RegExp(
      String.raw`(_packInto\(s, )\d+(, sender\);)[^
]*
\s*(_packInto\(s, )\d+(, amountText\);)[^
]*
\s*(_packInto\(s, )\d+(, nullifier\);)[^
]*
\s*(_packInto\(s, )\d+(, recipient\);)[^
]*
\s*s\[\d+\]( = uint256\(keccak256\("dkim-key-hash"\)\) >> 8;)[^
]*`
    );
    if (!body.test(after)) {
      console.error(`could not find the signal-building helper in ${rel}`);
      process.exit(1);
    }
    const dkim = L.recipAt + L.recipN;
    after = after.replace(
      body,
      `$1${L.senderAt}$2 // ${L.senderN} signal(s)
` +
        `        $3${L.amountAt}$4 // ${L.amountN}
` +
        `        $5${L.nullAt}$6 // ${L.nullN}
` +
        `        $7${L.recipAt}$8 // ${L.recipN}
` +
        `        s[${dkim}]$9 // the key hash signal`
    );
  }

  if (after !== before) {
    writeFileSync(path, after);
    changed++;
    console.log(`  updated ${rel}`);
  }
}

// A rewrite that matched nothing would leave the tree on the old layout and report
// success, which is the failure this script exists to prevent.
if (touchedArrays === 0) {
  console.error("no uint256[N] sites found: the patterns no longer match the source");
  process.exit(1);
}

// Prove the adapter actually ended up where it was asked to go, rather than trusting
// that nine replacements all landed.
const adapter = readFileSync(join(ROOT, "contracts/src/AlertProofAdapter.sol"), "utf8");
const got = {
  SIGNAL_COUNT: +(adapter.match(/SIGNAL_COUNT = (\d+)/) || [])[1],
  SENDER_N: +(adapter.match(/SENDER_N = (\d+)/) || [])[1],
  NULLIFIER_AT: +(adapter.match(/NULLIFIER_AT = (\d+)/) || [])[1],
  RECIPIENT_AT: +(adapter.match(/RECIPIENT_AT = (\d+)/) || [])[1],
};
const expect = { SIGNAL_COUNT: L.count, SENDER_N: L.senderN, NULLIFIER_AT: L.nullAt, RECIPIENT_AT: L.recipAt };
for (const [k, v] of Object.entries(expect)) {
  if (got[k] !== v) {
    console.error(`${k} is ${got[k]}, expected ${v}: the layout did not fully apply`);
    process.exit(1);
  }
}

// Any source file still carrying another layout's size means FILES is incomplete. The
// broadcast/ and out/ directories are build output and legitimately keep old values.
import { execSync } from "node:child_process";
const stale = execSync(
  `grep -rl --include='*.sol' --include='*.js' -E 'uint256\\[(${SIZES.filter((n) => n !== L.count).join("|")})\\]' contracts/src contracts/script contracts/test web 2>/dev/null || true`,
  { cwd: ROOT, encoding: "utf8" }
).trim();
if (stale) {
  console.error(`\nthese still carry another layout's signal count:\n${stale}`);
  console.error("add them to FILES in this script");
  process.exit(1);
}

console.log(`\nlayout ${want}: ${L.count} signals across ${changed} file(s)`);
console.log("now run: cd contracts && forge test");
console.log("and check the count against the generated verifier's verifyProof signature.");
