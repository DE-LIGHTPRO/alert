// DOM wiring. All chain logic lives in app.js, .eml parsing in eml.js; this file only
// reads inputs, calls them, and renders what came back.

import {
  CONFIG,
  makePublicClient,
  connect,
  openEscrow,
  readEscrow,
  refundEscrow,
  allocateKobo,
  formatNaira,
  fieldHash,
} from "./app.js";
import { previewEml, missingFields } from "./eml.js";

const $ = (id) => document.getElementById(id);
const publicClient = makePublicClient();

let wallet = null; // { walletClient, account }
let emlFields = null;
let lastLookup = null; // { id, escrow }
let buyerEscrow = null; // { id, escrow } for the "prove you paid" card

const deployed = Boolean(CONFIG.escrow);

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
if (deployed) $("lookup").disabled = false; // reads need no wallet

// --------------------------------------------------------------- connect

$("connect").addEventListener("click", async () => {
  try {
    await working($("connect"), "Connecting…", async () => {
      wallet = await connect();
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

      const receipt = await openEscrow(wallet.walletClient, wallet.account, publicClient, {
        buyer,
        usdc,
        nairaAmountText: text,
        recipientMasked: `*****${recipient}`,
        hours,
      });

      out.innerHTML =
        renderFigure(text) +
        note(
          "good",
          `<strong>Locked.</strong> Send the buyer that exact figure and your account
           ending ${recipient}. They prove it here and the USDC releases to them
           automatically.<br>Transaction ${txLink(receipt.transactionHash)}`
        );
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
  if (id === "" || !deployed) return (out.innerHTML = "");
  try {
    const e = await readEscrow(publicClient, id);
    if (e.statusCode === 0) return (out.innerHTML = note("bad", "No escrow with that number."));
    buyerEscrow = { id, escrow: e };
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
  const match = fieldHash(raw).toLowerCase() === buyerEscrow.escrow.amountHash.toLowerCase();
  out.innerHTML = match
    ? `<div class="match yes">&#10003; That figure matches escrow #${buyerEscrow.id}. Safe to transfer it.</div>`
    : `<div class="match no">&#10007; That figure does <strong>not</strong> match escrow #${buyerEscrow.id}. Do not send anything until the seller gives you the right one.</div>`;
}
$("check-naira").addEventListener("input", checkAmount);

// --------------------------------------------------------------- .eml preview

$("eml").addEventListener("change", async (ev) => {
  const file = ev.target.files?.[0];
  const out = $("eml-preview");
  if (!file) return (out.innerHTML = "");
  $("eml-name").textContent = file.name;

  const text = await file.text();
  emlFields = previewEml(text);
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

$("settle").addEventListener("click", () => {
  $("settle-result").innerHTML = note(
    "warn",
    `<strong>The prover is not wired up yet.</strong>
     The Moniepoint circuit is still compiling on zkEmail's registry. Until it produces a
     verifier there is nothing real to call, so this does nothing rather than showing you
     a result it did not earn.`
  );
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
