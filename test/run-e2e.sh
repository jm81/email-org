#!/bin/bash
# Self-contained browser e2e: fresh dovecot + seed + app server, then drives
# the UI with headless Chrome (test/e2e.js).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"

"$HERE/start-dovecot.sh"
node "$HERE/seed.js"

PORT=8399 EMAIL_ORG_DATA="$HERE/tmp/e2e-data" node "$ROOT/server.js" &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null; wait $SERVER_PID 2>/dev/null || true; "$HERE/stop-dovecot.sh"' EXIT
for i in $(seq 1 40); do
  curl -sf http://127.0.0.1:8399/api/accounts >/dev/null 2>&1 && break
  sleep 0.25
done

curl -sf -X POST http://127.0.0.1:8399/api/accounts \
  -H 'content-type: application/json' \
  -d '{"name":"Alice","host":"127.0.0.1","port":1143,"secure":false,"username":"alice","password":"alicepw"}' >/dev/null
curl -sf -X POST http://127.0.0.1:8399/api/accounts/1/sync >/dev/null

node "$HERE/e2e.js"
