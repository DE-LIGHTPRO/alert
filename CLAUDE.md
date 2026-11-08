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

### 6. Nullify on the MIME boundary, not the transaction reference.

Hash it, store it on-chain, reject a repeat. Rule 2 is the second layer, not the first.

This rule said "the bank's transaction reference" and
`docs/blueprint-spec.md` has said otherwise since the fixture was read: the 19-digit and
9-character references both sit inside the narration line, which Moniepoint rewrites, and
the 19-digit one is split across a quoted-printable soft line break. The boundary is in a
header, is unique per message, and is structural rather than editorial.

The stale wording leaked outward. `web/eml.js` told a user the "transaction reference"
was missing when the boundary was absent, which sends them to look at a reference their
alert does contain. The blueprint description on registry.zk.email says "one-time
transaction reference" too; that one cannot be corrected without editing the blueprint,
which may restart a compile, so it waits.

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

### 13. An id is a promise that something addresses the element.

`app.html` carried `<span id="net-chip">Base Sepolia</span>` and no script ever wrote to
it. `receipt.html` carried `Attested by: moniepoint.com, DKIM selector s1` the same way.
Both values are correct for the deployed site, which is exactly why they survived: a
hardcoded value under an unwired id is indistinguishable from a live one until the input
changes, and the documented `alert-config` override changes it.

- **The receipt is the worst place in this project for an unchecked claim.** Every other
  row degrades to an em dash until the chain answers. That one asserted a cryptographic
  fact unconditionally, on the artefact whose whole purpose is to be shown to a
  counterparty as evidence, while the deployment was wired to a stub verifier that checks
  nothing. Rule 46's defect, on the most outward-facing surface there is.
- **A tri-state is the fix, not a better default.** `verifierIsStub` returned `false` for
  a stub-free verifier, an unreachable RPC and any other throw. Its own comment
  acknowledged this and asked callers to treat a throw as unknown, which they could not
  do, because a throw and a real verifier arrived as the same value. It returns `null`
  now and establishes reachability from the two reads before the `IS_STUB` call.
- **A local chain that behaves unlike the deployed one is worse than no local chain.**
  `MockGroth16Verifier` accepted every proof and never declared `IS_STUB`, so the page
  reported a real attestation locally. Every UI check run against it measured the wrong
  thing. It declares the marker now, like `DeployDemo`'s `StubVerifier`.
- `scripts/check-dead-ids.mjs` fails on any id that no script and no markup reference
  addresses. Run in CI; verified it fails on a reintroduced unwired id, and on having
  nothing to check.
- Past tense asserts a particular trade proved something. The receipt's "What the proof
  revealed" is "reveals" now, which describes the mechanism and stays true beside a row
  saying nothing was checked.

### 14. The browser will serve you yesterday's module and say nothing.

A fix to `ui.js` appeared not to work. `performance.getEntriesByType("resource")` showed
`deliveryType: "cache"` and `transferSize: 0`: `python3 -m http.server` sends no
`Cache-Control`, so the browser cached the module heuristically and never revalidated.
The code was right and the page was running the previous version. Serve the dev tree with
`no-store` before concluding an edit did nothing, and check `transferSize` when a change
seems inert.

### 15. Drive the whole flow through the interface, or the interface is untested.

Every piece of the buyer path was correct and proven, and the path did not work. The
contract settles (script/LiveTrade.s.sol asserts it on chain), `settleEscrow()` is right,
the click handler is attached, the amount-matching logic renders the right verdict. The
buyer still could not settle, because `ui.js` never declared `emlText` and nothing ever
cleared `disabled` on the settle button.

- **An ES module is strict mode.** `emlText = await file.text()` on an undeclared name
  throws ReferenceError at runtime. `node --check` parses it happily, since the syntax is
  valid, and the CI parse step therefore cannot see it. The error landed in a console
  nobody had open and the upload silently did nothing.
- **A `disabled` attribute in markup is a decision nothing revisits.** Grep for the id and
  confirm something clears it. The match logic that should have gated it worked perfectly
  and was wired to nothing, which is rule 52 again, on the action that moves the money.
- **`export { x } from "./y.js"` does not bind x locally.** It forwards the name to
  importers. A module that also calls `x` itself needs `import` as well, and every probe
  that imports the module gets a working `x`, so the bug is invisible from outside.
