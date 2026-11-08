#!/usr/bin/env python3
"""Builds circuit/Prover.toml from a real .eml, with no network and no dependencies.

    python3 -I circuit/make-inputs.py fixtures/moniepoint-debit.eml

WHY THIS IS HAND-ROLLED.

zkEmail ship `@zk-email/zkemail-nr`, which does exactly this. It pulls `@aztec/bb.js`,
149 MB unpacked, onto a connection that spent an hour failing to move 27 MB. The three
things actually needed here are RFC 6376 relaxed header canonicalisation, a base64
decode, and splitting two big integers into 120-bit limbs. None of that needs a package.

WHAT IT PRINTS AND WHAT IT NEVER PRINTS.

The header of a bank alert carries the recipient's address and the subject. The body
carries the name, the account number and the balance. This reads the file and writes
Prover.toml; it prints lengths, offsets and a key fingerprint, never contents. The one
exception is the DKIM domain and selector, which are public DNS facts.

THE PART THAT IS EASY TO GET WRONG.

The signed header is not the raw header block. It is the headers named in the signature's
`h=` tag, in that order, each canonicalised, followed by the DKIM-Signature header itself
with the `b=` value emptied and with no trailing CRLF. Relaxed canonicalisation lowercases
the field name, unfolds continuation lines, collapses runs of whitespace, and strips
trailing whitespace before the colon and at end of line. Getting any of that wrong
produces a header that looks right and verifies against nothing.
"""

import base64
import re
import sys
from pathlib import Path

LIMB_BITS = 120
NUM_LIMBS = 18  # ceil(2048 / 120)


def split_headers(raw: bytes) -> bytes:
    i = raw.find(b"\r\n\r\n")
    return raw[:i] if i != -1 else raw


def unfold(header_block: bytes) -> list[bytes]:
    """Split into logical header lines, joining continuations."""
    lines: list[bytes] = []
    for line in header_block.split(b"\r\n"):
        if line[:1] in (b" ", b"\t") and lines:
            lines[-1] += line
        else:
            lines.append(line)
    return lines


def relaxed(line: bytes) -> bytes:
    """RFC 6376 relaxed canonicalisation of one header line."""
    name, _, value = line.partition(b":")
    name = name.strip().lower()
    value = re.sub(rb"[ \t\r\n]+", b" ", value).strip()
    return name + b":" + value


def dkim_tags(dkim_line: bytes) -> dict:
    body = dkim_line.partition(b":")[2]
    tags = {}
    for part in body.split(b";"):
        k, _, v = part.partition(b"=")
        k = k.strip()
        if k:
            tags[k.decode()] = re.sub(rb"[ \t\r\n]+", b"", v)
    return tags



def biggest_integer(der: bytes) -> bytes:
    """The RSA modulus out of a SubjectPublicKeyInfo, without an ASN.1 library.

    The first version read der[i+1] as the length, which is only true for short-form
    lengths under 128 bytes. A 2048-bit modulus is 257 bytes and uses the long form
    (0x82 followed by two length bytes), so that version sliced 130 bytes out of the
    middle of the key and reported a 1033-bit modulus. A nonsense key size is the tell;
    had it landed on something near 2048 it would have passed and failed in the circuit.
    """
    best = b""
    i = 0
    while i < len(der) - 1:
        tag, ln = der[i], der[i + 1]
        if ln < 0x80:
            start, size = i + 2, ln
        else:
            n = ln & 0x7F
            if i + 2 + n > len(der):
                break
            size = int.from_bytes(der[i + 2 : i + 2 + n], "big")
            start = i + 2 + n
        if tag == 0x02 and size > len(best) and start + size <= len(der):
            best = der[start : start + size]
        i += 1
    if not best:
        raise ValueError("no INTEGER found in the key")
    return best.lstrip(b"\x00")


def to_limbs(n: int) -> list[int]:
    mask = (1 << LIMB_BITS) - 1
    return [(n >> (LIMB_BITS * i)) & mask for i in range(NUM_LIMBS)]


