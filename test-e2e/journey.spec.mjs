// The seller and buyer flows, driven through the real interface against a real chain.
//
// WHY THIS EXISTS.
//
// Four defects shipped on the path that releases money, and every one of them was
// invisible to the suite that existed:
//
//   - ui.js never declared emlText, so the upload handler threw ReferenceError on its
//     first line. ES modules are strict mode. `node --check` parses it happily.
//   - "Generate proof and settle" carried `disabled` in the markup and nothing ever
//     cleared it, so the buyer could never settle at all.
//   - app.js re-exported fieldHash without importing it, so the seller's Lock threw.
//   - Every write returned a receipt unexamined, so a reverted refund rendered as
//     "Reclaimed." while nothing moved.
//
// Each one was correct in every unit: the contract settles, settleEscrow() is right, the
// handler is attached, the matching logic renders the right verdict. The wiring between
// them was the defect, and only driving the page found it. So each test below is pinned
// to one of those, and the file is named for the journey rather than for a module.

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RPC, SELLER, BUYER, rpc, advanceSeconds } from "./chain.mjs";

// Read lazily. globalSetup writes this file, and a spec module is loaded before that
// runs for `--list`, so reading it at import time made the whole suite unlistable.
let _addr = null;
function ADDRS() {
  _addr ??= JSON.parse(readFileSync(join(import.meta.dirname, ".addresses.json"), "utf8"));
  return _addr;
}
const EML = join(import.meta.dirname, "..", "fixtures", "synthetic-moniepoint-debit.eml");

/// The synthetic alert's figures. The escrow has to be opened against these exactly,
/// because the amount is the binding.
const ALERT_AMOUNT = "160,000.37";
const ALERT_RECIPIENT = "10101";

/// A minimal EIP-1193 provider over anvil. Installed before any page script runs, so
/// connect(), switchChain() and writeContract() all take their normal path; anvil signs
/// for its own unlocked accounts, so eth_sendTransaction passes straight through.
async function withWallet(page) {
  await page.addInitScript(
    ({ rpcUrl, account, cfg }) => {
      localStorage.setItem("alert-config", JSON.stringify(cfg));
      let n = 0;
      window.ethereum = {
        isMetaMask: false,
        __acct: account,
        on() {},
        removeListener() {},
        async request({ method, params = [] }) {
          if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
          if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain")
            return null;
          const r = await fetch(rpcUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }),
          });
          const j = await r.json();
          if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
          return j.result;
        },
      };
    },
    {
      rpcUrl: RPC,
      account: SELLER,
      cfg: { escrow: ADDRS().escrow, usdc: ADDRS().usdc, rpc: RPC, chainId: 31337 },
    }
  );
}

async function connect(page) {
  await page.goto("/app.html");
  await page.click("#connect");
  await expect(page.locator("#connect")).toContainText("0xf39F", { timeout: 15000 });
}