- **Say why a control is dead.** An inviting label on an unpressable button reads as a
  broken product, not as a step still to take.
- **Name the real cause in a verdict.** Typing `45000.21` for `45,000.21` told the buyer
  the figure did not match and not to send anything until the seller gave them the right
  one, which accuses an honest seller over a missing comma.
- The three hardcoded "Base Sepolia" strings were all found this way too. Only driving
  the page against a chain that is not Base Sepolia makes them visible.

### 16. A transaction receipt is not a success.

Every write in `web/app.js` awaited `waitForTransactionReceipt` and returned it
unexamined. A receipt means mined, not succeeded: a reverted transaction produces one
too, with `status: "reverted"` and no logs.

Driving the refund path before its deadline, the escrow correctly refused, the
transaction was mined reverted, and the page reported **"Reclaimed."** with a transaction
hash while the USDC never moved and the escrow stayed Open. The same bug on the settle
path tells a buyer their money was released when nothing happened, which on this product
is the worst sentence it could print.

- **A wallet estimating gas is not the guarantee.** That is why this survived: estimation
  usually reverts first and the wallet warns. But state can change between estimating and
  mining, and a deadline expiring or a competing settle does exactly that.
- `confirmed()` is the only place allowed to await a receipt, and it throws on a
  non-success status. `scripts/check-receipt-status.mjs` enforces that in CI.
- **The guard needed two corrections before it could discriminate**, and both are the
  usual ones. It first counted the mention of the call inside its own explanatory comment
  and reported the file as violating itself, so comments are masked now (rule 63's
  lesson). Then its enclosing-function check matched only `async function`, so a call in
  `export async function settleEscrow` walked back past it to `confirmed()` and passed:
  the guard reported clean against the exact bug it exists to catch. Mutation-test a
  source guard by reintroducing the original defect, not a convenient stand-in.
- Related, found in the same run: both refund paths prepended their message to
  `#lookup-result` without removing the previous one, so a refusal and the success that
  followed it sat on screen together, and the stale line is the one a worried seller
  reads.

### 17. The theme toggle changed a preference and not one colour.

The light palette existed only inside `@media (prefers-color-scheme: light)`. So
`data-theme="light"` on a device whose OS is in dark mode matched nothing: the button
flipped the attribute, persisted the choice, and the page stayed dark. It did something
exactly when the OS had already done it, which is the one case where it was redundant.

- **A reload is the honest measurement.** Flipping the attribute by script and reading
  `getComputedStyle` can report a stale recalc, so a broken theme and a stale read look
  identical. The preference is persisted and applied pre-paint, so reloading settles it.
- A light theme needs the palette **twice**: once under the media query guarded by
  `:root:not([data-theme="dark"])`, once under `:root[data-theme="light"]`. CSS cannot
  express both in one rule. `scripts/check-theme-parity.mjs` fails when they differ,
  because two copies of one palette drift and a theme bug is invisible to anyone not
  using that theme.
- **Making light mode work exposed a palette nobody had ever rendered**: `--text-faint`
  measured 3.34 to 3.6 against light surfaces, under the 4.5 AA floor for body text. Dark
  was worse at 3.05 and that is the **default**, so it was what everyone saw. Both are
  fixed and measured at 0 failures across 32 text nodes per theme.
- **Two false positives first, both rule 48.** Compositing only `background-color` put
  white button text on a white page at ratio 1, because the button's background is a
  gradient; and the parser read `oklab(0.99 0.0004 -0.0012 / 0.82)` as an RGB triple and
  called the brand wordmark near-black on near-black. Elements whose background this
  cannot resolve are skipped and counted, not reported as failures.
- Touch targets: the `@media (pointer: coarse)` block sized `.btn` and `.btn-icon`, both
  class-based, so it never reached the footer's bare `<a>` links at 22px. `.nav-links` is
  `display: none` below 720px, so on a phone the footer is the only navigation there is.

### 18. A warning that hides itself when the chain is down is failing open.

The stub banner was shown with `if (isStub) show()`. An unreachable RPC made
`verifierIsStub` return a falsy "do not know", so the warning stayed hidden, and a hidden
warning reads as **"this deployment verifies proofs"**. The one claim this product rests
on defaulted to the reassuring answer exactly when the page could not check it.

