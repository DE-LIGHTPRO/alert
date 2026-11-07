# CLAUDE.md — Alert

## What this is

**Alert** proves a Nigerian bank transfer happened, on-chain, without revealing the bank
statement. It is the escrow layer peer-to-peer crypto trading in Nigeria does not have.

Built for **Vibeathon 02** (Vibestarter). Entry submitted 2 Nov 2026. Build window
**2 to 9 November 2026**. Judging and community vote 9 to 16 November.

Rubric: Execution 30% · Launch potential 25% · Originality 20% · Craft & UX 15% ·
Vibecoding leverage 10%. The community vote counts as one whole scorecard in the average
(most-voted 100, no votes 10), so visibility between 9 and 16 Nov is worth about as much
as a judge.

Entry requirement agreed to on submission: **anything built with the sponsored Claude Pro
seat must be for this project.**

---

## The problem

A Nigerian P2P crypto trade has two legs. One is crypto, one is naira in a bank account.
A smart contract holds the crypto leg perfectly and is **completely blind to the naira
leg**. That blindness is the entire source of risk in the market.

The evidence exchanged today is a **screenshot of a bank app**, which takes about forty
seconds to forge. Every attempt to fix this has reached for a bank integration (needs a
licence, a partnership, months) or a human arbitrator (needs trust, does not scale). That
is why it is still unfixed.

---

## The mechanism

Every email a Nigerian bank sends carries a **DKIM signature**: RSA over the canonicalized
headers, checkable against a public key the bank publishes at
`<selector>._domainkey.<domain>` in DNS.

The property nobody designed and everybody can use:

> A DKIM signature is verifiable by anyone, forever, and the signer neither knows nor
> consents.

So **every bank is already an oracle**. No integration, no API key, no partnership, no
licence, no awareness. It cannot charge you, refuse you or cut you off, because the header
it would have to withdraw is the one it needs in order to deliver mail at all.

Alert uses **zkEmail** so the proof reveals exactly four things — amount, signing domain,
nullifier, escrow code — and hides the holder's name, account number, balance, the rest of
the email, and the fact that they hold any particular bank account at all.

---

## Rules

### 1. Prove the buyer's debit alert, not the seller's credit alert.

This is the decision the whole design rests on and it is easy to get backwards.

The naive version proves the seller's credit alert (*"₦150,000 credited to your
account"*). But the seller already received the naira and is the party who must now
release the crypto. **The party you need to compel is the one holding the evidence**, and
they can simply not produce it.

The buyer's **debit alert** (*"₦150,000 transferred to 0123456789"*) puts evidence and
incentive in the same hand. The buyer needs the release, so the buyer proves.

Accept **either**, whichever arrives first. Two independent banks, two independent
oracles, one fact, and only one of them has to cooperate.

**This is not a stalemate if nobody proves, it is a theft.** The deadline refunds the USDC
to the seller, who by then holds the naira too. That is precisely why the guarantee has to
rest on evidence the *buyer* holds.

**Which gives the product a hard constraint, measured 6 Nov 2026:**

> The buyer must pay from a bank that emails **debit** alerts.

Moniepoint emails both debit and credit alerts. **OPay emails neither**, confirmed by a
live ₦100 transfer OPay → Moniepoint: the credit alert arrived, no debit alert exists.

So "pay from anywhere" was never true. Say "pay from Moniepoint" on the slide rather than
let a judge find it. The traditional banks with `p=reject` in the table below have run
email alert services for years and are the natural queue: GTBank, Zenith, First Bank.

### 2. Bind every proof to its trade through the kobo, not the narration.

**This rule previously said the narration and that was wrong.** It assumed the buyer could
type an escrow code into the transfer and have it reach the email. Measured against three
real alerts on 6 Nov 2026, Moniepoint **overwrites the narration with its own template**:

    credit:  Transfer from <SENDER FULL NAME>
    debit:   TRANSFER TO <NAME> <BANK> *****52988/TRF|2MPTc266g|<19 digits>

