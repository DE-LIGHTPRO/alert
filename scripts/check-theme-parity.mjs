// The light palette is declared twice and the two copies must stay identical.
//
// Run: node scripts/check-theme-parity.mjs
//
// WHY THERE ARE TWO.
//
// A light theme has to answer two different questions: "your OS prefers light" and "you
// pressed the button". CSS cannot express both in one rule, because one is conditional
// on a media query and the other is not. So:
//
//   @media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { ... } }
//   :root[data-theme="light"] { ... }
//
// Only the first existed. `data-theme="light"` on a device whose OS is in dark mode
// matched nothing, so the toggle flipped the attribute, persisted the preference, and
// changed not one colour. It appeared to work, and did something exactly when the OS had
// already done it.
//
// Two copies of one palette is the mirrored-constant hazard: they drift, and a theme
// bug is invisible to whoever is not using that theme. This fails when they differ.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const CSS = join(resolve(import.meta.dirname, ".."), "web", "style.css");
const src = readFileSync(CSS, "utf8");

function declarations(block) {
  const out = new Map();
  for (const m of block.matchAll(/(--[a-z0-9-]+|color-scheme)\s*:\s*([^;]+);/gi)) {
    out.set(m[1].trim(), m[2].trim().replace(/\s+/g, " "));
  }
  return out;
}

const media = src.match(
  /@media \(prefers-color-scheme: light\) \{\s*:root:not\(\[data-theme="dark"\]\) \{([\s\S]*?)\n  \}\n\}/
);
const explicit = src.match(/\n:root\[data-theme="light"\] \{([\s\S]*?)\n\}/);

if (!media) {
  console.error("could not find the prefers-color-scheme: light palette");
  process.exit(1);
}
if (!explicit) {
  console.error(
    'could not find the :root[data-theme="light"] palette.\n' +
      "Without it the theme toggle changes nothing on a device whose OS is in dark mode."
  );
  process.exit(1);
}

const a = declarations(media[1]);
const b = declarations(explicit[1]);

if (a.size === 0 || b.size === 0) {
  console.error("one of the light palettes parsed as empty: this guard is checking nothing");
  process.exit(1);
}

const problems = [];
for (const [k, v] of a) {
  if (!b.has(k)) problems.push(`${k} is in the media-query palette but not the explicit one`);
  else if (b.get(k) !== v) problems.push(`${k}: media has ${v}, explicit has ${b.get(k)}`);
}
for (const k of b.keys()) {
  if (!a.has(k)) problems.push(`${k} is in the explicit palette but not the media-query one`);
}

console.log(`compared ${a.size} light-theme declarations`);
if (problems.length) {
  console.error(`\n${problems.length} difference(s) between the two light palettes:`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error("\nA value in one and not the other is a colour that changes with how light was chosen.");
  process.exit(1);
}
console.log("both light palettes declare the same values");
