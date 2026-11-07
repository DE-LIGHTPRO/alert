// DOM wiring. All chain logic lives in app.js, .eml parsing in eml.js; this file only
// reads inputs, calls them, and renders what came back.

import {
  CONFIG,
  makePublicClient,
  connect,
  openEscrow,
  readEscrow,
  refundEscrow,
  verifierIsStub,
  settleEscrow,
  allocateKobo,
  formatNaira,
  fieldHash,
  chain,
} from "./app.js";
import { previewEml, missingFields } from "./eml.js";

const $ = (id) => document.getElementById(id);
const publicClient = makePublicClient();

let wallet = null; // { walletClient, account }

// Never declared. An ES module is strict mode, so `emlText = await file.text()` threw
// ReferenceError on the first line of the upload handler, before emlFields was set and
// before the preview rendered. The .eml upload had therefore never worked: choosing a
// file did nothing visible and the console error went to a console nobody had open.
//
// Nothing could catch it. `node --check` parses the file and an undeclared assignment is
// valid syntax; the failure is at runtime, in a handler no test reaches because it needs
// a file picker and a real alert.
let emlText = null;
let emlFields = null;
let lastLookup = null; // { id, escrow }
let buyerEscrow = null; // { id, escrow } for the "prove you paid" card

const deployed = Boolean(CONFIG.escrow);

// --------------------------------------------------------------- the settle gate
//
// "Generate proof and settle" carried `disabled` in app.html and NOTHING ever cleared
// it. Not on connect, not on reading the alert, not on loading the escrow. The buyer
// could lock, verify the figure, upload the right alert, see "Matches escrow #1", and
// then face a dead button with no explanation. The entire release path was unreachable
// from the interface, while the contract, settleEscrow() and the click handler were all
// correct and individually proven.
//
// Registration is not wiring, and an inviting label on a button that cannot be pressed
// is worse than no button: it reads as the app being broken rather than as a step the
// user still has to take. So this computes the blockers and names them.
function settleBlockers() {
  const why = [];
  if (!deployed) why.push("the contracts are not deployed here");
  if (!wallet) why.push("connect your wallet");
  if (!buyerEscrow) why.push("enter the escrow number above");
  else if (buyerEscrow.escrow.statusCode !== 1) why.push(`escrow #${buyerEscrow.id} is ${buyerEscrow.escrow.status.toLowerCase()}, not open`);
  if (!emlFields) why.push("choose the .eml of your bank alert");
  else {
    const missing = missingFields(emlFields);
    if (missing.length) why.push(`the alert is missing ${missing.join(", ")}`);
    else if (
      buyerEscrow &&
      fieldHash(emlFields.amount).toLowerCase() !== buyerEscrow.escrow.amountHash.toLowerCase()
    ) {
      why.push(`this alert settles a different trade, not escrow #${buyerEscrow.id}`);
    }
  }
  return why;
}

function updateSettleGate() {
  const btn = $("settle");
  const gate = $("settle-gate");
  if (!btn) return;
  const why = settleBlockers();
  btn.disabled = why.length > 0;
  if (gate) gate.textContent = why.length ? `Before you can settle: ${why.join("; ")}.` : "";
}

// The network chip named Base Sepolia as a literal in app.html, and nothing ever wrote
// to it despite it carrying an id. On the deployed site that label is true, which is
// what makes it dangerous: point the shipped page at another chain with the documented
// localStorage override and it still says Base Sepolia, so a screenshot taken against a
// local anvil misreports which chain it is. The chain object already knows its own name.
// Naming a network the page is not on is the same defect as naming a venue a price did
// not come from.
{
  const chip = $("net-chip");
  if (chip) chip.textContent = chain.name;
  // The stub banner named Base Sepolia in static prose, so it contradicted the chip
  // whenever the page was pointed elsewhere. Third instance of the same defect, and the
  // one the id guard could not see, because prose carries no id.
  const stubChain = $("stub-chain");
  if (stubChain) stubChain.textContent = chain.name;
}

