"""Mutation check: break one guard at a time, confirm a named test catches it.

A guard whose removal leaves the suite green is not protected. Run from contracts/:
    python3 -I script/mutate.py

Deliberately parses forge's JSON rather than counting lines of output: counting test
results with a shell pipeline has produced four wrong numbers on sibling projects.
"""

import json
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
ESCROW = ROOT / "src" / "AlertEscrow.sol"
ADAPTER = ROOT / "src" / "AlertProofAdapter.sol"

MUTATIONS = [
    # the two independent replay defences
    (ESCROW, "if (nullifierSpent[a.nullifier]) revert NullifierAlreadySpent();", "", "replay: same alert twice"),
    (ESCROW, "if (amountClaimed[amountHash]) revert AmountAlreadyClaimed(amountHash);", "", "open: two escrows share an amount"),
    # the bindings
    (ESCROW, "if (a.amountHash != e.amountHash) revert WrongAmount();", "", "binding: amount"),
    (ESCROW, "if (a.recipientHash != e.recipientHash) revert WrongRecipient();", "", "binding: recipient"),
    (ESCROW, "if (bankDomainHash != supported) revert BankNotSupported(bankDomainHash, supported);", "", "open: unprovable bank accepted"),
    (ADAPTER, "if (domainHash != expectedBankDomainHash) {", "if (false) {", "adapter: foreign bank domain"),
    # lifecycle
    (ESCROW, "if (block.timestamp > e.deadline) revert Expired();", "", "settle after deadline"),
    (ESCROW, "if (block.timestamp <= e.deadline) revert NotYetExpired();", "", "refund before deadline"),
    (ESCROW, "if (msg.sender != e.seller) revert NotSeller();", "", "refund by non-seller"),
    (ESCROW, "_pushUsdc(buyer, amount);", "_pushUsdc(msg.sender, amount);", "settle pays caller, not buyer"),
    # the amount-space bookkeeping the kobo tag depends on
    (ESCROW, "        amountClaimed[e.amountHash] = false;\n\n        uint128 amount = e.usdcAmount;\n        address buyer = e.buyer;", "        uint128 amount = e.usdcAmount;\n        address buyer = e.buyer;", "settle does not free the amount"),
    # the proof itself
    (ADAPTER, "if (!groth16.verifyProof(pA, pB, pC, pubSignals)) revert ProofInvalid();", "", "proof not checked at all"),
    (ADAPTER, "if (pubSignals[2] == 0) revert ZeroNullifier();", "", "zero nullifier accepted"),
    (ADAPTER, "if (pubSignals[0] == 0) revert ZeroAmountHash();", "", "zero amount hash accepted"),
]


def failing_tests():
    r = subprocess.run(
        ["forge", "test", "--json"], cwd=ROOT, capture_output=True, text=True
    )
    # A compile failure prints no JSON at all; treat that as its own outcome.
    line = next((l for l in r.stdout.splitlines() if l.startswith("{")), None)
    if line is None:
        return None
    data = json.loads(line)
    failed = []
    for suite in data.values():
        for name, res in suite.get("test_results", {}).items():
            if res.get("status") != "Success":
                failed.append(name.split("(")[0])
    return failed


def main():
    baseline = failing_tests()
    if baseline is None:
        print("baseline does not compile")
        return 1
    if baseline:
        print(f"baseline is not green: {baseline}")
        return 1
    print(f"baseline: green\n")

    survivors = []
    for path, old, new, label in MUTATIONS:
        backup = path.read_text()
        if old not in backup:
            print(f"  SKIP  {label}\n        pattern not found, mutation is stale")
            survivors.append((label, "stale"))
            continue
        path.write_text(backup.replace(old, new, 1))
        try:
            failed = failing_tests()
        finally:
            path.write_text(backup)

        if failed is None:
            print(f"  n/a   {label}\n        mutation does not compile")
        elif failed:
            print(f"  caught  {label}")
            print(f"          by: {', '.join(sorted(failed))}")
        else:
            print(f"  SURVIVED  {label}  <-- unguarded")
            survivors.append((label, "survived"))

    print()
    if survivors:
        print(f"{len(survivors)} mutation(s) not caught:")
        for label, why in survivors:
            print(f"  - {label} ({why})")
        return 1
    print(f"all {len(MUTATIONS)} mutations caught")
    return 0


if __name__ == "__main__":
    sys.exit(main())
