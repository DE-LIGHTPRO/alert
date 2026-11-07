# Alert

**Prove a Nigerian bank transfer on-chain, without showing anyone your bank statement.**

Built for Vibeathon 02.

---

## The problem

A Nigerian peer-to-peer crypto trade has two legs. One is crypto, one is naira sitting in
a bank account. A smart contract holds the crypto leg perfectly and is **completely blind
to the naira leg**.

That blindness is the entire source of risk in the market. Somebody has to go first, and
the evidence exchanged today is a **screenshot of a bank app**, which takes about forty
seconds to forge. "Fake alert" is Nigerian slang for a reason.

Every existing fix is custodial. Binance P2P held the crypto and exited naira services
after the 2024 crackdown. Noones and Paxful still hold your funds and can freeze them.
Telegram group admins take a cut and can simply run. The non-custodial version, where a
contract releases automatically, has never existed, because a contract cannot see a bank
account.

## The mechanism

Every email your bank sends carries a **DKIM signature**: RSA over the canonicalised
headers, checkable against a public key the bank publishes in DNS. It exists so Gmail can
filter spam.

> A DKIM signature is verifiable by anyone, forever, and the signer neither knows nor
> consents.

So **every bank is already an oracle**. No integration, no API key, no partnership, no
licence. It cannot charge you, refuse you or cut you off, because the header it would have
to withdraw is the one it needs in order to deliver mail at all.