It now distinguishes three outcomes and says which: a stub (red), a real verifier
(nothing), and *could not tell* (neutral, naming the uncertainty). Neutral rather than
red on purpose, per rule 46: nobody observed a stub, and an alarm would assert an outage
that was not measured either. All three verified on a local chain, the third by deploying
an escrow whose verifier has code but no `IS_STUB`.

The escrow list got this right already: "Could not read the escrow list. HTTP request
failed." names the fault instead of blaming the trade.

### 19. Content that scrolls without saying so is content nobody reads.

The measured-value blocks on `how.html` need about 421px and get 269px on a phone, with
`overflow-x: auto` and no affordance. A third of every line, including the figures that
page exists to prove, sat behind a scroll nobody was told about. Reachable and invisible
is the same as missing on an evidence page.

Fixed with CSS scroll shadows rather than a plain fade: two `local` gradients paint the
block's own background over each edge and scroll away with the content, revealing two
`scroll` gradients underneath only while there is more in that direction. No JavaScript,
and no affordance shown on a line that already fits.

### 20. The journey runs in CI now, and the harness needed mutating before it meant anything.

`test-e2e/journey.spec.mjs` drives the seller and buyer flows through the real interface
against a real anvil, with the contracts deployed by `script/DeployLocal.s.sol`. Eleven
tests, each pinned to a defect that shipped past a green `npm test`:
the undeclared `emlText`, the settle button nothing enabled, the unbound `fieldHash`
re-export, the unchecked receipt, the dead theme toggle, the stale Recent trades list.

- **`test-e2e/mutate.sh` puts each defect back and requires a named test to fail.** Its
  first run reported all seven as stale, and that verdict was wrong:
  `Path.write_text()` returns the character count, never `None`, so
  `old in s and p.write_text(...) is None` was always false. Every edit applied and every
  one was reported as a pattern that no longer matched. Separating **survived** from
  **stale** is what exposed it; with one undifferentiated "not caught" it would have read
  as a plausible story about drift.
- **Playwright emulates `prefers-color-scheme: light` by default.** The light-mode test
  compared light to light and could not fail. That default is also the exact
  configuration in which the original bug was invisible, so the test sets
  `colorScheme: "dark"` to reproduce the case that matters.
- **Playwright 1.49 hangs on Node 26**: its ESM loader deadlocks before any test runs,
  even on `--list`. CI pins Node 22, where it would have worked, so the version that
  passed in CI and the one that hung locally would have been the same. Pinned to 1.65.
- `npx playwright install` must run **after** `npm ci`. It fetches the build the
  installed library expects, and a mismatch fails every test at `browserType.launch`.
- `PW_CHANNEL=chrome` drives an installed Chrome when the 190MB download will not
  complete. An escape hatch for a local run, never CI: a pass against a different
  browser build is weaker evidence than a pass against the pinned one.
- The suite found one defect on its first complete run: expiry was computed from
  `Date.now()` while the contract compares `block.timestamp`, so a seller with a slow
  clock was denied their only exit.
- `fixtures/synthetic-moniepoint-debit.eml` is committed (the real alerts are gitignored
  and CI has never had one). It carries fake figures and a quoted-printable soft line
  break mid-attribute, which is the case `dewrap` exists for.

### 21. The .eml cannot be obtained on a phone, in a market that is only phones.

`app.html` tells the buyer: "In Gmail: open the alert, then Show original, then Download
original." **That menu does not exist in the Gmail mobile app.** Every other step of the
trade works on a 375px screen, which was measured and fixed; this one quietly assumes a
laptop, in a country where retail banking is apps and USSD.

- **Say it where the instruction is**, not only in a document. The hint now names the
  desktop requirement rather than letting someone discover it after locking USDC.
- **The fix is forwarding, and the direction matters.** Forwarding to a server that
  extracts and proves is smooth and one tap, and it puts the holder's name, account
  number and balance on somebody else's machine. That contradicts the line this project
  prints on the same screen: "Read in your browser. Never uploaded by this page." The
  version worth building forwards to the user themselves and extracts client-side.