// --------------------------------------------------------------- helpers

const note = (kind, html) => `<div class="note ${kind}">${html}</div>`;
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const txLink = (h) =>
  `<a href="${CONFIG.explorer}/tx/${h}" target="_blank" rel="noopener">${short(h)}</a>`;

/// Shows a button as working, and always puts it back. A button left spinning after a
/// revert is how a user ends up signing the same thing twice.
async function working(btn, label, fn) {
  const was = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    return await fn();
  } finally {
    btn.textContent = was;
    btn.disabled = false;
  }
}

function errText(err) {
  return err?.shortMessage || err?.message || String(err);
}

// --------------------------------------------------------------- theme

$("theme").addEventListener("click", () => {
  const root = document.documentElement;
  const current =
    root.dataset.theme ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = current === "dark" ? "light" : "dark";
  root.dataset.theme = next;
  try {
    localStorage.setItem("alert-theme", next);
  } catch (e) {
    // A private window must not lose the toggle, only the memory of it.
  }
});

// --------------------------------------------------------------- rendering

function renderFigure(text) {
  return `
    <div class="figure">
      <div>
        <div class="cap">Transfer exactly</div>
        <div class="amt">&#8358;${text}</div>
      </div>
      <button class="sm" data-copy="${text}">Copy</button>
    </div>`;
}

function renderEscrow(id, e) {
  const deadline = new Date(e.deadline * 1000);
  const expired = Date.now() / 1000 > e.deadline;
  return `
    <dl class="rows">
      <div class="row"><dt>Escrow</dt><dd class="mono">#${id}</dd></div>
      <div class="row"><dt>Status</dt><dd><span class="pill ${e.status.toLowerCase()}">${e.status}</span></dd></div>
      <div class="row"><dt>Locked</dt><dd><span class="mono">${e.usdcText}</span> USDC</dd></div>
      <div class="row"><dt>Seller</dt><dd class="hash">${e.seller}</dd></div>
      <div class="row"><dt>Buyer</dt><dd class="hash">${e.buyer}</dd></div>
      <div class="row"><dt>Deadline</dt><dd>${deadline.toLocaleString()}${expired ? " <span style='color:var(--warn)'>(passed)</span>" : ""}</dd></div>
      <div class="row"><dt>Amount hash</dt><dd class="hash">${e.amountHash}</dd></div>
    </dl>
    <p class="hint">
      The naira figure is not stored on chain, only its hash. The two parties know the
      number; nobody else learns it from here.
    </p>`;
}

// Copy buttons are created inside innerHTML, so the listener is delegated rather than
// bound per render, which would leak one listener per lookup.
document.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-copy]");
  if (!btn) return;
  try {
    await navigator.clipboard.writeText(btn.dataset.copy);
    const was = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = was), 1400);
  } catch (e) {
    btn.textContent = "Press to select";
  }
});

// --------------------------------------------------------------- startup

if (!deployed) $("not-deployed").hidden = false;

// Ask the chain whether the verifier checks anything, and say so if it does not. This
// runs on load and is never suppressed by a config value, so the warning cannot drift
// out of step with what is actually deployed.
if (deployed) {
  verifierIsStub(publicClient)
    .then((isStub) => { if (isStub) $("stub-warning").hidden = false; })
    .catch(() => {});
}
if (deployed) $("lookup").disabled = false; // reads need no wallet

// --------------------------------------------------------------- connect

$("connect").addEventListener("click", async () => {
  try {
    await working($("connect"), "Connecting…", async () => {
      wallet = await connect();
      updateSettleGate();
    });
    $("connect").textContent = short(wallet.account);
    $("connect").classList.remove("primary");
    if (deployed) $("open").disabled = false;
  } catch (err) {
    $("open-result").innerHTML = note("bad", errText(err));
  }
});

// A wallet that silently changes account or chain under a connected UI is how someone
// signs from an address they did not mean to. Reload rather than guess at a merge.
if (window.ethereum?.on) {
  window.ethereum.on("accountsChanged", () => location.reload());
  window.ethereum.on("chainChanged", () => location.reload());
}