Informative, and none of it is the user's text.

So **the amount is the tag**. The bot quotes ₦160,000.**37**, allocating the kobo per
escrow. The amount appears in every alert in both directions, and it asks nothing of the
user but typing the figure they were given.

Two consequences, both enforced in `AlertEscrow`:

- **Exact match, never `>=`.** Once the amount is the binding, a larger payment would
  satisfy a smaller escrow it was never meant for.
- **No two OPEN escrows may share an amount** (`amountClaimed`). Without that, one alert
  could settle either of two identical trades and the nullifier would not help: both
  would be first uses. The claim is released on settle and on refund, or the usable kobo
  space leaks one dead escrow at a time.

The debit narration is still worth extracting for the **nullifier**: that 19-digit field
is a per-transaction reference.

### 3. Read from the body. Header-only extraction does not work for Moniepoint.

**This rule previously said the opposite and it was wrong.** It assumed Nigerian bank
alerts put the amount in the subject line. Measured against a real Moniepoint alert on
6 Nov 2026, the entire subject is:

    Subject: Credit alert!

No amount, no reference, no narration. Everything is in the body. So the body hash check
**cannot** be skipped and the circuit is larger than planned.

The saving grace is rule 4: this signature carries **no `l=` tag**, so the whole body is
signed and reading from it is sound. We lose the small circuit, not the security.

**The body is ~25 KB** (5,352 bytes `text/plain` + 19,093 bytes `text/html`, which repeats
the same fields twice). That is far too large to hash naively in-circuit. Use zkEmail's
**partial body hashing** (`shaPrecomputeSelector`): precompute SHA-256 up to a selector
string just before the data and prove only the tail. Anchor on the `text/plain` part,
which comes first in the multipart and is a quarter of the size.

### 3b. The circuit sees the RAW body, which is quoted-printable.

Write every regex against the raw bytes, never against the decoded text. QP wraps at 76
characters with `=\r\n` and escapes `=` as `=3D`, so a field can be **cut in half** in the
middle of a digit run. Measured: the debit narration's 19-digit reference is split as
`2071556=\r\n804329459712`, and `\|([0-9]{15,25})` finds nothing.

**The cut position moves with the beneficiary's name**, so a field inside a long line is
conditionally safe, never safe. Prefer a field alone on a short line, or in a header,
since headers are not QP-encoded at all.

This is why the nullifier is the **MIME boundary** from the signed `Content-Type` header
rather than anything in the narration. 60 hex characters, distinct across all three
fixtures, in a header, so it can never split.

Full extraction spec with the measurements: `docs/blueprint-spec.md`.

### 3c. A tolerant parser hides the detail a strict consumer depends on.

Cost an hour on 6 Nov. The inspection script read the MIME boundary with

    boundary="?([^";]+)"?

quotes **optional**. It matched, printed the boundary, and everything looked settled. The
header actually reads

    Content-Type: multipart/alternative; boundary=c4a88985eb621459bfd6e0ed92c07b50...

with **no quotes at all**. The blueprint regex was then written requiring them, and failed
with "No matches found" against the very fixture the parser had just read happily.

The parser was tolerant because tolerance is sensible when reading. The circuit is strict
because strictness is the point. Nothing connected the two, so the tolerance silently
became a wrong assumption.

**Before handing a regex to the circuit, run it against the raw bytes and count the
matches.** Not against decoded text, not against a tolerant parser's output. Three of the
four field regexes were wrong on the first attempt and all three were caught this way in
seconds; the one that was not measured first cost an hour in the UI.

This is rule 48 from the Sealed codebase, in a new costume: establish the measurement is
sound before trusting what it tells you.

### 4. Refuse any DKIM signature carrying `l=`.

The optional `l=` tag says only the first N bytes of the body are signed. Anything after
that can be appended without breaking the signature. If you read the amount from the body
and the signature carries `l=`, you are forgeable. This is the strongest argument for
rule 3.