- **This is also the strongest argument for zkTLS, and the strongest against it.** zkTLS
  (Reclaim and friends) would prove a transfer from the bank's own portal with no email
  at all, and works for banks that never send one, which includes OPay per rule 1. But
  it introduces a trusted attestor committee that can collude to forge a proof, where
  DKIM requires no new trusted party, and it asks a Nigerian trader to type bank
  credentials into a crypto app, which is indistinguishable from the fraud flow this
  product exists to prevent. Coverage against trust, and the pitch is built on trust.

### 22. A 200, a file on disk, and a valid Mach-O header, containing nothing.

`noirup` reported success. `~/.nargo/bin/nargo` existed at 44,750,720 bytes. `file`
called it a Mach-O 64-bit arm64 executable. Its segment table ended exactly at the file
length. Running it exited 137, and `strings` found **zero** occurrences of nargo's own
symbols. Three lines down in the install log:

    nargo: truncated gzip input
    tar: Error exit delayed from previous errors
    noirup: failed to download and unpack ... (HTTP status: 200)

Rule 45 at the toolchain layer. The connection dropped mid-stream, tar half-extracted
the partial archive, and every surface check passed.

- **The monitor I armed made it worse.** It tested for the file existing and announced
  "DONE: nargo installed". The check had to be *does nargo report a version*, which is
  the same presence-versus-function mistake this file already records twice.
- **I chased the wrong cause for several minutes.** Exit 137 with an unsigned arm64
  binary is a completely plausible Gatekeeper story, and `codesign` failing with
  "invalid or unsupported format" fits it too. It was fitting because there was nothing
  coherent to sign. Reading the install log first would have cost nothing.
- **The fix is resumable transfer, not retry.** `noirup` does a single-shot curl, so on
  a connection that drops every few minutes it restarts from zero forever and can never
  finish. `curl -C -` in a loop, with `gzip -t` as the completion test rather than file
  existence, gets there.

### 23. Check a circuit against the library version you pinned, not the branch you read.

`circuit/src/main.nr` was written from the example on zkemail.nr's `main`, while
`Nargo.toml` pins `tag = "v2.0.0"`. Reading the v2.0.0 source before compiling found
two breaks: `RSAPubkey::hash()` returns `[Field; 2]`, not one field, because a 2048-bit
key does not fit in a single BN254 element; and v2.0.0 ships `blinded_nullifier`, which
constrains its preimage to contain the signature, where the bare `pedersen_hash` the
example used constrains nothing and moves around in Noir's std between releases.

Both would have failed on first compile, which is cheap. The reason to look anyway is
that the toolchain took hours to arrive, so a first compile was an expensive thing to
spend on a type error.

### 24. The circuit runs. It took the right compiler and the right Barrett parameter.

`nargo execute` solves the witness for a real Moniepoint alert, on a laptop, with the
registry uninvolved. Three public outputs: the DKIM key hash as two fields, and a
nullifier. It is verified to discriminate, which a circuit that accepts anything would
not: the synthetic fixture fails with "Cannot satisfy constraint", and so does the real
alert with a **single bit** flipped in the signature.

Two things had to be right, and neither was guessable.

- **The compiler.** nargo 1.0.0 produced 158 errors inside zkemail.nr, all of them
  `verify_sha256_pkcs1v15` failing to resolve its generics. Not a tag problem: v2.0.0 and
  `main` fail identically, because the library pins `rsa v0.7.0` and `bignum v0.6.0`,
  which predate the stable release. Their CI says `toolchain: [1.0.0-beta.5]`. Read a
  project's CI for its pinned toolchain before installing the version the installer
  defaults to; it costs one fetch and I skipped it, then spent an hour downloading 28 MB
  of the wrong compiler on a connection that could barely carry it.
- **The Barrett parameter.** `redc = 2^(2 * MOD_BITS + 4) / modulus`. The first version
  used the limb-aligned width, `2^(2 * 18 * 120)`, which parses, produces a plausible
  18-limb array, and dies deep in noir-bignum with "Failed to solve brillig function"
  over a six-frame stack naming nothing recognisable. Nothing documents the formula. It
  came out of the library's own shipped `U2048` parameters: a 2049-bit modulus whose
  redc is exactly `2^4102 // modulus`. Derive a convention from the reference values
  rather than from the name of the operation.

And one of mine: every top-level key in `Prover.toml` must precede the first table
header, or TOML swallows it. `signature` written after `[pubkey]` became
`pubkey.signature`, and nargo reported the argument missing rather than misplaced.

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
