// The JS half of contracts/src/AlertHash.sol, alone in its own module.
//
// WHY IT IS ITS OWN FILE.
//
// A Groth16 public signal is an element of the BN254 scalar field, about 254 bits, and
// keccak256 produces 256. So every hash crossing that boundary is truncated to 248 bits.
// Three places perform that truncation: the circuit, the contract, and this page. If any
// two disagree, nothing errors. The escrow stores a hash the proof can never match, and
// a settlement reverts with WrongAmount on an amount that is perfectly correct.
//
// It lives apart from app.js because app.js cannot be imported outside a browser: it
// opens wallet clients and reads `window`. Keeping the function here, with one import and
// no side effects, is what lets scripts/gen-field-hash-vectors.mjs produce vectors from
// the code that actually ships rather than from a fourth copy of the same arithmetic.
// A reimplementation in the test would agree with itself and prove nothing.

import { keccak256, toHex, stringToBytes } from "https://esm.sh/viem@2.21.54";

/// 248 bits set. Must equal AlertHash.FIELD_MASK.
export const FIELD_MASK = (1n << 248n) - 1n;

/// Field-safe hash of a string, as a 32-byte hex value.
export function fieldHash(s) {
  const full = BigInt(keccak256(stringToBytes(s)));
  return toHex(full & FIELD_MASK, { size: 32 });
}