/// Opens an escrow through the form and returns its number, read from the page rather
/// than from a counter, because the page is what the seller has to tell the buyer.
async function lock(page, { usdc, naira, recipient, hours }) {
  await page.fill("#usdc", String(usdc));
  await page.fill("#buyer", BUYER);
  await page.fill("#naira", String(naira));
  await page.fill("#recipient", recipient);
  await page.fill("#hours", String(hours));
  await page.click("#open");
  const note = page.locator("#open-result .note.good");
  await expect(note).toBeVisible({ timeout: 40000 });
  const text = await note.innerText();
  const m = text.match(/escrow #(\d+)/i);
  expect(m, `the success note must name the escrow number, got: ${text}`).not.toBeNull();
  return Number(m[1]);
}

test.describe("the seller locks", () => {
  test.beforeEach(async ({ page }) => {
    await withWallet(page);
    await connect(page);
  });

  // app.js re-exported fieldHash without importing it, so both allocateKobo and
  // openEscrow threw "fieldHash is not defined" the moment Lock was pressed.
  test("locking succeeds and names the escrow the buyer must look up", async ({ page }) => {
    const id = await lock(page, { usdc: 2, naira: 45000, recipient: "52988", hours: 24 });
    expect(id).toBeGreaterThanOrEqual(0);

    // The exact figure, with the kobo the contract chose, has to be on screen: the buyer
    // must send it to the cent and the seller can only read it here.
    await expect(page.locator("#open-result")).toContainText(/₦45,000\.\d{2}/);
  });

  // renderRecent() ran once at page load, so the list said "No trades yet" directly
  // under a trade that had just been locked.
  test("the trade appears in Recent trades without a reload", async ({ page }) => {
    const id = await lock(page, { usdc: 1, naira: 12000, recipient: "52988", hours: 24 });
    await expect(page.locator("#recent")).toContainText(`#${id}`, { timeout: 20000 });
    await expect(page.locator("#recent")).not.toContainText("No trades yet");
  });
});

test.describe("the buyer checks the figure before paying", () => {
  let id;
  test.beforeEach(async ({ page }) => {
    await withWallet(page);
    await connect(page);
    id = await lock(page, { usdc: 1, naira: 88000, recipient: "52988", hours: 24 });
    await page.fill("#escrow-id", String(id));
    await expect(page.locator("#eml-preview, #settle-gate")).toBeTruthy();
  });

  test("the exact figure matches and a wrong one does not", async ({ page }) => {
    const exact = (await page.locator("#open-result").innerText()).match(/₦([\d,]+\.\d{2})/)[1];
    await page.fill("#check-naira", exact);
    await expect(page.locator("#check-result")).toContainText("matches escrow", { timeout: 15000 });

    const [whole, kobo] = exact.split(".");
    const offByOneKobo = `${whole}.${String((Number(kobo) + 1) % 100).padStart(2, "0")}`;
    await page.fill("#check-naira", offByOneKobo);
    await expect(page.locator("#check-result")).toContainText("does not match");
  });

  // The same number without commas used to be reported as "does not match ... until the
  // seller gives you the right one", which accuses an honest seller over punctuation.
  test("a missing comma is named as punctuation, not as a wrong figure", async ({ page }) => {
    const exact = (await page.locator("#open-result").innerText()).match(/₦([\d,]+\.\d{2})/)[1];
    await page.fill("#check-naira", exact.replace(/,/g, ""));
    await expect(page.locator("#check-result")).toContainText("wrong punctuation", {
      timeout: 15000,
    });
    await expect(page.locator("#check-result")).toContainText("quoted you correctly");
  });
});

test.describe("the buyer proves payment", () => {
  // ui.js never declared emlText, so this handler threw on its first line and the
  // upload silently did nothing. And the settle button was never enabled by anything.
  test("reading the alert opens the settle gate", async ({ page }) => {
    await withWallet(page);
    await connect(page);

    // Bound to the alert's own figure, since the amount is the binding. openEscrow takes
    // the text directly, which is how a trade matching a given alert can be set up.
    const id = await page.evaluate(
      async ({ amount, recipient, buyer, account }) => {
        const m = await import("./app.js");
        const viem = await import("https://esm.sh/viem@2.21.54");
        const wc = viem.createWalletClient({
          chain: m.chain,
          transport: viem.custom(window.ethereum),
        });
        const { escrowId } = await m.openEscrow(wc, account, m.makePublicClient(), {
          buyer,
          usdc: 3,
          nairaAmountText: amount,
          recipientMasked: `*****${recipient}`,
          hours: 24,
        });
        return escrowId;
      },
      { amount: ALERT_AMOUNT, recipient: ALERT_RECIPIENT, buyer: BUYER, account: SELLER }
    );

    await expect(page.locator("#settle")).toBeDisabled();

    await page.setInputFiles("#eml", EML);
    // The preview proves the handler ran at all, which is what the undeclared variable
    // prevented. Its absence was the only symptom: no error reached the page.
    await expect(page.locator("#eml-preview")).toContainText("Nothing was uploaded", {
      timeout: 15000,
    });
    await expect(page.locator("#eml-name")).toContainText(".eml");

    await page.fill("#escrow-id", String(id));
    // Report the gate's own reason on failure. "disabled" alone says nothing about
    // which of the four blockers is still standing.
    await expect
      .poll(async () => (await page.locator("#settle-gate").innerText()).trim(), {
        timeout: 20000,
        message: "the settle gate never cleared",
      })
      .toBe("");
    await expect(page.locator("#settle")).toBeEnabled();
  });

  // An inviting label on a button that cannot be pressed reads as a broken product.
  test("the gate names what is still missing", async ({ page }) => {
    await withWallet(page);
    await page.goto("/app.html");
    await expect(page.locator("#settle-gate")).toContainText("connect your wallet", {
      timeout: 15000,
    });
    await expect(page.locator("#settle-gate")).toContainText("escrow number");
    await expect(page.locator("#settle-gate")).toContainText(".eml");
  });
});

test.describe("the seller reclaims after the deadline", () => {
  // Every write returned its receipt unexamined. Before the deadline the escrow
  // correctly refuses, the transaction is mined reverted, and the page used to render
  // "Reclaimed." with a hash while nothing moved.
  test("a refused refund is not reported as a success", async ({ page }) => {
    await withWallet(page);
    await connect(page);
    const id = await lock(page, { usdc: 1, naira: 54000, recipient: "52988", hours: 1 });

    // Called directly rather than clicked, on purpose, and this corrects how the defect
    // was first described. The page hides #refund unless the escrow is open, expired and
    // yours, so a user cannot press it early; the original repro used element.click(),
    // which fires on a hidden button. The bug is real either way, because any revert
    // reaches this path: a settle that loses a race, or a deadline that passes between
    // the lookup and the signature. What must never happen is a reverted transaction
    // being reported as success, so that is what this asserts, at the seam where the
    // page decides.
    const outcome = await page.evaluate(async (escrowId) => {
      const m = await import("./app.js");
      const viem = await import("https://esm.sh/viem@2.21.54");
      const wc = viem.createWalletClient({
        chain: m.chain,
        transport: viem.custom(window.ethereum),
      });
      try {
        await m.refundEscrow(wc, window.ethereum.__acct, m.makePublicClient(), escrowId);
        return { threw: false };
      } catch (e) {
        return { threw: true, message: String(e.message) };
      }
    }, id);

    expect(outcome.threw, "a refund before the deadline must not resolve as success").toBe(true);
    expect(outcome.message).toContain("reverted");
    expect(outcome.message).toContain("nothing moved");

    const status = await page.evaluate(async (escrowId) => {
      const m = await import("./app.js");
      return (await m.readEscrow(m.makePublicClient(), escrowId)).status;
    }, id);
    expect(status, "the escrow must still be open").toBe("Open");
  });

  test("after the deadline the USDC comes back and only one outcome is shown", async ({ page }) => {
    await withWallet(page);
    await connect(page);
    const id = await lock(page, { usdc: 4, naira: 61000, recipient: "52988", hours: 1 });

    // Past the deadline BEFORE the lookup. The page decides whether to offer Reclaim at
    // lookup time, from the deadline it read then, so looking up first leaves the button
    // correctly hidden and the click waiting forever.
    await advanceSeconds(7200);

    await page.fill("#lookup-id", String(id));
    await page.click("#lookup");
    await expect(page.locator("#lookup-result")).toContainText("Status", { timeout: 20000 });
    await expect(page.locator("#refund")).toBeVisible();

    await page.click("#refund");
    await expect(page.locator("#lookup-result")).toContainText("Reclaimed", { timeout: 40000 });

    // A refusal and the success after it used to sit on screen together, and the stale
    // line is the one a worried seller reads.
    await expect(page.locator("#lookup-result > .note")).toHaveCount(1);

    const status = await page.evaluate(async (escrowId) => {
      const m = await import("./app.js");
      return (await m.readEscrow(m.makePublicClient(), escrowId)).status;
    }, id);
    expect(status).toBe("Refunded");
  });
});

test.describe("what the page claims about itself", () => {
  // The light palette lived only inside @media (prefers-color-scheme: light), so the
  // toggle flipped an attribute, persisted a preference, and changed no colour.
  test("choosing light actually changes the colours", async ({ page }) => {
    // The OS must report DARK for this to mean anything. Playwright emulates
    // prefers-color-scheme: light by default, so the media-query palette already
    // applied, the "dark" baseline was never dark, and the test compared light to
    // light and failed. That default is also precisely the configuration in which the
    // original bug was invisible: the toggle only ever worked when the OS had already
    // chosen light for you.
    await page.emulateMedia({ colorScheme: "dark" });
    await withWallet(page);
    await page.goto("/app.html");
    const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    await page.evaluate(() => localStorage.setItem("alert-theme", "light"));
    await page.reload();
    const light = await page.evaluate(() => ({
      theme: document.documentElement.getAttribute("data-theme"),
      bg: getComputedStyle(document.body).backgroundColor,
    }));

    expect(light.theme).toBe("light");
    expect(light.bg).not.toBe(dark);
  });

  // A hidden warning reads as "this deployment verifies proofs". The local deployment
  // uses the same IS_STUB marker the deployed StubVerifier carries.
  test("the stub verifier is announced", async ({ page }) => {
    await withWallet(page);
    await page.goto("/app.html");
    await expect(page.locator("#stub-warning")).toBeVisible({ timeout: 20000 });
    await expect(page.locator("#stub-text")).toContainText("not verified");
  });

  test("no page scrolls sideways on a phone", async ({ page }) => {
    await withWallet(page);
    await page.setViewportSize({ width: 375, height: 812 });
    for (const path of ["/index.html", "/app.html", "/how.html", "/audit.html"]) {
      await page.goto(path);
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth, `${path} scrolls sideways at 375px`).toBeLessThanOrEqual(clientWidth);
    }
  });
});