// --------------------------------------------------------------- open escrow

$("open").addEventListener("click", async () => {
  const out = $("open-result");
  const buyer = $("buyer").value.trim();
  const usdc = Number($("usdc").value);
  const whole = Number($("naira").value);
  const recipient = $("recipient").value.trim();
  const hours = Number($("hours").value);

  if (!/^0x[0-9a-fA-F]{40}$/.test(buyer)) return (out.innerHTML = note("bad", "That is not a wallet address."));
  if (!(usdc > 0)) return (out.innerHTML = note("bad", "Enter the USDC amount to lock."));
  if (!(whole > 0)) return (out.innerHTML = note("bad", "Enter the naira amount you expect."));
  if (!/^[0-9]{5}$/.test(recipient)) return (out.innerHTML = note("bad", "The masked account is exactly five digits."));
  if (!wallet) return (out.innerHTML = note("bad", "Connect a wallet first."));

  try {
    await working($("open"), "Locking…", async () => {
      out.innerHTML = note("", "Finding a kobo value no open trade is using…");
      const { text } = await allocateKobo(publicClient, whole);

      out.innerHTML =
        renderFigure(text) +
        note("", "Approving USDC and locking. Two signatures if this is your first trade.");

      const { receipt, escrowId } = await openEscrow(
        wallet.walletClient,
        wallet.account,
        publicClient,
        { buyer, usdc, nairaAmountText: text, recipientMasked: `*****${recipient}`, hours }
      );

      // The buyer's card asks for an escrow number, and this was the only place it could
      // have come from. The seller was given a transaction hash and told to "send the
      // buyer that exact figure", with no way to say which trade it belonged to.
      const idLine =
        escrowId === null
          ? `<br>The escrow number could not be read from the receipt. Find this trade
             under Recent trades before quoting it.`
          : `<br>This is <strong>escrow #${escrowId}</strong>. The buyer needs that
             number and the figure above.`;

      out.innerHTML =
        renderFigure(text) +
        note(
          "good",
          `<strong>Locked.</strong> Send the buyer that exact figure and your account
           ending ${recipient}. They prove it here and the USDC releases to them
           automatically.${idLine}<br>Transaction ${txLink(receipt.transactionHash)}`
        );

      // The list is read from the chain once, at page load. Without this it still says
      // "No trades yet" directly under a trade that was just locked.
      renderRecent();
    });
  } catch (err) {
    out.innerHTML = note("bad", errText(err));
  }
});

// --------------------------------------------------------------- buyer: escrow summary

async function loadBuyerEscrow() {
  const out = $("escrow-summary");
  const id = $("escrow-id").value;
  buyerEscrow = null;
  updateSettleGate();
  if (id === "" || !deployed) return (out.innerHTML = "");
  try {
    const e = await readEscrow(publicClient, id);
    if (e.statusCode === 0) return (out.innerHTML = note("bad", "No escrow with that number."));
    buyerEscrow = { id, escrow: e };
    updateSettleGate();
    const expired = Date.now() / 1000 > e.deadline;
    out.innerHTML = note(
      e.statusCode === 1 && !expired ? "good" : "warn",
      `<strong>${e.usdcText} USDC</strong> locked by ${short(e.seller)} for ${short(e.buyer)}.
       Status ${e.status}${expired ? ", deadline passed" : ""}.`
    );
    checkAmount();
  } catch (err) {
    out.innerHTML = note("bad", errText(err));
  }
}
$("escrow-id").addEventListener("change", loadBuyerEscrow);

// --------------------------------------------------------------- buyer: verify the figure

