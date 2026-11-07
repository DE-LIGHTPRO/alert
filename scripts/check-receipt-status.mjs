// A mined transaction is not a successful one.
//
// Run: node scripts/check-receipt-status.mjs
//
// WHY.
//
// Every write in web/app.js awaited `waitForTransactionReceipt` and returned it
// unexamined. A receipt means mined, not succeeded: a reverted transaction produces one
// too, with `status: "reverted"` and no logs.
//
// Driving the refund path before its deadline, the escrow correctly refused, the
// transaction was mined reverted, and the page reported "Reclaimed." with a transaction
// hash while the USDC never moved and the escrow stayed Open. The same bug on the settle
// path tells a buyer their money was released when nothing happened.
//
// A wallet usually estimates gas first and warns, which is why this survived a long
// time, but estimation is not a guarantee: state can change between estimating and
// mining, which is exactly what a deadline expiring or a competing settle does.
//
// So `waitForTransactionReceipt` may appear in exactly one place, the `confirmed()`
// helper that checks the status and throws.

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// Mask comments before scanning. The first version counted the mention of the call in
// this guard's own explanation of the bug, and reported app.js as violating it. A
// source guard that reads prose as code is the defect it was written to catch.
// Replacing with spaces keeps every index aligned with the original text.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

const WEB = join(resolve(import.meta.dirname, ".."), "web");
const CALL = /waitForTransactionReceipt/g;
const ALLOWED_IN = "app.js";
const ALLOWED_ENCLOSING = "async function confirmed(";

let total = 0;
const bad = [];

for (const file of readdirSync(WEB).filter((f) => f.endsWith(".js"))) {
  const src = readFileSync(join(WEB, file), "utf8");
  const code = stripComments(src);
  for (const m of code.matchAll(CALL)) {
    total++;
    if (file !== ALLOWED_IN) {
      bad.push(`${file}: waitForTransactionReceipt outside ${ALLOWED_IN}`);
      continue;
    }
    // The only permitted call sits inside confirmed(). Find the nearest preceding
    // function header rather than counting braces.
    //
    // This first matched only "\nasync function ", so a call inside
    // `export async function settleEscrow` walked back past it to confirmed() and
    // passed. The guard reported clean against the exact bug it exists to catch, which
    // is why it is mutation-tested by reintroducing that call specifically.
    const before = code.slice(0, m.index);
    let lastFn = -1;
    let name = "(top level)";
    for (const h of before.matchAll(/^(?:export\s+)?async function\s+([A-Za-z0-9_$]+)\s*\(/gm)) {
      lastFn = h.index;
      name = h[1];
    }
    if (lastFn === -1 || name !== "confirmed") {
      bad.push(`${file}: waitForTransactionReceipt inside ${name}() — use confirmed()`);
    }
  }
}

if (total === 0) {
  console.error("no waitForTransactionReceipt found at all: this guard is checking nothing");
  process.exit(1);
}
console.log(`checked ${total} receipt call(s)`);
if (bad.length) {
  console.error(`\n${bad.length} unchecked receipt(s):`);
  for (const b of bad) console.error(`  - ${b}`);
  console.error("\nA receipt is not a success. Await it through confirmed(), which checks status.");
  process.exit(1);
}
console.log("every receipt goes through confirmed(), which checks status");