def redc_param(modulus: int) -> int:
    """Barrett reduction parameter, exactly as noir-bignum expects it.

    floor(2^(2 * MOD_BITS + 4) / modulus), where MOD_BITS is the modulus bit length.

    Not guessed. The first version used the limb-aligned width, 2^(2 * 18 * 120) =
    2^4320, which parses fine, produces a plausible 18-limb array, and fails deep inside
    noir-bignum with "Failed to solve brillig function" and a six-frame stack that names
    nothing recognisable. The exponent was read out of the library's own shipped
    parameters instead: U2048 carries a 2049-bit modulus whose redc is exactly
    2^4102 // modulus, which is 2 * 2049 + 4. For a 2048-bit key that makes it 2^4100.
    """
    return (1 << (2 * modulus.bit_length() + 4)) // modulus


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: make-inputs.py <path to .eml> [dkim public key modulus, base64]")
        return 1
    eml = Path(sys.argv[1])
    raw = eml.read_bytes().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")

    lines = unfold(split_headers(raw))
    dkim = next((l for l in lines if l[:15].lower() == b"dkim-signature:"), None)
    if dkim is None:
        print("no DKIM-Signature header in that file")
        return 1

    tags = dkim_tags(dkim)
    domain = tags.get("d", b"?").decode()
    selector = tags.get("s", b"?").decode()
    signed = [h.strip().lower() for h in tags.get("h", b"").split(b":") if h.strip()]
    print(f"  d={domain}  s={selector}  a={tags.get('a', b'?').decode()}")
    print(f"  signs {len(signed)} headers: {', '.join(h.decode() for h in signed)}")

    # Each named header, in h= order, canonicalised.
    out = b""
    by_name: dict[bytes, list[bytes]] = {}
    for line in lines:
        by_name.setdefault(line.partition(b":")[0].strip().lower(), []).append(line)
    for name in signed:
        if by_name.get(name):
            out += relaxed(by_name[name].pop(0)) + b"\r\n"

    # Then the DKIM-Signature itself with b= emptied, and no trailing CRLF.
    out += re.sub(rb"\bb=[^;]*", b"b=", relaxed(dkim))

    sig = int.from_bytes(base64.b64decode(tags["b"]), "big")
    print(f"  signed header: {len(out)} bytes")
    print(f"  signature:     {sig.bit_length()} bits")

    if len(sys.argv) > 2:
        der = base64.b64decode(sys.argv[2])
        modulus = int.from_bytes(biggest_integer(der), "big")
        print(f"  modulus:       {modulus.bit_length()} bits")
    else:
        print("\n  No public key given, so Prover.toml is not written.")
        print("  Fetch it and pass the base64 p= value as the second argument:")
        print(f"    dig +short TXT {selector}.domainkey.<sendgrid host> | tr -d '\"'")
        return 0

    if modulus.bit_length() != 2048:
        print(f"  modulus is {modulus.bit_length()} bits, circuit expects 2048")
        return 1

    header_bytes = list(out) + [0] * (1024 - len(out))
    # Every top-level key must come BEFORE the first table header. TOML puts everything
    # after [pubkey] inside that table, so emitting signature last made it
    # pubkey.signature and nargo reported the argument missing.
    toml = [
        "# Generated by circuit/make-inputs.py from a real alert. Do not commit: the",
        "# header carries the recipient address and subject line.",
        f"header = {{ storage = {header_bytes}, len = {len(out)} }}",
        f"signature = {[str(x) for x in to_limbs(sig)]}",
        "",
        "[pubkey]",
        f"modulus = {[str(x) for x in to_limbs(modulus)]}",
        f"redc = {[str(x) for x in to_limbs(redc_param(modulus))]}",
        "",
    ]
    dest = Path(__file__).parent / "Prover.toml"
    dest.write_text("\n".join(toml))
    print(f"\n  wrote {dest} ({len(out)} header bytes, {NUM_LIMBS} limbs per bignum)")
    print("  next: cd circuit && nargo execute")
    return 0


if __name__ == "__main__":
    sys.exit(main())