// The seller tells the buyer a number out of band. Nothing stops a seller quoting one
// figure and opening the escrow with another, which would leave the buyer unable to
// settle after they had already sent the money. The hash is on chain, so the buyer can
// check the quote against it BEFORE paying. This is the cheapest fraud to prevent and it
// costs one comparison.
function checkAmount() {
  const out = $("check-result");
  const raw = $("check-naira").value.trim();
  if (!raw) return (out.innerHTML = "");
  if (!buyerEscrow) return (out.innerHTML = note("", "Enter the escrow number first."));

  if (!/^[0-9][0-9,]*\.[0-9]{2}$/.test(raw)) {
    out.innerHTML = note("", `Type it exactly as the alert will print it, commas and all: <span class="mono">160,000.37</span>`);
    return;
  }
  const stored = buyerEscrow.escrow.amountHash.toLowerCase();
  if (fieldHash(raw).toLowerCase() === stored) {
    out.innerHTML = `<div class="match yes"><span>&#10003;</span><span>That figure matches escrow #${buyerEscrow.id}. Safe to transfer it.</span></div>`;
    return;
  }

  // The same number punctuated differently is a different string and so a different
  // hash. "45000.21" and "45,000.21" are the same amount of money, and the first one
  // used to produce "does not match ... until the seller gives you the right one",
  // which accuses an honest seller of quoting a wrong figure when the buyer simply
  // dropped the commas. Name the actual cause: the binding is the exact text the alert
  // prints, so a reformatting is a real mismatch, just not that one.
  const [whole, kobo] = raw.replace(/,/g, "").split(".");
  if (/^[0-9]+$/.test(whole)) {
    const regrouped = formatNaira(whole, kobo);
    if (fieldHash(regrouped).toLowerCase() === stored) {
      out.innerHTML = `<div class="match no"><span>&#10007;</span><span>Right amount, wrong punctuation.
        This trade is bound to <span class="mono">${regrouped}</span>, exactly as the alert prints it.
        The seller quoted you correctly.</span></div>`;
      return;
    }
  }

  // Everything after the glyph is one element on purpose. `.match` is inline-flex, so
  // each child becomes a flex item with a 6px gap: a bare <strong> or <span class="mono">
  // in the message was blockified onto its own line, stranding the punctuation after it.
  out.innerHTML = `<div class="match no"><span>&#10007;</span><span>That figure does <strong>not</strong> match escrow #${buyerEscrow.id}. Do not send anything until the seller gives you the right one.</span></div>`;
}
$("check-naira").addEventListener("input", checkAmount);

// --------------------------------------------------------------- .eml preview

