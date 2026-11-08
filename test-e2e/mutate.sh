#!/usr/bin/env bash
# Reintroduce each defect this suite exists to catch, and confirm a named test fails.
#
# A passing browser suite proves nothing on its own. Every defect below shipped past a
# green `npm test`, and three of the guards written earlier in this project reported
# clean against the exact bug they were written for until they were mutation-tested. So
# the suite gets the same treatment it imposes on everything else.
#
# Run from the repo root:  bash test-e2e/mutate.sh
set -uo pipefail
cd "$(dirname "$0")/.."

PW="${PW_CHANNEL:-}"
TMP="$(mktemp -d)"
TOUCHED=()

# Restore by PATH, not by dumping every backup into the working directory. The first
# version did `cp "$TMP"/*.bak .`, which left web_ui.js.bak and friends in the repo root
# and restored nothing.
restore_all() {
  for f in "${TOUCHED[@]:-}"; do
    [ -n "$f" ] && cp "$TMP/$(echo "$f" | tr / _).bak" "$f" 2>/dev/null
  done
  rm -rf "$TMP"
}
trap restore_all EXIT

backup() { cp "$1" "$TMP/$(echo "$1" | tr / _).bak"; TOUCHED+=("$1"); }
restore() { cp "$TMP/$(echo "$1" | tr / _).bak" "$1"; }

fail_count=0
survived=()

# $1 label, $2 file, $3 test name filter, $4 python edit
check() {
  local label="$1" file="$2" filter="$3" edit="$4"
  backup "$file"
  if ! python3 -I -c "$edit"; then
    echo "  SKIP  $label (pattern not found, mutation is stale)"
    survived+=("$label (stale)")
    restore "$file"; return
  fi
  pkill -f anvil >/dev/null 2>&1; pkill -f "test-e2e/serve" >/dev/null 2>&1; sleep 1
  if PW_CHANNEL="$PW" npx playwright test -g "$filter" --reporter=line >"$TMP/out" 2>&1; then
    echo "  SURVIVED  $label  <-- the suite did not notice"
    survived+=("$label (survived)")
  else
    echo "  caught    $label"
  fi
  restore "$file"
}

echo "mutating the page, one defect at a time"
echo

check "ui.js: emlText undeclared again" web/ui.js "opens the settle gate" '
import pathlib,sys
p=pathlib.Path("web/ui.js"); s=p.read_text()
old="let emlText = null;\n"
if old not in s: sys.exit(1)
p.write_text(s.replace(old,"",1))
sys.exit(0)'

check "ui.js: nothing enables the settle button" web/ui.js "opens the settle gate" '
import pathlib,sys
p=pathlib.Path("web/ui.js"); s=p.read_text()
old="  btn.disabled = why.length > 0;"
if old not in s: sys.exit(1)
p.write_text(s.replace(old,"  btn.disabled = true;",1))
sys.exit(0)'

check "app.js: fieldHash re-exported but not imported" web/app.js "locking succeeds" '
import pathlib,sys
p=pathlib.Path("web/app.js"); s=p.read_text()
old="import { fieldHash, FIELD_MASK } from \"./hash.js\";\nexport { fieldHash, FIELD_MASK };"
new="export { fieldHash, FIELD_MASK } from \"./hash.js\";"
if old not in s: sys.exit(1)
p.write_text(s.replace(old,new,1))
sys.exit(0)'

check "app.js: receipt status unchecked" web/app.js "refused refund" '
import pathlib,sys
p=pathlib.Path("web/app.js"); s=p.read_text()
old="  if (receipt.status !== \"success\") {"
if old not in s: sys.exit(1)
p.write_text(s.replace(old,"  if (false) {",1))
sys.exit(0)'

check "style.css: light palette only under the media query" web/style.css "changes the colours" '
import pathlib,re,sys
p=pathlib.Path("web/style.css"); s=p.read_text()
m=re.search(r"\n:root\[data-theme=\"light\"\] \{[\s\S]*?\n\}\n", s)
if not m: sys.exit(1)
p.write_text(s.replace(m.group(0),"\n",1))
sys.exit(0)'

check "ui.js: expiry from the browser clock" web/ui.js "USDC comes back" '
import pathlib,sys
p=pathlib.Path("web/ui.js"); s=p.read_text()
old="        now = Number((await publicClient.getBlock()).timestamp);"
if old not in s: sys.exit(1)
p.write_text(s.replace(old,"        now = Date.now() / 1000;",1))
sys.exit(0)'

check "ui.js: Recent trades never refreshes after a lock" web/ui.js "Recent trades" '
import pathlib,sys
p=pathlib.Path("web/ui.js"); s=p.read_text()
old="      renderRecent();\n"
if old not in s: sys.exit(1)
p.write_text(s.replace(old,"",1))
sys.exit(0)'

echo
if [ ${#survived[@]} -gt 0 ]; then
  echo "${#survived[@]} mutation(s) not caught:"
  for m in "${survived[@]}"; do echo "  - $m"; done
  exit 1
fi
echo "every mutation caught: the suite can fail"
