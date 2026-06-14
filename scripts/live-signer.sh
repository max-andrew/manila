#!/usr/bin/env bash
# Judge mode: make the DEPLOYED site able to seal real payments.
#
# The Dynamic MPC signer runs locally (native binary, can't run on Workers).
# This brings up the sidecar + a Cloudflare quick tunnel and points the
# deployed Worker's SIGNER_SIDECAR_URL at it. The sidecar stays protected by
# the shared secret (anyone hitting the tunnel without it gets 401), and a
# quick tunnel needs no Cloudflare login — no credentials are exposed.
#
# Run during judging; Ctrl+C to stop (the site falls back to read-only +
# the approval demo, which need no sidecar). Usage: bash scripts/judge-mode.sh
set -euo pipefail
cd "$(dirname "$0")/.."

WORKER_URL="https://manila.maxwellandrew.com"
SECRET=$(grep '^SIGNER_SIDECAR_SECRET=' .dev.vars | cut -d= -f2)

# 1. sidecar (Dynamic MPC signer) — restart fresh so the Dynamic token is new
pkill -f "sidecar/server.mjs" 2>/dev/null || true; sleep 1
echo "starting signing sidecar…"
nohup node sidecar/server.mjs >/tmp/manila-sidecar.log 2>&1 &
for _ in $(seq 1 30); do curl -s -m 2 -H "x-sidecar-secret: $SECRET" http://localhost:8901/health >/dev/null 2>&1 && break; sleep 1; done
echo "sidecar: $(curl -s -H "x-sidecar-secret: $SECRET" http://localhost:8901/health)"

# 2. cloudflare quick tunnel → the sidecar
echo "opening cloudflare tunnel…"
: > /tmp/manila-tunnel.log
cloudflared tunnel --url http://localhost:8901 >/tmp/manila-tunnel.log 2>&1 &
TUNNEL_PID=$!
trap 'kill $TUNNEL_PID 2>/dev/null || true' EXIT
URL=""
for _ in $(seq 1 40); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/manila-tunnel.log | head -1 || true)
  [ -n "$URL" ] && break; sleep 1
done
[ -z "$URL" ] && { echo "tunnel URL not found — see /tmp/manila-tunnel.log"; exit 1; }
echo "tunnel: $URL"

# 3. point the deployed Worker at the tunnel (URL is not secret; this is the mechanism)
printf '%s' "$URL" | npx wrangler secret put SIGNER_SIDECAR_URL >/dev/null 2>&1
echo "deployed Worker now signs via the tunnel."

# 4. verify
sleep 4
curl -s "$WORKER_URL/api/status" | python3 -c "import sys,json;d=json.load(sys.stdin);print('status: m1_ready=%s sidecar_reachable=%s' % (d['m1_ready'], d['sidecar'].get('reachable')))" || true

echo
echo "JUDGE MODE LIVE — $WORKER_URL can now seal real payments on Arc."
echo "Keep this terminal open during judging. Ctrl+C to stop."
wait $TUNNEL_PID
