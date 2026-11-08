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

const uuid = process.argv[2];
if (!uuid || !/^[0-9a-f-]{32,36}$/i.test(uuid)) {
  console.error("usage: node scripts/blueprint-status.mjs <uuid>");
  console.error("the uuid is the last path segment of the registry URL for your blueprint");
  process.exit(1);
}

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
if (b.num_public_inputs != null) {
  console.log(`  public inputs  ${b.num_public_inputs}  <- check SIGNAL_COUNT against this`);
}
