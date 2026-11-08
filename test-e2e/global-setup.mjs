// Brings up a chain and deploys the real contracts before any page is opened.
//
// The addresses are written to .addresses.json rather than an env var so the spec reads
// exactly what was deployed for this run. A stale file from a previous run would point
// the page at contracts that no longer exist, which renders as an empty chain rather
// than an error, so it is rewritten every time and removed on teardown.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startAnvil, deploy } from "./chain.mjs";

export default async function globalSetup() {
  const anvil = await startAnvil();
  // Kept on globalThis so teardown can reach it; Playwright runs both in one process.
  globalThis.__anvil = anvil;

  const contracts = await deploy(join(import.meta.dirname, "..", "contracts"));
  writeFileSync(
    join(import.meta.dirname, ".addresses.json"),
    JSON.stringify(contracts, null, 2) + "\n"
  );
  console.log(`anvil up, escrow ${contracts.escrow}`);
}
