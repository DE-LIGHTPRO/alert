# Vibeathon 02 — application, cut to the real form

Closes: **Mon 2 Nov 2026, 22:00 UTC**. Build window 2–9 Nov. Judging + vote 9–16 Nov.

Rubric: Execution 30% · Launch potential 25% · Originality 20% · Craft & UX 15% ·
Vibecoding leverage 10%.

Fields as they actually appear on the form. Paste each block into the matching field.

---

## EMAIL *

Already filled: `delightpro234@gmail.com`

---

## BUILDER NAME / HANDLE

> Your call, not mine. `Delight` is what your git config uses. If you have a public
> handle you want credited and voted for, use that one instead — the community vote
> runs on recognition.

```
Delight
```

---

## WHAT DO YOU WANT TO BUILD? *

*("A few sentences on the project you'd build during the Vibeathon.")*

```
Alert — prove a bank transfer on-chain without showing anyone your bank statement.

Every peer-to-peer crypto trade in Nigeria settles on a screenshot of a bank app, which
takes about forty seconds to forge. A smart contract holds the crypto leg perfectly and
is completely blind to the naira leg, and that blindness is the whole of the risk.

But every bank alert email carries a DKIM signature, checkable against a public key the
bank publishes in DNS. So the bank is already an oracle: no integration, no API key, no
partnership, no licence, and no awareness that it is one. I checked before committing to
this. All seven major Nigerian banks and fintechs sign, and four publish DMARC p=reject.

Alert uses zkEmail so the proof reveals exactly four things (amount, bank domain,
nullifier, escrow code) and hides your name, account number and balance. It proves the
buyer's debit alert rather than the seller's credit alert, so the party who needs the
release is the party holding the evidence.

Live by 9 November: open an escrow from a Telegram group that already exists, lock USDC
on Base, send naira with the escrow code in the transfer narration, upload the .eml, and
the contract releases against the proof. Plus a public receipt page carrying no bank
detail at all.

Seven days buys one bank's circuit, so I will ship one and say which. And a debit alert
proves money was sent, not that it arrived — that is an honest limit, not a gap I am
hoping nobody checks.
```

---

## RELEVANT EXPERIENCE (OPTIONAL)

> CHECK THESE FACTS BEFORE PASTING. Written from what I know of your work; your identity
> is not mine to assert.

```
Solo builder from Nigeria. Four live products this year, all built with Claude Code:

sealed.finance — non-custodial settlement rail and aggregated DEX into Circle's Arc L1,
routing across 19 chains through 0x, 1inch and LI.FI.
pay.sealed.finance — standing-address payments on NEAR, with a Telegram bot.
inj·pad — bonding-curve launchpad on Injective EVM, Solidity contracts and front end.
near.pay — payments surface on NEAR.

I audit my own work hard. Those repos carry test suites that exist specifically to catch
the class of defect I already shipped once: a guard that fails if a price is labelled
with a venue that never served it, a guard that fails if a fee row prints raw base units
beside a ticker, a guard that fails if a config and its runbook name different hosts. I
care more about whether a claim on screen is true than about whether the screen looks
finished.
```

---

## PORTFOLIO / GITHUB / X (OPTIONAL)

One URL. `sealed.finance` is the strongest single artifact — live, non-trivial, and it
backs up the experience field. Use your GitHub instead if the repos are public and you
would rather judges read code.

```
https://sealed.finance
```

---

## BEST WAY TO REACH YOU  /  HANDLE (OPTIONAL)

`Email` is already selected and your address is filled. Leave it, or switch to X/Telegram
and add the handle if you check that faster during the build week.

---

## Notes for me, not for the form

- **Check the name.** "Alert" is the right word: in Nigeria it *is* the noun for a bank
  notification, and "did you get alert?" is the sentence this product replaces. But it is
  generic. Check the domain and run a quick trademark search; alert.ng or getalert.xyz as
  fallbacks.
- **One entry.** The vote is a whole scorecard (most-voted 100, no votes 10, averaged
  alongside the judges), so splitting supporters across entries lowers all of them.
- **Build-order risk.** The circuit is the long pole, not the contract or the bot. Get a
  real `.eml` from the target bank on day 1 and compile a blueprint against it before
  writing any UI. If the alert format resists header-only extraction, that is the day to
  find out, not day 5.
- **Header-only extraction, body hash check skipped.** The amount is usually in the
  subject line, which DKIM covers. Smaller circuit, faster proofs, and it sidesteps the
  `l=` body-truncation attack entirely. Refuse any signature carrying `l=`.
- **Pin the selector, not just the domain.** GTBank has six valid signing paths for
  `d=gtbank.com`, including a SendGrid subuser. Trusting `d=` alone extends the trust
  boundary to every marketing vendor the bank has ever used.
- **Compile against `zkemail.nr` v2.0.0+.** Earlier versions verified proofs forged with
  attacker-controlled Barrett reduction parameters.
- **Nullifier on the transaction reference**, or one alert settles two trades.
- Sponsored Claude Pro seats: 33 of 50 open, priority at 100K $VIBES or Starter Card L3.
  The email field says that is where the seat is sent.