Alert takes the buyer's bank alert, proves it in zero knowledge with
[zkEmail](https://registry.zk.email), and releases the escrow against that proof. The
proof reveals four things: the amount, the signing domain, a one-time nullifier, and the
masked destination account. It hides the account holder's name, their full account number,
their balance, the counterparty's name, and every other line of the email.

A real Moniepoint alert prints the account number **unmasked**, next to the balance.
Settling a ₦160,000 trade should not publish either.

## How a trade runs

```
1.  Seller locks USDC. Contract records the naira amount (hashed), the destination
    account (hashed) and a deadline.
2.  Buyer verifies the quoted figure against the on-chain hash BEFORE paying.
3.  Buyer transfers the exact naira figure, down to the kobo.
4.  Buyer's bank emails a debit alert, DKIM-signed.
5.  Buyer exports the .eml and generates a proof.
6.  Contract verifies, spends the nullifier, releases USDC to the buyer.
7.  If no proof arrives by the deadline, the seller reclaims.
```

No bank was integrated with. No arbitrator. No licence. No admin key.

---

## Design decisions worth reading

### The buyer proves, not the seller

The seller locks USDC, the buyer sends naira, and the proof releases **to the buyer**. So
the buyer wants to prove and the seller does not: if nobody proves, the deadline refunds
the seller, who by then holds the naira too. That is not a stalemate, it is a theft.

It follows that the evidence must be the buyer's own **debit** alert, and therefore that
the buyer must bank somewhere that emails debit alerts. Measured 6 Nov 2026: **Moniepoint
does. OPay does not.**

### The amount is the binding, not a reference code

The first design had the buyer type a per-trade code into the transfer narration.
Measured against three real alerts, Moniepoint **overwrites the narration with its own
template** and the user's text does not survive:

```
credit:  Transfer from <SENDER FULL NAME>
debit:   TRANSFER TO <NAME> <BANK> *****52988/TRF|2MPTc266g|<19 digits>
```

So the amount itself carries the tag. The bot quotes ₦160,000.**37**, allocating the kobo
per escrow, and the contract refuses two open escrows that share an amount. The amount
appears in every alert, in both directions, and asks nothing of the user but typing the
figure they were given.

### The nullifier is a MIME boundary

The obvious candidates all sit inside the narration line, which quoted-printable wraps at
76 characters, splitting fields at a position that moves with the beneficiary's name. The
Content-Type boundary does not:

```
boundary=c4a88985eb621459bfd6e0ed92c07b50cd9740c8a043febb910f2688e979
```

60 hex characters, distinct on every message, inside a **signed** header, and headers are
never quoted-printable encoded. SendGrid generates it per email. It is a per-message nonce
that the bank happens to sign, which is the same accident the whole product rests on.

---

## What this does NOT prove

Stated plainly because it is the first thing worth checking.

A proven debit alert establishes that the buyer's **bank says** money left their account,
toward that destination, at that time. It does **not** establish arrival. Nigerian
transfers over NIBSS are near instant, but transfers that debit and later reverse happen.

This replaces a forgeable screenshot with a bank-signed, unforgeable, privacy-preserving
attestation. That is a large improvement over the status quo. It is not a claim of final
settlement.

## Known limits

- **One bank.** Each bank's alert format needs its own circuit. Moniepoint today; GTBank,
  Zenith and First Bank are the queue, all `p=reject` with long-running email alerts.
- **The trust root is SendGrid, not Moniepoint.** `s1._domainkey.moniepoint.com` is a
  CNAME into SendGrid, so the honest claim is "signed by Moniepoint's mail provider". A
  trade counterparty cannot compromise that, which is the threat model that matters, but
  the sentence should be accurate.
- **The body cutoff is brittle.** To fit the circuit, the amount is extracted from the
  HTML copy anchored on a CSS fragment. If Moniepoint restyles their email, proofs stop.
- **The remote prover sees your email.** Fine for a demo, unacceptable in production.
  Self-hosting is a launch requirement.
- **Email alerts must be switched on**, and many Nigerians receive SMS only. SMS cannot be
  signed.

---

## Repository

```
contracts/     Foundry. AlertEscrow, AlertProofAdapter, AlertHash, AlertPack.
  script/mutate.py    breaks each guard in turn, asserts a named test catches it
web/           Static. No build step: viem loads from esm.sh as plain ESM.
  hash.js             the 248-bit field hash, shared with the contract
  eml.test.mjs        the .eml reader, against real fixtures
scripts/       gen-field-hash-vectors.mjs: cross-language hash vectors, from web/hash.js
docs/          blueprint-spec.md: every regex, measured against the raw bytes
fixtures/      real bank alerts, gitignored, they carry a name and account number
  field-hash-vectors.json   generated, committed, asserted by the Solidity suite
```

package.json exists for tooling only. Its single devDependency, viem, is what lets CI run
the page's own hash function outside a browser. Nothing in it is shipped: the page still
loads viem from a CDN and has no build step.

### Tests

```bash
cd contracts && forge test            # 50 tests
cd contracts && python3 -I script/mutate.py   # 19 mutations, all caught
node web/eml.test.mjs                 # 22 assertions against real fixtures
npm ci && node scripts/gen-field-hash-vectors.mjs   # regenerate the hash vectors
```

The mutation run is the one worth looking at. It breaks each guard individually and
asserts a specific test fails. It found a real bug: `open` accepted an unvalidated bank
domain, so a seller could lock USDC against a bank this deployment can never prove and
have no way out before the deadline. It has since found three more: an adapter guard on
the extracted recipient that no test exercised, a test of its own that could not tell the
named revert from an arithmetic panic, and the absence of any check across the two
languages below.

### The hash is computed in three languages

The circuit, `AlertHash.sol` and `web/hash.js` each truncate a keccak256 to 248 bits so it
fits a BN254 field element. A disagreement between any two raises no error anywhere: the
escrow stores a hash the proof can never produce, and a correct payment is refused at
settlement, which reads to the seller as the buyer having paid the wrong amount.

Every test used to live inside one language. `fixtures/field-hash-vectors.json` is
generated from `web/hash.js` and asserted by `contracts/test/CrossLanguageHash.t.sol`, so
the Solidity suite fails if the two drift; CI regenerates the file and fails on a diff, so
JavaScript cannot drift alone either. The direction matters. Generating the vectors with
Solidity and asserting them in Solidity is a tautology, which is what `script/Deploy.s.sol`
used to do with the bank domain: a line that read as a safety check and could not fail.
All twenty vectors were also confirmed against the running page in a browser.

---

## Built with Claude Code

Every line. The interesting part was not the writing, it was the measuring: three of four
field regexes were wrong on first attempt, and the two that were tested against the raw
email bytes were fixed in seconds while the one that was not cost an hour.
