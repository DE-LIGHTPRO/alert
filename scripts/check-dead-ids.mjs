// Every id in the markup must be reachable by something.
//
// Run: node scripts/check-dead-ids.mjs
//
// WHY.
//
// app.html carried <span id="net-chip">Base Sepolia</span> and no JavaScript ever wrote
// to it. The id said a value was going to be filled in; the literal next to it said what
// the value would be. On the deployed site that literal happens to be true, which is
// exactly what made it survive: it is only wrong when the page is pointed somewhere
// else, and the documented localStorage override does precisely that. A screenshot taken
// against a local anvil reported Base Sepolia.
//
// That is this project's most repeated defect in its smallest form. Registration is not
// wiring. An id is a promise that something addresses this element, and a hardcoded value
// under an unwired id is indistinguishable from a live one until you change the input.
//
// WHAT COUNTS AS REACHED.
//
// Named in a script, or targeted from the markup itself: a same-page href, a label's
// `for`, or an aria reference. Anything else is listed, with the first bit of its text,
// because a dead id holding a plausible-looking value is the case worth seeing.

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const WEB = join(ROOT, "web");

const files = readdirSync(WEB);
const html = files.filter((f) => f.endsWith(".html"));
const js = files.filter((f) => f.endsWith(".js"));

// Scripts, plus any inline <script> in the pages, which is where a small page often
// does its own wiring.
let scriptText = js.map((f) => readFileSync(join(WEB, f), "utf8")).join("\n");
for (const page of html) {
  const src = readFileSync(join(WEB, page), "utf8");
  for (const m of src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) scriptText += "\n" + m[1];
}

const dead = [];
let checked = 0;

for (const page of html) {
  const src = readFileSync(join(WEB, page), "utf8");

  // Ids addressed from within the markup itself are legitimately static.
  const markupRefs = new Set();
  for (const m of src.matchAll(/href="#([^"]+)"/g)) markupRefs.add(m[1]);
  for (const m of src.matchAll(/\bfor="([^"]+)"/g)) markupRefs.add(m[1]);
  for (const m of src.matchAll(/\baria-(?:labelledby|describedby|controls|owns)="([^"]+)"/g)) {
    for (const part of m[1].split(/\s+/)) markupRefs.add(part);
  }

  for (const m of src.matchAll(/\bid="([^"]+)"/g)) {
    const id = m[1];
    checked++;
    if (markupRefs.has(id)) continue;
    // Quoted in a script: getElementById("x"), $("x"), querySelector("#x").
    const q = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`["'\`]#?${q}["'\`]`).test(scriptText)) continue;

    // Show the literal sitting inside it: a dead id holding a real-looking value is the
    // dangerous case, an empty one is usually just a hook someone removed.
    const after = src.slice(m.index);
    const inner = (after.match(/>([^<]{0,48})</) || [, ""])[1].trim();
    dead.push(`${page}: id="${id}"${inner ? `  holds ${JSON.stringify(inner)}` : "  (empty)"}`);
  }
}

if (checked === 0) {
  console.error("no ids found in web/*.html: this guard is checking nothing");
  process.exit(1);
}

console.log(`checked ${checked} ids across ${html.length} pages`);
if (dead.length) {
  console.error(`\n${dead.length} id(s) nothing addresses:`);
  for (const d of dead) console.error(`  - ${d}`);
  console.error(
    "\nEither wire it, or drop the id and leave the text as the static copy it is."
  );
  process.exit(1);
}
console.log("every id is addressed by a script or by the markup");