### 5. Pin the selector, not just the domain.

**GTBank has six valid signing paths for `d=gtbank.com`**: Microsoft 365 selectors, a
SendGrid subuser, and three of its own keys. A message signed by that SendGrid subuser is
DKIM-valid for gtbank.com, so anyone who compromises or rents that subuser can sign as the
bank.

The zkEmail blueprint form only exposes *Sender Domain*, but the selector lives in the
DKIM-Signature header, which is itself signed. **Extract `s=` as a constrained field** and
pin it. Trusting `d=` alone silently extends the trust boundary to every marketing vendor
the bank has ever used.

**For Moniepoint, pinning the selector is not enough, and this is worse than rule 5
originally assumed.** Measured 6 Nov 2026:

    s1._domainkey.moniepoint.com.  CNAME  s1.domainkey.u8065049.wl050.sendgrid.net.

Moniepoint's *own* selector is a **CNAME into SendGrid**. The private key is held by
SendGrid, not by Moniepoint. The alert also carries a second signature from
`d=sendgrid.info, s=smtpapi`, and the Return-Path is `...@em3749.moniepoint.com`, a
SendGrid subdomain.

So there is **no Moniepoint-controlled signing path** for this mail stream. The trust root
is Moniepoint's SendGrid subuser `u8065049`.

**State this accurately rather than hiding it.** It does not break the product: the threat
model is a trade counterparty forging evidence, and a counterparty cannot compromise
SendGrid's signing infrastructure. But the claim is "signed by Moniepoint's mail
provider", not "signed by Moniepoint", and a judge who checks DNS will find this in a
minute. Verify `d=moniepoint.com` **and** `s=s1` anyway: it excludes the `sendgrid.info`
signature and any other selector.

### 6. Nullify on the bank's transaction reference.

Hash it, store it on-chain, reject a repeat. Rule 2 is the second layer, not the first.

### 7. Archive the DKIM public key before it rotates.

Banks rotate keys and old emails become unverifiable unless the public key hash was
archived. zkEmail keeps a registry of key hashes per domain and a hash can be revoked if a
key is compromised. Prove promptly rather than months later.

### 8. Compile against `zkemail.nr` v2.0.0 or later.

Earlier versions verified proofs forged with attacker-controlled Barrett reduction
parameters. Regenerate any Noir proofs built before this.

### 9. The remote prover is for the demo only.

zkEmail's default flow proves on their server, which means uploading a bank alert to a
third party. **Unacceptable in production.** Self-hosted prover is a launch requirement,
and whichever was used must be stated plainly.

### 10. Never claim the proof establishes settlement.

A proven debit alert establishes that the buyer's bank says money **left** their account,
toward that account number, at that time, with that narration. It does **not** establish
arrival. Nigerian transfers over NIBSS are near instant, but transfers that debit and later
reverse do happen.

The honest claim: this replaces a forgeable screenshot with a bank-signed, unforgeable,
privacy-preserving attestation. That is a very large improvement over the status quo and it
is not proof of final settlement. The seller's credit-alert path closes that gap when they
cooperate.

Saying this plainly is worth more than overclaiming. It is the first thing a sharp judge
will probe.

---

### 11. The field hash exists in three languages, so a test inside one proves nothing.

The circuit, `contracts/src/AlertHash.sol` and `web/hash.js` each truncate a keccak256 to
248 bits for BN254. A disagreement between any two raises no error: `open` stores a hash
the proof can never produce, and a correct payment is refused at settlement, which reads
to the seller as the buyer having paid the wrong amount.

- **Vectors are generated by the JavaScript and asserted by the Solidity.**
  `scripts/gen-field-hash-vectors.mjs` imports `web/hash.js` itself, never a
  reimplementation, and `contracts/test/CrossLanguageHash.t.sol` asserts the result. CI
  regenerates and fails on a diff, so neither side drifts alone. Mutation-verified five
  ways, including a change that alters only the two non-ASCII vectors, which is why they
  are in the fixture.
