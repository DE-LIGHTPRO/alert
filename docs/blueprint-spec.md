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

---

## 6. The public signal count, predicted before the verifier exists

`AlertProofAdapter` declares `uint256[4]` because four *fields* are extracted. That is
almost certainly wrong, and the arithmetic to fix it is knowable now rather than on the
morning the verifier appears.

A BN254 field element holds 31 bytes, so a public field of max length L packs into
`ceil(L / 31)` signals:

| field | max_length | signals |
| --- | --- | --- |
| `email_sender` | 64 | 3 |
| `amount` | 16 | 1 |
| `nullifier` | 64 | 3 |
| `recipient` | 8 | 1 |
| DKIM public key hash | | 1 |
| **predicted total** | | **9** |

**So expect `uint256[9]`, in three places:** the `IGroth16Verifier` interface, the
`IAlertVerifier` interface, and the `settle` signature in both `AlertEscrow` and
`web/app.js`.

**Check the generated verifier before changing anything.** This is a prediction from the
packing rule, not a measurement, and the registry may emit a timestamp or extra signal
this does not account for. The generated Solidity verifier states its own array size in
its `verifyProof` signature; read that and make these match it.

**Shrinking the maxLengths would shrink the signal count.** `nullifier` is set to 64 for
a boundary that is always exactly 60 hex characters, and `email_sender` to 64 for an
address that is 23. Tightening both to their real sizes would take the total from 9 to 5
and make the adapter's unpacking simpler. Worth doing if the blueprint is ever recompiled
for another reason; not worth a recompile on its own, given what one costs in time.

---

## 6b. Where the blueprint actually lives

`registry.zk.email/<uuid>`, not `registry.zk.email/<owner>/<slug>`. The slug path 404s,
which cost a detour spent assuming the registry was unreachable rather than that the URL
shape was wrong. The compile page states "will take few hours to complete" and shows
In Progress until it is done.

Observed there on 7 Nov 2026, version 1: the extracted fields are listed as
`email_sender`, `amount`, `nullifier`, `recipient`, in that order, which is the order
`AlertProofAdapter` predicts. Corroboration, not proof: the registry is showing the
blueprint's field list, not the circuit's public-signal ordering. The generated verifier
is still the authority, per section 6.

---

## 7. There may be no verifier address to wait for

Measured 7 Nov 2026 against `wellbird/zk_email_usecase_demo`, a blueprint whose
`serverStatus` is 3 (Done):

```
verifierContract   { chain: 84532 }      <- no address field, on a COMPILED blueprint
```

The `Blueprint` class exposes `getVkey()`, `getZKeyDownloadLink()`,
`getWasmFileDownloadLink()`, `getChunkedZkeyDownloadLinks()` and `verifyProofOnChain()`.
**There is no method that returns a deployed Groth16 verifier address.**

So the plan built around "wait for `VERIFIER_ADDRESS` to appear in the registry" is
probably wrong. The likelier flow is that the registry compiles and hands back artifacts,
and **deploying a verifier is our job**:

1. `blueprint.getVkey()` for the verification key
2. generate the Solidity verifier from it (`snarkjs zkey export solidityverifier`, or the
   equivalent from the vkey)
3. deploy it, exactly as `DeployDemo` deploys the stub today
4. pass its address to `Deploy.s.sol` as `VERIFIER_ADDRESS`, which already takes one

`Deploy.s.sol` needs no change: it was written to take an address from outside and refuse
one with no code at it. Only the source of that address changes.

**Two things still unknown, and worth checking before Monday rather than on it:**

- Whether `verifyProofOnChain()` calls a verifier the registry deploys per blueprint and
  simply does not surface in `verifierContract`. If it does, the address is discoverable
  and step 2 disappears.
- Whether generating the verifier needs the full zkey, which is large, on a connection
  measured at 9 to 15 seconds a request. If so it is the long pole, not the compile.

The honest position: the circuit finishing is necessary and may not be sufficient, and
that was worth knowing tonight rather than discovering it with hours left.
