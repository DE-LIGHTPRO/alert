#!/usr/bin/env python3
"""Verifies a bank alert's DKIM signature against the key the bank publishes in DNS.

    python3 -I circuit/verify-dkim.py fixtures/moniepoint-debit.eml

No dependencies, no network except one DNS lookup, nothing uploaded anywhere.

WHY THIS EXISTS SEPARATELY FROM THE CIRCUIT.

The whole product rests on one claim: a Nigerian bank already signs its alerts, and that
signature is checkable by anyone without the bank's involvement. The zkEmail registry
failed to compile the circuit twice, which left that claim asserted rather than shown.

This shows it. It is not zero-knowledge and proves nothing privately. It verifies, on
your own machine, that the alert in your inbox carries a valid RSA signature from the key
at `<selector>._domainkey.<domain>`. The circuit does the same check inside a proof so
the email never has to be shown to anyone; the arithmetic being verified is this.

WHAT IT PRINTS.

Lengths, bit sizes, the domain and the selector. Never the header or body: a real alert
carries the recipient address, the account holder's name, the account number and the
balance. The one real value printed is the DKIM public key fingerprint, which is public.

THE PART THAT IS EASY TO GET WRONG, AND THE BUG THAT PROVED IT.

Two things here are fiddly. Relaxed canonicalisation has to reproduce exactly what the
signer did, over the headers named in `h=`, in that order, with the signature's own `b=`
emptied and no trailing CRLF. And pulling the modulus out of the DER needs real ASN.1
length handling: the first version of this read the byte after the tag as the length,
which is only true below 128, so on a 257-byte modulus it sliced 130 bytes out of the
middle and reported a 1033-bit key. The nonsense size is what caught it. A wrong slice
that happened to look like 2048 bits would have failed inside the circuit instead, with
nothing pointing here.
"""

import base64
import hashlib
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from importlib.util import module_from_spec, spec_from_file_location

_spec = spec_from_file_location("mk", Path(__file__).parent / "make-inputs.py")
mk = module_from_spec(_spec)
_spec.loader.exec_module(mk)

SHA256_DIGESTINFO = bytes.fromhex("3031300d060960864801650304020105000420")


def dns_txt(name: str) -> str:
    """The DKIM record, following the CNAME most providers use, joining split chunks."""
    for resolver in ("@1.1.1.1", "@8.8.8.8", ""):
        for target in (name,):
            args = ["dig", "+short", "TXT", target] + ([resolver] if resolver else [])
            try:
                out = subprocess.run(args, capture_output=True, text=True, timeout=15).stdout
            except Exception:
                continue
            joined = out.replace("\n", "").replace('" "', "").replace('"', "").replace(" ", "")
            if "p=" in joined:
                return joined
    return ""


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: verify-dkim.py <path to .eml>")
        return 1
    path = Path(sys.argv[1])
    if not path.exists():
        print(f"{path} not found. Real alerts are gitignored; point this at your own.")
        return 1

    raw = path.read_bytes().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
    lines = mk.unfold(mk.split_headers(raw))
    dkim = next((l for l in lines if l[:15].lower() == b"dkim-signature:"), None)
    if dkim is None:
        print("no DKIM-Signature header: nothing to verify")
        return 1

    tags = mk.dkim_tags(dkim)
    domain, selector = tags.get("d", b"?").decode(), tags.get("s", b"?").decode()
    print(f"  domain    {domain}")
    print(f"  selector  {selector}")
    print(f"  algorithm {tags.get('a', b'?').decode()}")

    # Rebuild exactly what was signed.
    signed = [h.strip().lower() for h in tags.get("h", b"").split(b":") if h.strip()]
    by_name: dict[bytes, list[bytes]] = {}
    for line in lines:
        by_name.setdefault(line.partition(b":")[0].strip().lower(), []).append(line)
    header = b""
    for name in signed:
        if by_name.get(name):
            header += mk.relaxed(by_name[name].pop(0)) + b"\r\n"
    header += re.sub(rb"\bb=[^;]*", b"b=", mk.relaxed(dkim))
    print(f"  signs {len(signed)} headers, {len(header)} canonicalised bytes")

    record = dns_txt(f"{selector}._domainkey.{domain}")
    if not record:
        print(f"  could not read {selector}._domainkey.{domain} from DNS")
        return 1
    p = record.split("p=")[1].split(";")[0]
    der = base64.b64decode(p)
    modulus = int.from_bytes(mk.biggest_integer(der), "big")
    fp = hashlib.sha256(der).hexdigest()[:16]
    print(f"  key       {modulus.bit_length()}-bit RSA, fingerprint {fp}")

    sig = int.from_bytes(base64.b64decode(tags["b"]), "big")
    size = (modulus.bit_length() + 7) // 8
    recovered = pow(sig, 65537, modulus).to_bytes(size, "big")
    digest = hashlib.sha256(header).digest()
    expected = (
        b"\x00\x01"
        + b"\xff" * (size - 3 - len(SHA256_DIGESTINFO) - 32)
        + b"\x00"
        + SHA256_DIGESTINFO
        + digest
    )

    if recovered == expected:
        print("\n  VERIFIED: this alert carries a valid signature from that key.")
        print("  Nobody was asked. The bank published the key so mail servers could")
        print("  check it, and that makes it checkable by anyone, forever.")
        return 0

    print("\n  NOT VERIFIED.")
    if recovered[:2] == b"\x00\x01" and recovered[-51:-32] == SHA256_DIGESTINFO:
        print("  The padding is intact and the digest differs, so the signature and key")
        print("  match each other and the canonicalised header is what is wrong.")
        print(f"    signed digest {recovered[-32:].hex()[:32]}")
        print(f"    ours          {digest.hex()[:32]}")
    else:
        print("  The padding is wrong, so the signature does not belong to this key.")
        print("  A synthetic fixture will land here: its signature is not real.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