- **The direction is the whole point.** `AlertHash.t.sol` pins five literals and said they
  came from `cast keccak` "and a browser" — but `cast keccak` is Foundry's keccak, the
  same implementation solc uses, so they only ever confirmed Solidity against itself, and
  the browser check left no artifact. The values turned out correct; the reason to believe
  them did not exist. They are now generated too, and kept as a hand-written second copy
  because a generated fixture would agree with a broken generator.
- **`script/Deploy.s.sol` had the same shape as a `require`:**
  `adapter.expectedBankDomainHash() == AlertHash.fromString(BANK_DOMAIN)`, asserted
  immediately after the constructor set it from that same constant. It could not fail and
  read as though it could. The reachable version of that mistake is a sender pinned to a
  different domain than the escrow gates on, so the adapter's constructor now enforces
  that the sender address ends at an at-sign boundary of the bank domain. Both halves stay
  internally consistent when they disagree, which is why nothing downstream catches it.
- `web/hash.js` is its own module because `app.js` cannot be imported outside a browser.
  Keeping the function alone, with one import and no side effects, is what lets the
  generator measure the code that ships.

### 12. A bare `vm.expectRevert()` cannot tell a guard from a panic.

Deleting the adapter's `sender.length <= suffix.length` check left the suite green: the
subtraction then underflowed and the test, which expected any revert, accepted the panic.
The mutation run caught it; the test could not. Expect the named error with its arguments.

## Measured: Nigerian bank DKIM posture

Checked before committing to the idea. All seven sign.

| Domain | DMARC | Signing paths |
| --- | --- | --- |
| gtbank.com | p=reject | M365 + SendGrid + own RSA key |
| zenithbank.com | p=reject | M365 + SendGrid |
| firstbanknigeria.com | p=reject | M365 + own RSA key |
| moniepoint.com | p=reject, **adkim=s** | Google + SendGrid |
| accessbankplc.com | quarantine | M365 + SendGrid |
| kuda.com | quarantine | Google + SendGrid |
| opay-inc.com | quarantine | own RSA key |

Four publish `p=reject`, so forged mail claiming to be from them is refused outright, which
is free help. **Moniepoint publishes `adkim=s`** (strict alignment), which is better still.

**Target: Moniepoint**, confirmed by fixture rather than by demographics. The original
reasoning ("young users who already trade crypto") was the wrong criterion. The right one
is **which bank actually emails an alert**, and Moniepoint does.

---

## Measured: the Moniepoint fixture

`fixtures/moniepoint-credit.eml`, a real credit alert, inspected 6 Nov 2026. Everything
below is read off that file, not assumed.

| | |
| --- | --- |
| Subject | `Credit alert!` — **no amount, no reference** |
| Signatures | 2: `d=moniepoint.com s=s1`, and `d=sendgrid.info s=smtpapi` |
| Algorithm | `rsa-sha256`, `c=relaxed/relaxed` |
| Key | **RSA 2048-bit**, which is what zkEmail's circuits expect |
| `l=` tag | **absent** — whole body signed, so body reads are sound |
| `h=` covers | content-type, date, from, mime-version, subject, to, cc, feedback-id |
| Header block | 5,663 bytes |
| Body | 5,352 B `text/plain` + 19,093 B `text/html` (fields repeated twice) |
| Google's verdict | `dkim=pass`, `spf=pass`, `dmarc=pass (p=REJECT sp=REJECT)` |

The `text/plain` part is clean and regular, which is what the regex will target:

```
Credit Amount
580.00
Transaction Details
Account Balance:
N <balance>
Account Number:
60xxxxxx83
Sender's Name:
from <SENDER FULL NAME>
Date & Time:
25 Jun, 2026 | 02:17:31 PM
Narration:
Transfer from <SENDER FULL NAME>
```

