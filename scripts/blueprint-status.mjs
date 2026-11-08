// Asks the registry's own API what a blueprint's status actually is.
//
//   node scripts/blueprint-status.mjs <uuid-from-the-registry-url>
//
// WHY THIS EXISTS.
//
// registry.zk.email renders "Compilation in progress ... will take few hours to
// complete" and keeps rendering it, so after a day the page cannot distinguish a job
// that is running from one that died. The question "has it failed?" has an answer and
// the UI will not give it.
//
// The API will. `GET https://conductor.zk.email/blueprint/<uuid>` needs no auth and
// returns server_status. Found by enumerating the host after the browser blocked the
// same calls cross-origin: curl has no such restriction, which is the only reason this
// was reachable at all.
//
// WHAT THE NUMBER MEANS, HONESTLY.
//
// The SDK bundle contains exactly one status enum, `None=0, InProgress=1, Done=2,
// Failed=3`, and it sits beside the proof-verification code, so it is very likely
// ProofStatus rather than the blueprint's. Against it, every one of 50 public
// blueprints sampled from /blueprint reports server_status 3, which cannot mean they
// all failed. docs/blueprint-spec.md section 7 also recorded 3 on a blueprint that was
// demonstrably compiled.
//
// So: 3 is the healthy terminal state for a blueprint, and 1 means it is still working.
// That is an inference from the sample, not from a documented enum, so this prints the
// raw value alongside the reading rather than hiding it.

// Accepts the whole registry URL as well as a bare uuid, so the thing you paste is the
// thing in your address bar. A placeholder left unreplaced has already cost this project
// real time once, and the fix is to not require an edit.
const raw = (process.argv[2] || "").trim();
const found = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
if (!found) {
  console.error("usage: node scripts/blueprint-status.mjs <registry URL or uuid>");
  console.error("  e.g. node scripts/blueprint-status.mjs https://registry.zk.email/811e63d3-...");
  if (raw.includes("<") || raw.includes(">")) {
    console.error("\nthat looks like the placeholder. Paste the real URL from your address bar.");
  } else if (raw) {
    console.error(`\nno uuid found in: ${raw}`);
  }
  process.exit(1);
}
const uuid = found[0];

const READING = {
  0: "not started",
  1: "still compiling",
  2: "see the raw value: this is the one the enum and the sample disagree about",
  3: "finished (every compiled public blueprint sampled reports 3)",
};

const res = await fetch(`https://conductor.zk.email/blueprint/${uuid}`, {
  headers: { accept: "application/json" },
});
if (!res.ok) {
  console.error(`the registry answered ${res.status}. A 404 usually means the uuid is wrong.`);
  process.exit(1);
}
const b = await res.json();

console.log(`${b.slug ?? "(no slug)"}  v${b.version ?? "?"}`);
console.log(`  server_status  ${b.server_status}   ${READING[b.server_status] ?? "unknown value"}`);
console.log(`  client_status  ${b.client_status}`);
if (b.verifier_contract_address) {
  console.log(`  verifier       ${b.verifier_contract_address} on chain ${b.verifier_contract_chain}`);
} else {
  console.log(`  verifier       none published (chain ${b.verifier_contract_chain ?? "?"})`);
  console.log("                 deploying it is then our job: see blueprint-spec.md 8.2");
}
// The status alone did not settle it; the timestamps did. A live compile keeps touching
// the record. Ours moved for fifty minutes after creation and then went silent for over
// forty hours while the page still said "in progress", so staleness is the real signal
// and it is the thing the UI hides behind "Updated 1 day ago".
const secs = (t) => (t && typeof t === "object" ? Number(t.seconds) : Number(t));
const created = secs(b.created_at);
const updated = secs(b.updated_at);
if (created && updated) {
  const now = Math.floor(Date.now() / 1000);
  const dur = (n) => {
    const h = Math.floor(n / 3600);
    const m = Math.floor((n % 3600) / 60);
    return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h ${m}m` : `${h}h ${m}m`;
  };
  console.log(`  worked for     ${dur(updated - created)} after creation`);
  console.log(`  silent for     ${dur(now - updated)}`);
  if (b.server_status !== 3 && now - updated > 6 * 3600) {
    console.log(
      `\n  Not finished, and nothing has touched this record in ${dur(now - updated)}.`
    );
    console.log("  A running compile keeps updating it. Treat this as dead and requeue.");
  }
}
if (b.num_public_inputs != null) {
  console.log(`  public inputs  ${b.num_public_inputs}  <- check SIGNAL_COUNT against this`);
}
