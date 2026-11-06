// Reading a Moniepoint alert in the browser, purely so the UI can show a user what the
// proof WILL assert before they spend time generating it.
//
// Nothing downstream trusts this. The contract believes the Groth16 proof and nothing
// else. If this file and the circuit ever disagree, the circuit is right and this is a
// misleading preview, which is why the patterns below are copied from the compiled
// blueprint rather than written independently.
//
// No imports on purpose: it stays a pure function so it can be tested in node against a
// real fixture, without pulling viem or a browser.

/// The circuit sees the body with quoted-printable soft line breaks removed
/// (`remove_soft_linebreaks: true` on the blueprint), so match that, not the raw bytes.
export function dewrap(text) {
  return text.replace(/=\r\n/g, "").replace(/=\n/g, "");
}

/// Mirrors the blueprint's four extracted fields.
export function previewEml(text) {
  const out = {
    amount: null,
    recipient: null,
    boundary: null,
    subject: null,
    sender: null,
    isDebitAlert: false,
  };

  const subject = text.match(/^subject:\s*(.+)$/im);
  if (subject) out.subject = subject[1].trim();
  out.isDebitAlert = /^subject:\s*Debit alert/im.test(text);

  const sender = text.match(/^from:[^\r\n<]*<?([^\s<>]+@[^\s<>]+?)>?\s*$/im);
  if (sender) out.sender = sender[1];

  // The nullifier. A SendGrid-generated MIME boundary, 60 hex characters, inside a
  // SIGNED header. Headers are not quoted-printable encoded, so unlike everything in the
  // narration it can never be split by a line wrap.
  const boundary = text.match(/content-type:[^\r\n]*boundary=([a-f0-9]+)/i);
  if (boundary) out.boundary = boundary[1];

  const body = dewrap(text);

  // Anchored on the HTML copy, not the plain-text one. The body cutoff discards
  // everything before the last occurrence, so the plain-text copy near the top of the
  // email is not in the circuit's view at all.
  const amount = body.match(/margin-top: 7px;">([0-9,]+\.[0-9]{2})<\/span>/);
  if (amount) out.amount = amount[1];

  const recipient = body.match(/\*{5}([0-9]{5})\/TRF/);
  if (recipient) out.recipient = recipient[1];

  return out;
}

/// What is missing, in words a user can act on.
export function missingFields(f) {
  const miss = [];
  if (!f.amount) miss.push("amount");
  if (!f.recipient) miss.push("destination account");
  if (!f.boundary) miss.push("transaction reference");
  return miss;
}