Note the amount (`580.00`) carries **no currency prefix**, so the regex must anchor on the
`Credit Amount` label rather than on a naira sign. The balance does carry `N `.

### The open question this fixture did not answer

**The narration here is auto-generated**: `Transfer from <SENDER NAME>`. That is
Moniepoint's own template, not text the payer typed. If that is always true, **rule 2's
escrow-code binding cannot work on the credit-alert side.**

One fixture cannot settle it. The transfer may simply have had no narration, and the
**debit** alert is a different template which we have never seen. Both are answered by one
test: send a small transfer with a deliberate narration and download the debit alert.

Until that is answered, treat rule 2 as unverified rather than designed.

---

## Scope for 9 November

In:
- **One bank.** Seven days buys one circuit. Ship one and say which.
- Header-only extraction, body hash check skipped.
- Escrow contract on **Base** (cheap, native USDC, Solidity verifier drops straight in).
- Telegram bot for the flow.
- One public receipt page, carrying no bank detail at all.

Explicitly out, and said aloud rather than hidden:
- Multi-bank
- Self-hosted prover
- Dispute arbitration
- Reversal handling

---

## Build order

**The circuit is the long pole, not the contract or the bot.**

1. Get a real `.eml` from the target bank. Gmail: *Show original → Download original*.
2. Compile a zkEmail blueprint against it **before writing any UI**. If the alert format
   resists header-only extraction, that is the day to find out, not day five.
3. Escrow contract + tests. No dependency on the circuit, so it can run in parallel.
4. Telegram bot.
5. Receipt page.

A non-bank DKIM-signed email works as a **pipeline fixture** for step 2: it proves the
SDK, prover and verifier work together before the bank email exists.

---

## The flow

```
1.  Buyer and seller agree a trade in a Telegram group that already exists.
2.  Bot opens an escrow. Seller locks USDC. Contract records the naira amount,
    the destination account number (hashed), and the escrow code.
3.  Buyer transfers naira, narration = escrow code.
4.  Buyer's bank emails a debit alert, DKIM-signed.
5.  Buyer exports the .eml.
6.  Prover generates a SNARK: signed by kuda.com, subject says NGN 150,000.00,
    narration is SLD-7F2A, destination matches.
7.  Contract verifies, checks the nullifier is unused, releases USDC.
8.  Public receipt page. No bank detail on it.
```

Nobody integrated with a bank. No arbitrator. No licence.

---

## Tooling

zkEmail Registry compiles the circuit and deploys the on-chain verifier. A blueprint is a
form: Sender Domain, Test Email Upload, Max Email Header Length (multiple of 64), Skip body
hash check, and Fields to Extract with Decomposed Regex Parts:

```json
[ { "isPublic": true, "regexDef": "[a-zA-Z0-9_]+" } ]
```

`isPublic` decides what the proof reveals. SDK exposes `blueprint.verifyProofOnChain(proof)`
and an off-chain `verifyProof`. `@zk-email/sdk` was at 2.0.11, last touched 1 Oct 2026.

---

## Practices carried over from Sealed

These are not negotiable here either. They are why the other four products work.

- **A claim on screen is measured or it is unknown.** Never a plausible number, never an
  invented provenance. A cost, a price, a status: measured, or stated as unknown.
- **A 200 is not a success.** Check the body's shape.
- **Before reporting a defect, establish the measurement is sound.** More than one
  "finding" here has been a broken probe.
- **Registration is not wiring.** `grep` for the symbol outside its own module before
  believing a thing is reachable.
- **No em dashes in anything a user reads.** Comments keep theirs.
- **Test the journey, not the pieces.** Correct pieces with broken wiring is the recurring
  failure mode.

---

## Naming

"Alert" is the word Nigerians already use for a bank notification. *"Did you get alert?"*
is the sentence this product replaces.

Generic, so the domain and a trademark check are open items. Fallbacks: `alert.ng`,
`getalert.xyz`.