$("eml").addEventListener("change", async (ev) => {
  const file = ev.target.files?.[0];
  const out = $("eml-preview");
  if (!file) return (out.innerHTML = "");
  $("eml-name").textContent = file.name;

  // Kept so the settle handler can prove against the exact bytes the user chose, rather
  // than re-reading the file later and risking a different one.
  emlText = await file.text();
  emlFields = previewEml(emlText);
  queueMicrotask(updateSettleGate);
  const miss = missingFields(emlFields);

  if (miss.length) {
    out.innerHTML = note(
      "bad",
      `This email is missing: <strong>${miss.join(", ")}</strong>.
       ${emlFields.subject ? `Its subject is "${emlFields.subject}". ` : ""}
       Only Moniepoint <strong>debit</strong> alerts work today. A credit alert looks
       almost identical and cannot be used: it proves money arrived somewhere, not that
       you sent it.`
    );
    return;
  }

  const agrees =
    buyerEscrow && fieldHash(emlFields.amount).toLowerCase() === buyerEscrow.escrow.amountHash.toLowerCase();

  out.innerHTML = note(
    "good",
    `<strong>Read in your browser. Nothing was uploaded.</strong><br>
     Amount <span class="mono">&#8358;${emlFields.amount}</span>, to an account ending
     <span class="mono">${emlFields.recipient}</span>.
     ${buyerEscrow ? (agrees
        ? `<br><span style="color:var(--accent)">&#10003; Matches escrow #${buyerEscrow.id}.</span>`
        : `<br><span style="color:var(--danger)">&#10007; Does not match escrow #${buyerEscrow.id}. This alert settles a different trade.</span>`) : ""}
     <br><span class="hint">The proof will reveal exactly these plus a one-time reference.
     Your name, full account number and balance stay inside it.</span>`
  );
});

// --------------------------------------------------------------- settle

$("settle").addEventListener("click", async () => {
  const out = $("settle-result");
  const id = $("escrow-id").value;

  if (!emlText) return (out.innerHTML = note("bad", "Choose your bank alert file first."));
  if (id === "") return (out.innerHTML = note("bad", "Enter the escrow number."));
  if (!wallet) return (out.innerHTML = note("bad", "Connect a wallet first."));

  const progress = (msg) => (out.innerHTML = note("", msg));

  try {
    await working($("settle"), "Proving…", async () => {
      // Lazily imported: the SDK is several megabytes of wasm and must not be on the
      // first-paint path, least of all on the connections this product exists for.
      const { generateProof, toSettleArgs } = await import("./prover.js");

      const { callData } = await generateProof(emlText, { local: false, onProgress: progress });
      const args = toSettleArgs(callData);

      progress("Proof generated. Submitting it…");
      const r = await settleEscrow(wallet.walletClient, wallet.account, publicClient, id, args);

      const q = new URLSearchParams({ id });
      out.innerHTML = note(
        "good",
        `<strong>Settled.</strong> The USDC has been released to the buyer.<br>
         Transaction ${txLink(r.transactionHash)} &nbsp;·&nbsp;
         <a href="./receipt.html?${q}">Open the receipt</a>`
      );
    });
  } catch (err) {
    out.innerHTML = note("bad", errText(err));
  }
});

// --------------------------------------------------------------- lookup

$("lookup").addEventListener("click", async () => {
  const out = $("lookup-result");
  const id = $("lookup-id").value;
  $("refund").hidden = true;
  $("receipt-link").hidden = true;
  if (id === "") return (out.innerHTML = `<p class="empty">Enter an escrow number.</p>`);

  try {
    await working($("lookup"), "Reading…", async () => {
      const e = await readEscrow(publicClient, id);
      if (e.statusCode === 0) {
        out.innerHTML = `<p class="empty">No escrow with that number.</p>`;
        return;
      }
      lastLookup = { id, escrow: e };
      out.innerHTML = renderEscrow(id, e);

      // Reclaim is the seller's only other exit, and it was unreachable from this page
      // until now: the contract had it, app.js exported it, and nothing called it.
      const expired = Date.now() / 1000 > e.deadline;
      const isSeller = wallet && wallet.account.toLowerCase() === e.seller.toLowerCase();
      $("refund").hidden = !(e.statusCode === 1 && expired && isSeller);

      if (e.statusCode === 2) {
        const q = new URLSearchParams({ id, usdc: e.usdcText, buyer: e.buyer });
        $("receipt-link").href = `./receipt.html?${q}`;
        $("receipt-link").hidden = false;
      }
    });
  } catch (err) {
    out.innerHTML = note("bad", errText(err));
  }
});

$("refund").addEventListener("click", async () => {
  if (!lastLookup || !wallet) return;
  try {
    await working($("refund"), "Reclaiming…", async () => {
      const r = await refundEscrow(wallet.walletClient, wallet.account, publicClient, lastLookup.id);
      $("lookup-result").innerHTML =
        note("good", `Reclaimed. Transaction ${txLink(r.transactionHash)}`) +
        $("lookup-result").innerHTML;
      $("refund").hidden = true;
    });
  } catch (err) {
    $("lookup-result").innerHTML = note("bad", errText(err)) + $("lookup-result").innerHTML;
  }
});

// --------------------------------------------------------------- live kobo hint

$("naira").addEventListener("input", () => {
  const whole = Number($("naira").value);
  $("kobo-hint").textContent =
    whole > 0
      ? `The buyer will be asked for about ₦${formatNaira(whole, 37)}, with the exact kobo chosen when you lock. No two open trades can share an amount, and that is what ties an alert to this trade.`
      : "A unique kobo value is added so no two open trades share an amount. That is what ties an alert to this trade.";
});

// --------------------------------------------------------------- USD/NGN rate

import {
  fetchOfficial,
  customRate,
  setCustomRate,
  convert,
  OFFICIAL_VENUE,
} from "./rate.js";

let official = null;        // { ngn, usdcPeg, venue } or null
let nairaWasAutofilled = false;

function activeRate() {
  return customRate() ?? official?.ngn ?? null;
}

function renderRate() {
  const mine = customRate();
  const rate = activeRate();
  const bar = document.querySelector(".rate-bar");

  if (rate == null) {
    $("rate-val").textContent = "unavailable";
    $("rate-src").textContent =
      "Could not reach a rate source. Type the naira figure yourself, or set your own rate.";
    bar?.classList.remove("custom");
    return;
  }

  $("rate-val").textContent = `₦${rate.toLocaleString("en-NG", { maximumFractionDigits: 2 })}`;

  if (mine != null) {
    bar?.classList.add("custom");
    $("rate-src").textContent = official
      ? `Your own rate. ${OFFICIAL_VENUE} has the official rate at ₦${official.ngn.toLocaleString("en-NG", { maximumFractionDigits: 2 })}.`
      : "Your own rate.";
  } else {
    bar?.classList.remove("custom");
    // Naming the venue matters: this is the OFFICIAL rate, and Nigerian P2P does not
    // clear there. Saying so is the difference between a reference and a lie.
    $("rate-src").textContent =
      `${OFFICIAL_VENUE}, official rate. Peer-to-peer in Nigeria clears above this, so set your own before quoting.`;
  }
}

/// USDC in the seller panel drives the naira figure, unless the seller typed one.
function recomputeNaira() {
  const rate = activeRate();
  const usdc = Number($("usdc").value);
  if (rate == null || !(usdc > 0)) return;
  if ($("naira").value !== "" && !nairaWasAutofilled) return;

  const ngn = convert(usdc, rate);
  if (ngn == null) return;
  $("naira").value = Math.round(ngn);
  nairaWasAutofilled = true;
  $("naira").dispatchEvent(new Event("input", { bubbles: true }));
}

$("usdc").addEventListener("input", recomputeNaira);
// Typing in the naira field by hand takes it out of our control for good.
$("naira").addEventListener("input", (ev) => { if (ev.isTrusted) nairaWasAutofilled = false; });

$("rate-edit").addEventListener("click", () => {
  const ed = $("rate-editor");
  ed.hidden = !ed.hidden;
  if (!ed.hidden) {
    $("rate-input").value = customRate() ?? (official ? Math.round(official.ngn) : "");
    $("rate-input").focus();
  }
});

$("rate-save").addEventListener("click", () => {
  const n = Number($("rate-input").value);
  if (!(n > 0)) return;
  setCustomRate(n);
  $("rate-editor").hidden = true;
  nairaWasAutofilled = true;   // a new rate re-prices the quote
  renderRate();
  recomputeNaira();
});

$("rate-clear").addEventListener("click", () => {
  setCustomRate(null);
  $("rate-editor").hidden = true;
  nairaWasAutofilled = true;
  renderRate();
  recomputeNaira();
});

renderRate();
fetchOfficial().then((r) => {
  official = r;
  // If the peg has come apart, naira priced off USD is no longer naira priced off USDC,
  // and this page prices a USDC trade. Say so rather than quietly using the wrong leg.
  if (r && r.usdcPeg != null && Math.abs(r.usdcPeg - 1) > 0.01) {
    $("rate-src").textContent =
      `USDC is quoted at ${r.usdcPeg} to the dollar right now, so a dollar rate is not a USDC rate. Set your own.`;
    return;
  }
  renderRate();
  recomputeNaira();
});

// --------------------------------------------------------------- the handoff

// A trade has two people in it and the product had no way to hand one to the other.
// A seller locked an escrow and then told the buyer a number and a figure verbally, in
// the same chat the whole problem lives in. That is the one step this product exists to
// make safe, so it gets a link and a message, not a verbal instruction.

function tradeLink(id) {
  return `${location.origin}${location.pathname}?escrow=${id}`;
}

/// Shown to the seller after locking. The figure is in the message because the buyer
/// needs it to pay, and the link is in it because the buyer needs to CHECK it. Giving
/// one without the other is how a wrong figure gets paid.
function renderShare(id, nairaText, recipient) {
  const link = tradeLink(id);
  const msg =
    `Alert escrow #${id}\n` +
    `Send exactly ₦${nairaText} to my Moniepoint account ending ${recipient}.\n` +
    `Check the figure against the chain first, then prove payment here:\n${link}`;

  const el = $("share");
  el.hidden = false;
  el.className = "share";
  el.innerHTML = `
    <h4>Send this to your buyer</h4>
    <p>The figure and the link together. The link lets them verify the figure before paying.</p>
    <textarea id="share-text" readonly spellcheck="false"></textarea>
    <div class="acts">
      <button class="btn" data-copy-el="share-text">Copy message</button>
      <button class="btn" data-copy="${link}">Copy link only</button>
    </div>`;
  $("share-text").value = msg;
}

