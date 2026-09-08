#!/usr/bin/env bash
# Demo A — 双网页方案 (two-website version)
# Starts the Kitbash bench + live-view relay if they are not already running,
# then opens both pages side by side in the browser.
#
#   ./demo_two_sites.sh            # bench + live viewer (pure two-site demo)
#   ./demo_two_sites.sh aristos    # bench + ARISTOS frontend (5173) instead
set -u
cd "$(dirname "$0")"

up() { curl -s -o /dev/null -m 1 "$1"; }

up http://127.0.0.1:8124/state.json || { nohup python3 monitor.py >/dev/null 2>&1 & sleep 0.5; }
up http://127.0.0.1:8123/index.html || { nohup python3 serve.py   >/dev/null 2>&1 & sleep 0.5; }

BENCH="http://127.0.0.1:8123/index.html?share=1"   # auto-starts sharing
VIEWER="http://127.0.0.1:8124/"                    # live view (Pop out = PiP float window)
ARISTOS="http://localhost:5173/aristos/demo"   # must be localhost: backend CORS allows http://localhost:5173 only

OPEN=${BROWSER:-firefox}
if [ "${1:-}" = "aristos" ]; then
  "$OPEN" "$BENCH" "$ARISTOS" >/dev/null 2>&1 &
else
  "$OPEN" "$BENCH" "$VIEWER" >/dev/null 2>&1 &
fi

echo "Opened:"
echo "  bench   $BENCH"
[ "${1:-}" = "aristos" ] && echo "  aristos $ARISTOS" || echo "  viewer  $VIEWER  (Pop out → floating always-on-top mini window)"
echo "Tip: snap the two windows with Super+Left / Super+Right, or use the viewer's Pop out (PiP) so the mini window floats over any app."
