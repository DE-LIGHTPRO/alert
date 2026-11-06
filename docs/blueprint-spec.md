# Blueprint spec: Moniepoint debit alert

Everything here is measured against `fixtures/moniepoint-debit.eml` and the two credit
fixtures, 6 Nov 2026. Nothing is assumed from documentation.

---

## 1. The hazard that governs every regex below

The circuit proves over the email **as signed**, which means the raw body, which is
**quoted-printable**. QP wraps every logical line at 76 characters with a soft break
`=\r\n`, and escapes `=` as `=3D`.

A regex written against the decoded text can match perfectly and fail in the circuit.

That is not hypothetical here. In the `text/plain` part, the debit narration is 87
characters once rejoined and wraps at 75:

```
TRANSFER TO <BENEFICIARY NAME, 25CH> OPay *****52988/TRF|2MPTc266g|2071556=
804329459712
```

The 19-digit transaction reference is **cut in half**. A naive `\|([0-9]{15,25})` finds
nothing.

**And the cut position is not stable.** It moves with the length of everything before it,
including the beneficiary's name. Measured on this fixture, with a 25-character name:

| field | offset in the line | status |
| --- | --- | --- |
| masked account `*****52988` | 43..53 | safe at this name length |
| 9-char ref `2MPTc266g` | 53..68 | safe at this name length |
| 19-digit ref | 67..87 | **split** |

A beneficiary name ~22 characters longer pushes the masked account across the cut. So
anything inside that narration line is conditionally safe, never safe.

**Rule: prefer a field that is alone on a short line, or in a header.** Headers are not
QP-encoded at all.

---

## 2. Field decisions

### Amount — safe

`5,000.00` sits alone on an 8-character line. A line shorter than 76 characters is never
wrapped, so this can never split.

```
Debit Amount\r\n\r\n5,000.00\r\n\r\nTransaction Details
```

Extract with `Debit Amount[\r\n]+([0-9,]+\.[0-9]{2})`. Keep the thousands separator: the
contract hashes the string exactly as printed and never parses it.

### Nullifier — the MIME boundary, and this is the good one

The obvious candidates (the 19-digit ref, the 9-char ref) are both inside the fragile
narration line. The boundary is not:

```
Content-Type: multipart/alternative; boundary="c4a88985eb621459bfd6e0ed92c07b50cd9740c8a043febb910f2688e979"
```

| property | measured |
| --- | --- |
| length | 60 hex characters, 240 bits |
| unique per email | yes, all three fixtures differ |
| in a **signed** header | yes, `content-type` appears in `h=` twice |
| QP-encoded | **no**, headers never are |
| can be split | no |

SendGrid generates it per message. It is exactly a per-email nonce that the bank happens
to sign, which is the same accident the whole product rests on.

### Recipient — conditionally safe, and say so

`*****52988`, the destination account as the alert masks it. Safe at this fixture's name
length and **not safe in general**, per the table above.

Keep the binding: without it a buyer could pay anyone the right amount and still claim.
But the prover must **fail loudly** when the regex misses rather than silently drop the
field, and the bot should say "beneficiary name too long for v1" rather than "proof
failed".

Making this unconditionally safe needs QP normalisation inside the circuit, which is a
known zkEmail pattern and not a three-day one.

### Bank domain — from the DKIM header

`d=moniepoint.com`, with `s=s1` pinned alongside it. See CLAUDE.md rule 5 for why the
selector matters and why pinning it still does not buy what you would expect.

---

## 3. Anchor placement — RESOLVED 6 Nov, and the first version of this section was wrong

**What actually happened.** Four submissions returned `HTTP 500 {"error":"Internal server
error"}` with no further detail. The config was valid every time. The cause was **circuit
size**, confirmed by the fact that cutting the body from 24,737 bytes to 6,973 made the
same blueprint compile immediately.

**The working configuration:**

| field | value |
| --- | --- |
| Email Body Cutoff Value | `00; font-size: 20px; line-height: 57px; ` (trailing space significant) |
| Max Email Body Length | `7680` |
| amount regex | `margin-top: 7px;">` · `[0-9,]+\.[0-9]{2}` · `</span>` |

