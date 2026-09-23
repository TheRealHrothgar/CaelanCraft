#!/usr/bin/env bash
# Headless smoke test using the Windows-side Chrome from WSL2.
# Usage: scripts/smoke-windows-chrome.sh [url]
# Default URL targets a running `npm run preview` (port 4173) or `npm run dev` (5173) if PORT is set.
set -uo pipefail
CHROME="${CHROME:-/mnt/c/Program Files/Google/Chrome/Application/chrome.exe}"
PORT="${PORT:-4173}"
URL="${1:-http://localhost:${PORT}/?seed=1&rd=3&smoke=1&nosave=1&autoplay=1}"
SHOT_WIN="C:\\Users\\Public\\caelancraft-smoke.png"
SHOT_WSL="/mnt/c/Users/Public/caelancraft-smoke.png"
BUDGET="${BUDGET:-25000}"

if [ ! -x "$CHROME" ]; then echo "Chrome not found at $CHROME" >&2; exit 2; fi
rm -f "$SHOT_WSL"
echo "Smoke: $URL"
OUT=$(timeout 120 "$CHROME" --headless=new --no-first-run --no-default-browser-check \
  --window-size=1280,720 --virtual-time-budget="$BUDGET" --enable-logging=stderr --v=0 \
  --screenshot="$SHOT_WIN" "$URL" 2>&1)
echo "$OUT" | grep -E 'SMOKE_|CONSOLE.*(Error|error|Uncaught)' | sed 's/^.*CONSOLE[^"]*//' | head -40
if echo "$OUT" | grep -q 'SMOKE_OK'; then
  echo "RESULT: SMOKE_OK  (screenshot: $SHOT_WSL)"; exit 0
else
  echo "RESULT: SMOKE_FAIL (screenshot: $SHOT_WSL)"; exit 1
fi
