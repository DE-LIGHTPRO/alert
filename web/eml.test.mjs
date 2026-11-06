// Run: node web/eml.test.mjs
//
// Tests the .eml reader against the three REAL fixtures, because a preview that tells a
// user "this email is fine" when the circuit will reject it is worse than no preview.
//
// The fixtures are gitignored (they carry a real name, account number and balance), so
// this suite skips with a clear message rather than failing when they are absent.

import { readFileSync, existsSync } from "node:fs";
import { previewEml, missingFields, dewrap } from "./eml.js";

const FIXTURES = "../fixtures";
const base = new URL(FIXTURES + "/", import.meta.url).pathname;

let passed = 0;
let failed = 0;

function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? "  " + detail : ""}`);
  }
}

function load(f) {
  const p = base + f;
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

const debit = load("moniepoint-debit.eml");
const credit = load("moniepoint-credit.eml");
const credit2 = load("moniepoint-credit-2.eml");

if (!debit) {
  console.log("fixtures not present (they are gitignored); skipping");
  process.exit(0);
}

console.log("debit alert, the supported case");
{
  const f = previewEml(debit);
  check("recognised as a debit alert", f.isDebitAlert, `subject=${f.subject}`);
  check("amount extracted", f.amount === "5,000.00", `got ${f.amount}`);
  check("recipient extracted", f.recipient === "52988", `got ${f.recipient}`);
  check("boundary is 60 hex chars", /^[a-f0-9]{60}$/.test(f.boundary || ""), `got ${f.boundary}`);
  check("sender is Moniepoint", f.sender === "no-reply@moniepoint.com", `got ${f.sender}`);
  check("nothing reported missing", missingFields(f).length === 0, missingFields(f).join(","));
}

console.log("\ncredit alerts, which this blueprint does NOT support");
//
// THE DIRECTION GUARD IS THE RECIPIENT REGEX, NOT THE AMOUNT REGEX.
//
// While the amount was read from the plain-text copy it anchored on the literal
// "Debit Amount", so a credit alert could never match. Moving it to the HTML copy, to
// make the body cutoff possible, silently lost that: Moniepoint styles both alert types
// with the same template, so `margin-top: 7px;">580.00</span>` matches a credit alert
// perfectly.
//
// What actually keeps a credit alert out is `recipient`, because "*****52988/TRF" only
// appears in a debit narration. These assertions pin that, so if anyone ever drops the
// recipient binding as "redundant" this suite says what it was really doing.
for (const [name, text] of [["credit", credit], ["credit-2", credit2]]) {
  if (!text) continue;
  const f = previewEml(text);
  check(`${name}: not a debit alert`, !f.isDebitAlert, `subject=${f.subject}`);
  check(`${name}: amount DOES match, same HTML template`, f.amount !== null, `got ${f.amount}`);
  check(`${name}: recipient does NOT match, this is the guard`, f.recipient === null, `got ${f.recipient}`);
  check(`${name}: so it is rejected`, missingFields(f).includes("destination account"));
  // the boundary is in the header and present on every Moniepoint mail
  check(`${name}: boundary still found`, /^[a-f0-9]{60}$/.test(f.boundary || ""));
}

console.log("\nnullifier uniqueness across fixtures");
{
  const bs = [debit, credit, credit2].filter(Boolean).map((t) => previewEml(t).boundary);
  check("every boundary differs", new Set(bs).size === bs.length, bs.map((b) => b?.slice(0, 8)).join(" "));
}

console.log("\nsoft-linebreak handling");
{
  check("dewrap removes =CRLF", dewrap("abc=\r\ndef") === "abcdef");
  check("dewrap removes =LF", dewrap("abc=\ndef") === "abcdef");
  check("dewrap leaves a bare = alone", dewrap("a=3Db") === "a=3Db");
  // The 19-digit reference appears FOUR times. The plain-text copies are split by a
  // quoted-printable line wrap; the HTML copies happen to be whole, because the wrap
  // lands inside "OPay" instead. Which copies split depends on the beneficiary's name
  // length, so neither state is a property to rely on.
  const rawHits = (debit.match(/2071556804329459712/g) || []).length;
  const splitHits = (debit.match(/2071556=\r\n804329459712/g) || []).length;
  const dewrappedHits = (dewrap(debit).match(/2071556804329459712/g) || []).length;

  check("raw email contains BOTH split and whole copies", rawHits > 0 && splitHits > 0,
        `whole=${rawHits} split=${splitHits}`);
  check("dewrapping makes every copy whole", dewrappedHits === rawHits + splitHits,
        `${dewrappedHits} vs ${rawHits}+${splitHits}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
