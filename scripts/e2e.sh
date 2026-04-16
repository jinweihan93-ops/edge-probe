#!/usr/bin/env bash
# e2e.sh — end-to-end smoke: SDK wire shape ↔ backend contract.
#
# 1. Start the Bun backend on a random port
# 2. POST an IngestPayload shaped like the one EdgeProbe.trace() emits
# 3. POST /app/trace/:id/share to mint a signed share token
# 4. GET /r/<token> and assert no prompt/completion text in the public JSON
# 5. GET /r/<raw-traceId> returns 404 — raw ids cannot be used as tokens
# 6. GET /app/trace/:id with the right org and assert we DO see content
# 7. GET /app/trace/:id with a different org and assert 403 (not 404)
# 8. GET /app/trace/:id with an unknown id and assert 404
#
# This script is the cold-start contract check. The Swift unit tests in
# ios/Tests use URLProtocol mocks; this one talks to the real server.
# Run before pushing any change that touches the wire format.

set -euo pipefail

# ---- paths ----
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"
PORT="${PORT:-38271}"
BASE="http://127.0.0.1:$PORT"

# The backend refuses to boot without this. In prod it must be a real random
# secret (`openssl rand -hex 32`). For the e2e smoke we just need something
# ≥32 chars that matches between server and any off-band signing we do.
export SHARE_TOKEN_SECRET="${SHARE_TOKEN_SECRET:-e2e-test-secret-do-not-use-in-prod-xxxxxxxxxxxxxxxx}"

cd "$BACKEND_DIR"

# ---- start backend ----
echo "[e2e] starting backend on :$PORT"
PORT="$PORT" SHARE_TOKEN_SECRET="$SHARE_TOKEN_SECRET" \
  bun run start >/tmp/edgeprobe-e2e-server.log 2>&1 &
SERVER_PID=$!
trap 'echo "[e2e] killing backend ($SERVER_PID)"; kill "$SERVER_PID" 2>/dev/null || true' EXIT

# wait for /healthz (up to 10s)
for i in $(seq 1 50); do
  if curl -fsS "$BASE/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.2
  if [ "$i" -eq 50 ]; then
    echo "[e2e] backend didn't come up in 10s; log:" >&2
    cat /tmp/edgeprobe-e2e-server.log >&2
    exit 1
  fi
done

echo "[e2e] backend up"

# ---- payload (the shape EdgeProbe.trace() emits) ----
TRACE_ID="trace_e2e_$(date +%s)"
read -r -d '' PAYLOAD <<JSON || true
{
  "trace": {
    "id": "$TRACE_ID",
    "orgId": "org_acme",
    "projectId": "proj_voice",
    "sessionId": null,
    "startedAt": "2026-04-15T12:00:00.000Z",
    "endedAt":   "2026-04-15T12:00:00.600Z",
    "device": { "device.os": "iOS", "sdk.version": "0.0.1" },
    "attributes": {},
    "sensitive": false
  },
  "spans": [
    {
      "id": "span_001",
      "traceId": "$TRACE_ID",
      "parentSpanId": null,
      "name": "llama-decode",
      "kind": "llm",
      "startedAt": "2026-04-15T12:00:00.000Z",
      "endedAt":   "2026-04-15T12:00:00.600Z",
      "durationMs": 600,
      "status": "ok",
      "attributes": { "gen_ai.request.model": "llama-3.2-3b-q4" },
      "includeContent": true,
      "promptText":     "THIS IS THE SECRET USER PROMPT",
      "completionText": "THIS IS THE SECRET COMPLETION",
      "transcriptText": null
    }
  ]
}
JSON

# ---- 1. POST /ingest ----
echo "[e2e] POST /ingest"
INGEST_STATUS=$(curl -sS -o /tmp/edgeprobe-ingest.json -w "%{http_code}" \
  -X POST "$BASE/ingest" \
  -H "Authorization: Bearer epk_pub_e2e_key" \
  -H "Content-Type: application/json" \
  --data-binary "$PAYLOAD")
if [ "$INGEST_STATUS" != "202" ]; then
  echo "[e2e] FAIL: /ingest returned $INGEST_STATUS, expected 202" >&2
  cat /tmp/edgeprobe-ingest.json >&2
  exit 1
