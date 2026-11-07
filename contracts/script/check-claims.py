"""Every test count shown to a user must equal what the tools actually report.

Run from contracts/:
    python3 -I script/check-claims.py

WHY THIS EXISTS.

The landing page told visitors "30 tests" and the audit page printed "30 passed" and
"14 mutations, 14 caught" on a suite that had grown to 50 and 19. Both numbers were true
when written, and nothing about either looks wrong on a later read: the whole point of a
figure in prose is that it reads as settled. The audit page is the one place a judge goes
specifically to check whether this project's claims hold up, so a stale number there
costs more than anywhere else on the site.

This is the mirrored-constant defect. A number that states a measurement, kept by hand in
a second place, drifts the moment the measurement moves, and review will not catch it
because each copy is locally plausible.

HOW A CLAIM IS MARKED.

    <span data-claim="forge-tests">50</span> tests

Only marked numbers are checked. Prose that recounts history is deliberately exempt:
"removing the settle-time bank check left all 19 tests green" is a true statement about a
past moment, and rewriting it to today's count would make it false.

COUNTS COME FROM THE TOOLS.

forge's JSON, and the mutation list itself. Never from counting lines of tool output with
a shell pipeline, which has produced four wrong numbers across sibling projects.
"""

import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
REPO = ROOT.parent
PAGES = sorted((REPO / "web").glob("*.html"))


def measured_forge_tests():
    """Total tests forge ran. Parsed from its JSON, not from its printed summary."""
    r = subprocess.run(["forge", "test", "--json"], cwd=ROOT, capture_output=True, text=True)
    line = next((l for l in r.stdout.splitlines() if l.startswith("{")), None)
    if line is None:
        return None
    data = json.loads(line)
    return sum(len(s.get("test_results", {})) for s in data.values())


def measured_mutations():
    """Length of the MUTATIONS list, read from the source that defines it.

    Imported rather than regex-counted: a commented-out entry still matches a regex for
    a tuple, and would inflate the count against a suite that never ran it.
    """
    path = ROOT / "script" / "mutate.py"
    src = path.read_text()
    # __file__ matters: mutate.py derives every path it edits from it, so a probe that
    # left it unset would either crash here or, worse, resolve those paths somewhere else.
    ns = {"__name__": "_mutate_probe", "__file__": str(path)}
    # The module runs forge at import only under __main__, so this is cheap.
    exec(compile(src, "mutate.py", "exec"), ns)
    muts = ns.get("MUTATIONS")
    return len(muts) if muts is not None else None


CLAIM = re.compile(r'data-claim="([a-z-]+)"\s*>\s*([0-9][0-9,]*)\s*<')


def main():
    measured = {"forge-tests": measured_forge_tests(), "mutations": measured_mutations()}
    for k, v in measured.items():
        if v is None:
            print(f"could not measure {k}")
            return 1

    found = 0
    wrong = []
    for page in PAGES:
        text = page.read_text()
        for name, raw in CLAIM.findall(text):
            found += 1
            claimed = int(raw.replace(",", ""))
            if name not in measured:
                wrong.append(f"{page.name}: unknown claim {name!r}")
            elif claimed != measured[name]:
                wrong.append(
                    f"{page.name}: claims {claimed} for {name}, tools report {measured[name]}"
                )

    # A guard that silently matches nothing is the defect it was written to prevent.
    if found == 0:
        print("no data-claim markers found in web/*.html: the guard is checking nothing")
        return 1

    print(f"measured: {measured['forge-tests']} tests, {measured['mutations']} mutations")
    if wrong:
        print(f"\n{len(wrong)} stale claim(s):")
        for w in wrong:
            print(f"  - {w}")
        return 1
    print(f"all {found} marked claims on the site match the tools")
    return 0


if __name__ == "__main__":
    sys.exit(main())