// Copying from a textarea needs its value, not a data attribute.
document.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-copy-el]");
  if (!btn) return;
  const src = $(btn.dataset.copyEl);
  if (!src) return;
  try {
    await navigator.clipboard.writeText(src.value);
    const was = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = was), 1400);
  } catch (e) {
    src.select();
    btn.textContent = "Press to select";
  }
});

/// A buyer arriving on ?escrow=N lands with their side already filled in.
(function openFromLink() {
  const id = new URLSearchParams(location.search).get("escrow");
  if (id === null) return;
  $("escrow-id").value = id;
  $("escrow-id").dispatchEvent(new Event("change", { bubbles: true }));
  $("lookup-id").value = id;
  // Put them in front of their own half of the trade rather than the top of the page.
  requestAnimationFrame(() => {
    $("escrow-id").closest(".panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
})();

// --------------------------------------------------------------- recent trades

// Without this the app is unusable unless you already know an escrow number, which
// nobody does on a first visit.
async function renderRecent() {
  const box = $("recent");
  if (!deployed) { box.innerHTML = `<p class="empty">Contracts are not deployed yet.</p>`; return; }
  try {
    const { escrowCount } = await import("./app.js");
    const n = Number(await escrowCount(publicClient));
    if (n === 0) { box.innerHTML = `<p class="empty">No trades yet. Open the first one.</p>`; return; }

    const ids = [];
    for (let i = n - 1; i >= 0 && ids.length < 8; i--) ids.push(i);
    const rows = await Promise.all(ids.map(async (i) => {
      try { return { i, e: await readEscrow(publicClient, i) }; }
      catch (err) { return { i, e: null }; }
    }));

    box.innerHTML = `<div class="trades">` + rows.map(({ i, e }) => {
      // A row that could not be read says so rather than vanishing, or the list
      // quietly under-reports and looks complete.
      if (!e) return `<div class="trade"><span class="n">#${i}</span><span class="who">could not be read</span></div>`;
      return `
        <div class="trade">
          <span class="n">#${i}</span>
          <span class="amt">${e.usdcText} USDC</span>
          <span class="pill ${e.status.toLowerCase()}">${e.status}</span>
          <span class="who">${short(e.seller)} &rarr; ${short(e.buyer)}</span>
          <span class="acts">
            <button class="btn" style="padding:6px 11px;font-size:var(--t-xs)" data-open-escrow="${i}">Open</button>
          </span>
        </div>`;
    }).join("") + `</div>`;
  } catch (err) {
    box.innerHTML = note("bad", `Could not read the escrow list. ${errText(err)}`);
  }
}

document.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-open-escrow]");
  if (!btn) return;
  const id = btn.dataset.openEscrow;
  $("escrow-id").value = id;
  $("escrow-id").dispatchEvent(new Event("change", { bubbles: true }));
  $("lookup-id").value = id;
  $("escrow-id").closest(".panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
});

renderRecent();
updateSettleGate();
