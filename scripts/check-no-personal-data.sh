#!/usr/bin/env bash
#
# Fails if a real bank alert, or data lifted from one, is committed.
#
# This is not hypothetical. A real account holder's name reached docs/blueprint-spec.md
# and a balance reached CLAUDE.md, both quoted straight out of a fixture, and both were
# one `git push` from public.
#
# TWO WAYS THIS CHECK HAS ALREADY BEEN WRONG, both worth keeping in mind:
#
#   1. It failed on every push for a day because nobody looked at the result. It flagged
#      an illustrative "0123456789" and ten-digit timestamps inside vendored forge-std.
#      A guard that cries wolf every run is one everybody learns to ignore.
#
#   2. The fix used `mapfile`, which does not exist in bash 3.2 (macOS default). The file
#      list came out empty, every grep scanned nothing, and the script printed "clean"
#      with a real account number sitting in the tree. A check that scans zero files must
#      never report success, so it now counts them and fails if there are none.
#
# Run it:          bash scripts/check-no-personal-data.sh
# Prove it bites:  SELFTEST=1 bash scripts/check-no-personal-data.sh

set -uo pipefail
cd "$(dirname "$0")/.."

fail() { echo "FAIL: $*" >&2; exit 1; }

LIST=$(mktemp)
trap 'rm -f "$LIST"' EXIT

# Our own source only. Vendored dependencies are not ours to police and are full of
# timestamps, hashes and PR links that look like anything you grep for.
# This script is excluded from its own scan. It necessarily contains the patterns it
# looks for, so scanning itself means flagging its own pattern list, which is what it did
# on two successive CI runs: first on the account number in its selftest, then on the
# names in its LEAKED grep. A scanner cannot be its own input.
#
# The cost is real and worth stating: nothing checks THIS file. If a genuine account
# number is ever pasted here it goes unnoticed, so it gets read by eye on review. The
# selftest's number is assembled from halves partly for that reason.
SELF="scripts/check-no-personal-data.sh"

git ls-files -z '*.md' '*.sol' '*.js' '*.mjs' '*.html' '*.json' '*.sh' \
  | tr '\0' '\n' \
  | grep -v '^contracts/lib/' \
  | grep -vxF "$SELF" > "$LIST"

COUNT=$(wc -l < "$LIST" | tr -d ' ')
if [ "$COUNT" -lt 5 ]; then
  fail "only $COUNT files to scan. The file list is broken, so a pass would mean nothing."
fi
echo "scanning $COUNT files"

scan() { # scan <extended-regex>  -> prints matches
  tr '\n' '\0' < "$LIST" | xargs -0 grep -nE "$1" 2>/dev/null
}
scan_i() {
  tr '\n' '\0' < "$LIST" | xargs -0 grep -niE "$1" 2>/dev/null
}

# ---------------------------------------------------------------- raw alert files
if git ls-files | grep -iE '\.eml$'; then
  fail "a .eml is committed. Real alerts carry a name, account number and balance."
fi

# ---------------------------------------------------------------- account numbers
#
# A Nigerian NUBAN is exactly ten digits. Excluded, because they are not account numbers:
#   - sequential or all-identical placeholders (0123456789, 0000000000)
#   - unix timestamps, which this codebase genuinely contains (15xxxxxxxx-19xxxxxxxx)
#   - anything inside a longer digit run, which is some other identifier
ACCT=$(scan '(^|[^0-9])[0-9]{10}([^0-9]|$)' \
       | grep -vE '0123456789|1234567890|9876543210' \
       | grep -vE '([0-9])\1{9}' \
       | grep -vE '(^|[^0-9])1[5-9][0-9]{8}([^0-9]|$)')

# ---------------------------------------------------------------- names from fixtures
LEAKED=$(scan_i 'OMOBOLANLE|FABUNMI|AKINSOLA|OYEMOLADE|OKESANYA|OYERINDE')

if [ -n "${SELFTEST:-}" ]; then
  # A guard is only worth its green tick if it can still go red. Plant the account
  # number that was genuinely at risk and confirm the live pipeline catches it.
  # The number is assembled from halves on purpose. Written as one literal it is a real
  # ten-digit account number sitting in a tracked .sh file, and this guard scans .sh
  # files, so it flagged itself and failed CI. It passed locally only because the script
  # was not yet tracked when it ran. Neither half is ten digits, so nothing matches.
  HALF_A=606956
  HALF_B=9383
  PLANTED="${HALF_A}${HALF_B}"

  PLANT=".selftest-leak.md"
  echo "account $PLANTED belonging to a real person" > "$PLANT"
  echo "$PLANT" >> "$LIST"
  HIT=$(scan '(^|[^0-9])[0-9]{10}([^0-9]|$)' \
        | grep -vE '0123456789|1234567890|9876543210' \
        | grep -vE '([0-9])\1{9}' \
        | grep -vE '(^|[^0-9])1[5-9][0-9]{8}([^0-9]|$)')
  rm -f "$PLANT"
  if echo "$HIT" | grep -q "$PLANTED"; then
    echo "selftest: a planted account number IS caught"
  else
    fail "selftest: a planted account number was NOT caught. This guard protects nothing."
  fi
fi

if [ -n "$ACCT" ]; then
  echo "$ACCT" >&2
  fail "a ten-digit number that looks like a Nigerian account number is committed."
fi

if [ -n "$LEAKED" ]; then
  echo "$LEAKED" >&2
  fail "an account holder's or counterparty's name from a fixture is committed."
fi

echo "clean: no bank alerts, account numbers, or fixture names committed"
