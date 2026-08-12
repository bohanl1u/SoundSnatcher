#!/usr/bin/env bash
#
# Puts the live demo online: opens a Cloudflare quick tunnel, points the landing
# page at it, and runs the server with the public guardrails switched on.
#
#   ./scripts/serve-public.sh
#
# Ctrl-C tears the tunnel down and marks the demo offline again, so the landing
# page hides the section rather than showing a dead embed.
#
# A quick tunnel gets a fresh hostname every run, which is why the address lives
# in docs/demo.json instead of in the page's JavaScript — only that one file has
# to change.

set -euo pipefail

PORT="${PORT:-4747}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The tool lives in its own repository; this one only holds the website.
APP_DIR="${APP_DIR:-$(cd "$DIR/.." && pwd)/soundsnatcher-app}"
CONFIG="$DIR/docs/demo.json"
LOG="$(mktemp -t soundsnatcher-tunnel)"

SERVER_PID=""
TUNNEL_PID=""

publish() {
  printf '{\n  "origin": "%s"\n}\n' "$1" > "$CONFIG"
  git -C "$DIR" add docs/demo.json >/dev/null 2>&1 || return 0
  git -C "$DIR" diff --cached --quiet docs/demo.json && return 0
  git -C "$DIR" commit -q -m "${2:-Update demo origin}" >/dev/null 2>&1 || true
  git -C "$DIR" push -q origin main >/dev/null 2>&1 \
    && echo "  pushed — the landing page will pick it up shortly" \
    || echo "  ! could not push; run 'git push' yourself"
}

cleanup() {
  echo
  echo "Shutting down..."
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  echo "  marking the demo offline"
  publish "" "Demo offline"
  rm -f "$LOG"
  echo "Done."
}
trap cleanup EXIT INT TERM

command -v cloudflared >/dev/null || { echo "cloudflared not found. brew install cloudflared"; exit 1; }
[ -f "$APP_DIR/server.js" ] || {
  echo "Cannot find the tool at: $APP_DIR"
  echo "Clone it next to this repo, or set APP_DIR:"
  echo "  git clone https://github.com/bohanl1u/soundsnatcher-app.git"
  exit 1
}

# Bound to loopback deliberately. The tunnel is the only way in, which is what
# makes TRUST_PROXY safe — otherwise anyone on the LAN could send a forged
# CF-Connecting-IP header and hand themselves a fresh rate-limit bucket.
echo "Starting SoundSnatcher (public mode) on 127.0.0.1:$PORT"
HOST=127.0.0.1 PORT="$PORT" PUBLIC_MODE=true TRUST_PROXY=true \
  node "$APP_DIR/server.js" &
SERVER_PID=$!
sleep 2

kill -0 "$SERVER_PID" 2>/dev/null || { echo "Server failed to start."; exit 1; }

echo "Opening Cloudflare tunnel..."
cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" > "$LOG" 2>&1 &
TUNNEL_PID=$!

URL=""
for _ in $(seq 1 45); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)"
  [ -n "$URL" ] && break
  kill -0 "$TUNNEL_PID" 2>/dev/null || { echo "Tunnel exited:"; tail -20 "$LOG"; exit 1; }
  sleep 1
done

[ -n "$URL" ] || { echo "Timed out waiting for a tunnel URL:"; tail -20 "$LOG"; exit 1; }

echo
echo "  Demo URL: $URL"
publish "$URL" "Demo online"
echo
echo "  Landing page: https://bohanl1u.github.io/SoundSnatcher/"
echo "  Limits: 3 snatches/min per IP, 2 concurrent, 20 min max per video"
echo
echo "Leave this running. Ctrl-C takes the demo offline."
wait "$SERVER_PID"