fi
echo "[e2e]   → 202 accepted"

# ---- 2. Mint a share token ----
# The owning org (org_acme) POSTs to /app/trace/$TRACE_ID/share and gets back
# a signed token. Without this step, nobody can turn a trace id into a
# working /r/:token URL.
echo "[e2e] POST /app/trace/$TRACE_ID/share"
SHARE_RESP=$(curl -sS -X POST "$BASE/app/trace/$TRACE_ID/share" \
  -H "X-Org-Id: org_acme" \
  -H "Content-Type: application/json" \
  --data '{}')
SHARE_TOKEN=$(echo "$SHARE_RESP" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
if [ -z "$SHARE_TOKEN" ]; then
  echo "[e2e] FAIL: could not parse token from share response: $SHARE_RESP" >&2
  exit 1
fi
echo "[e2e]   → token minted (length=${#SHARE_TOKEN})"

# ---- 3. GET /r/<token> — public, must not contain the secret strings ----
echo "[e2e] GET /r/<token>"
curl -fsS "$BASE/r/$SHARE_TOKEN" > /tmp/edgeprobe-public.json
if grep -q "SECRET USER PROMPT" /tmp/edgeprobe-public.json; then
  echo "[e2e] FAIL: public JSON contains prompt text — PII BOUNDARY BREACH" >&2
  cat /tmp/edgeprobe-public.json >&2
  exit 1
fi
if grep -q "SECRET COMPLETION" /tmp/edgeprobe-public.json; then
  echo "[e2e] FAIL: public JSON contains completion text — PII BOUNDARY BREACH" >&2
  cat /tmp/edgeprobe-public.json >&2
  exit 1
fi
echo "[e2e]   → public JSON has no prompt/completion text ✓"

# ---- 4. GET /r/<raw-traceId> must return 404 — raw ids are not tokens ----
echo "[e2e] GET /r/$TRACE_ID (raw trace id, not a token)"
RAW_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" "$BASE/r/$TRACE_ID")
if [ "$RAW_STATUS" != "404" ]; then
  echo "[e2e] FAIL: raw trace id returned $RAW_STATUS, expected 404" >&2
  echo "[e2e] This means /r/:token is accepting unsigned input — SHARE TOKEN BYPASS" >&2
  exit 1
fi
echo "[e2e]   → raw trace id returns 404 ✓"

# ---- 5. GET /app/trace/:id with the right org — content should be present ----
echo "[e2e] GET /app/trace/$TRACE_ID (correct org)"
curl -fsS -H "X-Org-Id: org_acme" "$BASE/app/trace/$TRACE_ID" > /tmp/edgeprobe-private.json
if ! grep -q "SECRET USER PROMPT" /tmp/edgeprobe-private.json; then
  echo "[e2e] FAIL: auth'd JSON is missing opted-in prompt text" >&2
  cat /tmp/edgeprobe-private.json >&2
  exit 1
fi
echo "[e2e]   → auth'd JSON contains opted-in content ✓"

# ---- 6. GET /app/trace/:id with the wrong org — must be 403, not 404 ----
echo "[e2e] GET /app/trace/$TRACE_ID (wrong org)"
WRONG_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "X-Org-Id: org_competitor" "$BASE/app/trace/$TRACE_ID")
if [ "$WRONG_STATUS" != "403" ]; then
  echo "[e2e] FAIL: cross-org scan returned $WRONG_STATUS, expected 403" >&2
  echo "[e2e] A 404 here would leak existence. A 200 would leak content." >&2
  exit 1
fi
echo "[e2e]   → cross-org returns 403 ✓"

# ---- 7. GET /app/trace/unknown_id with any org — must be 404 ----
echo "[e2e] GET /app/trace/never_existed_$RANDOM"
NOT_FOUND_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "X-Org-Id: org_acme" "$BASE/app/trace/never_existed_$RANDOM")
if [ "$NOT_FOUND_STATUS" != "404" ]; then
  echo "[e2e] FAIL: missing trace returned $NOT_FOUND_STATUS, expected 404" >&2
  exit 1
fi
echo "[e2e]   → missing trace returns 404 ✓"

echo
echo "[e2e] ALL CHECKS PASSED — SDK↔backend contract holds, PII boundary enforced, share tokens required"