That anchor is a fragment of a CSS style attribute, where `00;` is the tail of
`font-weight: 600;`. It is the **latest unique string in the body before the amount**, and
no semantic alternative exists: every readable candidate (`Narration`, `Transaction
Details`, `Debit Amount`) appears four times, and the registry needs a unique cutoff.
**If Moniepoint edits their email template's styling, every proof stops working.** That is
a real liability and belongs in the README, not buried here.

**Three corrections to what this section originally said:**

1. It claimed anchoring at the last `Debit Amount` gave a 3.3x saving. True of the string,
   false of our regex: the two late copies are HTML (`Debit Amount</span>`) and the
   original pattern required `\r\n\r\n`, so it only ever matched the two plain-text copies
   near the top. The amount regex had to be rewritten for the HTML copy before any cutoff
   could help.
2. Offsets must be computed on the body **after soft-linebreak removal**, because
   `remove_soft_linebreaks` is on. The raw-byte offsets are all slightly wrong.
3. The constraint estimates were the right ordering and useless as absolutes. What settled
   it was submitting and watching it compile, not arithmetic.

### Original analysis, kept because the method was right even where the numbers were not

zkEmail's sha precompute hashes the **prefix** outside the circuit and proves from the
selector to the **end** of the body. So the in-circuit cost is the **suffix**, and the
best anchor is the latest place all required fields still appear.

Moniepoint repeats every field four times: once in `text/plain`, and three times across
the HTML part.

| anchor | offset | suffix | SHA blocks | rough constraints |
| --- | --- | --- | --- | --- |
| 1st, `text/plain` | 277 | 25,105 | 393 | ~11.8M |
| 2nd | 3,011 | 22,371 | 350 | ~10.5M |
| 3rd | 9,639 | 15,743 | 246 | ~7.4M |
| **4th, last HTML** | **17,877** | **7,505** | **118** | **~3.5M** |

Anchoring at the last occurrence is free and cuts the circuit by roughly 3.3x.

The constraint figures assume ~30k per SHA block for circom, which is a rough published
number, not something measured here. Noir (`zkemail.nr` v2.0.0+) is materially more
efficient and may make even the first anchor viable. **Treat the table as ordering, not
as absolute cost**, and measure on first compile.

### What the late anchor costs in regex clarity

The HTML occurrence is messier. QP escapes `=` as `=3D`, and the fields sit inside tags:

```
line-height: 57px; margin-top: 7px;">5,000.00</span>
class=3D"value">TRANSFER TO <BENEFICIARY NAME, 25CH> OP=
ay *****52988/TRF|2MPTc266g|2071556804329459712</p>
```

Two things to note. The amount is still intact and still anchorable on `>` and `</span>`.
And the 19-digit reference **is intact here** while the bank name `OPay` is the thing that
splits, because the wrap lands in a different place in the HTML. Which is the same lesson
again: what splits depends on position, so depend on position as little as possible.

---

## 4. Blueprint form values

| field | value |
| --- | --- |
| Sender Domain | `moniepoint.com` |
| Test Email | `fixtures/moniepoint-debit.eml` |
| Max Email Header Length | `5696` (header block is 5,663 bytes, rounded to a multiple of 64) |
| Skip body hash check | **no** — the amount is in the body, so the body must be authenticated |
| shaPrecomputeSelector | the last `Debit Amount` occurrence, offset 17,877 |

Public signals, in the order `AlertProofAdapter` expects:

```
[0]  amountHash     hash of "5,000.00" as printed, commas and all
[1]  bankDomainHash hash of the DKIM d= value
[2]  nullifier      hash of the MIME boundary
[3]  recipientHash  hash of "*****52988" as the alert masks it
```

Order is part of the circuit's identity and nothing on chain can detect getting it wrong:
Groth16 attests that the prover knew a witness for these field elements, never what they
are called. Swapping two still verifies, and surfaces later as a user mistyping an amount.

---

## 5. Open, in priority order

1. **Compile and measure.** Every constraint figure above is an estimate.
2. **Decide circom vs Noir** on that measurement. Noir needs `zkemail.nr` v2.0.0+ for the
   Barrett reduction fix.
3. **One more debit fixture with a different beneficiary name**, to confirm the wrap
   analysis predicts where the split lands rather than merely describing this one email.
4. Self-hosted prover. The default flow uploads the email to zkEmail's server, which is
   fine for a demo and not for production. Say which was used.
