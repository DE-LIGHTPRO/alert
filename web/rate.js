// USD/NGN, and the thing everyone gets wrong about it.
//
// Nigeria has two rates. The official one, which is what any public API returns, and the
// parallel rate that peer-to-peer actually clears at, which is meaningfully higher. A
// P2P escrow that fetches the official rate and labels it "the rate" would be telling
// a trader something false about their own market.
//
// So this module does two separate things and never conflates them:
//
//   fetchOfficial()  a real number from a named venue, or null. Never a guess.
//   customRate()     what the trader says their market is, remembered locally.
//
// The UI shows the official rate as a reference and prices against whichever the trader
// chose, labelled with which one it used. A rate is measured or it is the user's own;
// there is no third category where we invent one.

const COINBASE = "https://api.coinbase.com/v2/exchange-rates?currency=USD";
const STORE_KEY = "alert-ngn-rate";

/// The venue, named exactly, for anything shown on screen.
export const OFFICIAL_VENUE = "Coinbase exchange rates";

/// Fetches the official USD/NGN. Returns null rather than a stale or invented figure.
export async function fetchOfficial(signal) {
  try {
    const res = await fetch(COINBASE, { signal });
    if (!res.ok) return null;
    const body = await res.json();

    // A 200 is not a success: check the shape before trusting the payload.
    const rates = body?.data?.rates;
    if (!rates || typeof rates.NGN !== "string") return null;

    const ngn = Number(rates.NGN);
    if (!Number.isFinite(ngn) || ngn <= 0) return null;

    // A plausibility floor. Nigeria has never had a sub-100 naira dollar in the era this
    // product exists for, so a figure that low is a parse failure or a different
    // currency, not a market event. Better to show nothing than a wrong order of
    // magnitude on a page people price trades from.
    if (ngn < 100) return null;

    // Coinbase quotes USDC against USD too. If it ever stops being 1, the USDC leg and
    // the dollar leg have come apart and pricing naira off USD would be wrong.
    const usdc = Number(rates.USDC);
    const usdcPeg = Number.isFinite(usdc) ? usdc : null;

    return { ngn, usdcPeg, venue: OFFICIAL_VENUE, at: Date.now() };
  } catch (e) {
    return null;
  }
}

/// The trader's own rate. Null when they have not set one.
export function customRate() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (e) {
    return null;
  }
}

export function setCustomRate(n) {
  try {
    if (n == null || !Number.isFinite(n) || n <= 0) localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, String(n));
  } catch (e) {
    // A private window loses the memory of it, not the use of it.
  }
}

/// Formats naira the way a Moniepoint alert prints it, which is the form the whole
/// amount binding depends on: thousands separators, exactly two decimals.
export function formatNairaAmount(n) {
  if (!Number.isFinite(n)) return null;
  return n.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/// USDC in, naira out, at a given rate.
export function convert(usdc, rate) {
  if (!Number.isFinite(usdc) || !Number.isFinite(rate) || usdc <= 0 || rate <= 0) return null;
  return usdc * rate;
}
