#!/usr/bin/env bash
# Run the MCP 2026-07-28 conformance requirement set against the real /mcp app
# (scripts/conformance-server.ts, fake data) and compare with conformance-baseline.yml.
# Exit 0 = no regressions and no stale baseline entries.
#
# The conformance CLI needs Node >= 22. The server itself runs on Node 20.
# Set NODE22_BIN to a Node 22 bin dir, or have node >= 22 on PATH.
set -euo pipefail
cd "$(dirname "$0")/.."

CONFORMANCE_VERSION="0.2.0-alpha.11"
PORT="${CONFORMANCE_PORT:-8797}"
NODE22_BIN="${NODE22_BIN:-}"
OUT="${CONFORMANCE_OUT:-$(mktemp -d)}"

if [ -x "$NODE22_BIN/node" ]; then CONF_PATH="$NODE22_BIN:$PATH"; else CONF_PATH="$PATH"; fi
major=$(PATH="$CONF_PATH" node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 22 ]; then
  echo "conformance: needs Node >= 22 for the conformance CLI (found $major). Set NODE22_BIN." >&2
  exit 2
fi

# setsid: tsx forks a child node process; kill the whole group on exit.
PORT="$PORT" setsid ./node_modules/.bin/tsx scripts/conformance-server.ts &
SERVER_PID=$!
trap 'kill -- "-$SERVER_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/healthz" && break
  sleep 0.2
done

PATH="$CONF_PATH" npx -y "@modelcontextprotocol/conformance@$CONFORMANCE_VERSION" server \
  --url "http://127.0.0.1:$PORT/mcp" \
  --requirements 2026-07-28 \
  --expected-failures conformance-baseline.yml \
  -o "$OUT"
