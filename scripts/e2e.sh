#!/usr/bin/env bash
# e2e.sh — end-to-end smoke: SDK wire shape ↔ backend contract ↔ web dashboard.
#
# Backend checks:
# 1. Start the Bun backend on a random port. BOOTSTRAP_API_KEYS seeds a
#    known `epk_priv_` key so the script can bootstrap the admin surface.
# 2. Mint a fresh `epk_pub_` ingest key via `POST /app/keys` (priv bearer).
#    Pre-Slice-5 the e2e hardcoded `epk_pub_e2e_key`, but /ingest now
#    actually authenticates — the bearer must exist in `api_keys`.
# 3. POST an IngestPayload shaped like the one EdgeProbe.trace() emits,
#    using the minted pub key.
# 4. POST /app/trace/:id/share to mint a signed share token
# 5. GET /r/<token> and assert no prompt/completion text in the public JSON
# 6. GET /r/<raw-traceId> returns 404 — raw ids cannot be used as tokens
# 7. GET /app/trace/:id with the right org and assert we DO see content
# 8. GET /app/trace/:id with a different org and assert 403 (not 404)
# 9. GET /app/trace/:id with an unknown id and assert 404
# 10. Slice 5 admin surface: GET /app/keys lists metadata (no raw tokens),
#     pub bearer cannot mint (401), DELETE /app/keys/:id revokes,
#     subsequent /ingest with the revoked key returns 401, and
#     wrong-org-in-payload returns 401 explicitly.
#
# Web dashboard checks (HTML layer):
# 9. Start the web server pointing at the backend
# 10. GET web /r/<token> → 200 HTML, no prompt text in rendered body
# 11. GET web /r/<bogus> → 404 HTML (single page for all failure modes)
# 12. GET web /app/trace/:id?org=org_acme → 200 HTML, prompt text present
# 13. GET web /app/trace/:id?org=org_competitor → 403 HTML, prompt text absent
#
# This script is the cold-start contract check. The Swift unit tests in
# ios/Tests use URLProtocol mocks; this one talks to the real servers.
# Run before pushing any change that touches the wire format or the rendered HTML.

set -euo pipefail

# ---- paths ----
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"
WEB_DIR="$REPO_ROOT/web"
PORT="${PORT:-38271}"
WEB_PORT="${WEB_PORT:-38272}"
BASE="http://127.0.0.1:$PORT"
WEB_BASE="http://127.0.0.1:$WEB_PORT"

# The backend refuses to boot without this. In prod it must be a real random
# secret (`openssl rand -hex 32`). For the e2e smoke we just need something
# ≥32 chars that matches between server and any off-band signing we do.
export SHARE_TOKEN_SECRET="${SHARE_TOKEN_SECRET:-e2e-test-secret-do-not-use-in-prod-xxxxxxxxxxxxxxxx}"

# Dashboard-key auth. The bearer → orgId mapping is identical to
# src/auth.ts's TEST_DASHBOARD_KEY_* constants, so the in-tree unit tests
# and this live-backend smoke exercise the exact same wire shape. Dashboard
# keys are the legacy Slice-3 bootstrap surface; post-Slice-5 `epk_priv_`
# keys authenticate the same dashboard routes, but we keep DASHBOARD_KEYS
# wired up so the backwards-compat path stays covered here too.
DASH_KEY_ACME="epk_dash_acme_test_0000000000000000"
DASH_KEY_COMP="epk_dash_comp_test_0000000000000000"
export DASHBOARD_KEYS='{"'"$DASH_KEY_ACME"'":"org_acme","'"$DASH_KEY_COMP"'":"org_competitor"}'

# Slice 5 bootstrap: a known `epk_priv_` key seeded at boot so this script
# can exercise the /app/keys admin surface without a chicken-and-egg. In
# prod BOOTSTRAP_API_KEYS is set once when standing up a fresh DB; here we
# regenerate deterministically so the e2e run is hermetic. The id + secret
# fields are pure hex to match the parser contract in `src/apiKeys.ts`.
PRIV_KEY_ACME="epk_priv_acde012345_0123456789abcdef0123456789abcdef"
export BOOTSTRAP_API_KEYS='{"'"$PRIV_KEY_ACME"'":{"orgId":"org_acme","keyType":"priv","name":"e2e-bootstrap"}}'

cd "$BACKEND_DIR"

# ---- start backend ----
echo "[e2e] starting backend on :$PORT"
PORT="$PORT" SHARE_TOKEN_SECRET="$SHARE_TOKEN_SECRET" \
  bun run start >/tmp/edgeprobe-e2e-server.log 2>&1 &
SERVER_PID=$!
WEB_PID=""
cleanup() {
  if [ -n "$WEB_PID" ]; then
    echo "[e2e] killing web ($WEB_PID)"
    kill "$WEB_PID" 2>/dev/null || true
  fi
  echo "[e2e] killing backend ($SERVER_PID)"
  kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

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

# ---- 0. Mint a pub ingest key via the priv admin endpoint ----
# Pre-Slice-5 the e2e hardcoded `Bearer epk_pub_e2e_key` because /ingest
# didn't actually authenticate the bearer — it just parsed the prefix and
# took `trace.orgId` at face value. Post-Slice-5 the key must exist in
# `api_keys` (argon2id-hashed), so we mint here using the bootstrap priv
# key and use the returned raw token for every downstream /ingest call.
echo "[e2e] POST /app/keys (mint ingest pub)"
MINT_RESP=$(curl -sS -X POST "$BASE/app/keys" \
  -H "Authorization: Bearer $PRIV_KEY_ACME" \
  -H "Content-Type: application/json" \
  --data '{"keyType":"pub","name":"e2e-ingest"}')
# rawToken is the full `epk_pub_<id>_<secret>` tuple; id is the 10-hex short
# id we'll hand to DELETE /app/keys/:id later when we exercise revoke.
PUB_KEY_ACME=$(echo "$MINT_RESP" | sed -n 's/.*"rawToken":"\([^"]*\)".*/\1/p')
PUB_KEY_ID=$(echo "$MINT_RESP" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
if [ -z "$PUB_KEY_ACME" ] || [ -z "$PUB_KEY_ID" ]; then
  echo "[e2e] FAIL: could not parse mint response: $MINT_RESP" >&2
  exit 1
fi
echo "[e2e]   → pub key minted (id=$PUB_KEY_ID)"

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
  -H "Authorization: Bearer $PUB_KEY_ACME" \
  -H "Content-Type: application/json" \
  --data-binary "$PAYLOAD")
if [ "$INGEST_STATUS" != "202" ]; then
  echo "[e2e] FAIL: /ingest returned $INGEST_STATUS, expected 202" >&2
  cat /tmp/edgeprobe-ingest.json >&2
  exit 1
fi
echo "[e2e]   → 202 accepted"

# ---- 2. Mint a share token ----
# The owning org (org_acme) POSTs to /app/trace/$TRACE_ID/share with a
# dashboard bearer and gets back a signed token. Without this step, nobody
# can turn a trace id into a working /r/:token URL.
echo "[e2e] POST /app/trace/$TRACE_ID/share"
SHARE_RESP=$(curl -sS -X POST "$BASE/app/trace/$TRACE_ID/share" \
  -H "Authorization: Bearer $DASH_KEY_ACME" \
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

# ---- 3b. GET /og/<token>.png — must return a PNG with 200 ----
# Real OG unfurl path: Slack/Twitter scrape <meta property="og:image">.
# We don't validate pixels here — just PNG magic bytes + mimetype + status.
echo "[e2e] GET /og/<token>.png (backend)"
OG_STATUS=$(curl -sS -o /tmp/edgeprobe-og.png -w "%{http_code}" "$BASE/og/$SHARE_TOKEN.png")
if [ "$OG_STATUS" != "200" ]; then
  echo "[e2e] FAIL: /og/<valid>.png returned $OG_STATUS, expected 200" >&2
  exit 1
fi
OG_MAGIC=$(head -c 4 /tmp/edgeprobe-og.png | od -An -tx1 | tr -d ' ')
if [ "$OG_MAGIC" != "89504e47" ]; then
  echo "[e2e] FAIL: /og/<valid>.png is not a PNG (magic=$OG_MAGIC)" >&2
  exit 1
fi
echo "[e2e]   → OG PNG magic valid ✓"

# ---- 3c. GET /og/<bogus>.png — must return a branded PNG with 404 ----
echo "[e2e] GET /og/<bogus>.png (backend)"
OG_BAD_STATUS=$(curl -sS -o /tmp/edgeprobe-og-bad.png -w "%{http_code}" "$BASE/og/not-a-token.png")
if [ "$OG_BAD_STATUS" != "404" ]; then
  echo "[e2e] FAIL: /og/<bogus>.png returned $OG_BAD_STATUS, expected 404" >&2
  exit 1
fi
OG_BAD_MAGIC=$(head -c 4 /tmp/edgeprobe-og-bad.png | od -An -tx1 | tr -d ' ')
if [ "$OG_BAD_MAGIC" != "89504e47" ]; then
  echo "[e2e] FAIL: /og/<bogus>.png fallback is not a PNG (magic=$OG_BAD_MAGIC)" >&2
  exit 1
fi
echo "[e2e]   → OG fallback PNG on bogus token ✓"

# ---- 4. GET /r/<raw-traceId> must return 404 — raw ids are not tokens ----
echo "[e2e] GET /r/$TRACE_ID (raw trace id, not a token)"
RAW_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" "$BASE/r/$TRACE_ID")
if [ "$RAW_STATUS" != "404" ]; then
  echo "[e2e] FAIL: raw trace id returned $RAW_STATUS, expected 404" >&2
  echo "[e2e] This means /r/:token is accepting unsigned input — SHARE TOKEN BYPASS" >&2
  exit 1
fi
echo "[e2e]   → raw trace id returns 404 ✓"

# ---- 5. GET /app/trace/:id with the right org bearer — content present ----
echo "[e2e] GET /app/trace/$TRACE_ID (correct bearer)"
curl -fsS -H "Authorization: Bearer $DASH_KEY_ACME" \
  "$BASE/app/trace/$TRACE_ID" > /tmp/edgeprobe-private.json
if ! grep -q "SECRET USER PROMPT" /tmp/edgeprobe-private.json; then
  echo "[e2e] FAIL: auth'd JSON is missing opted-in prompt text" >&2
  cat /tmp/edgeprobe-private.json >&2
  exit 1
fi
echo "[e2e]   → auth'd JSON contains opted-in content ✓"

# ---- 6. GET /app/trace/:id with a foreign org's bearer — must be 403 ----
echo "[e2e] GET /app/trace/$TRACE_ID (wrong bearer)"
WRONG_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $DASH_KEY_COMP" "$BASE/app/trace/$TRACE_ID")
if [ "$WRONG_STATUS" != "403" ]; then
  echo "[e2e] FAIL: cross-org scan returned $WRONG_STATUS, expected 403" >&2
  echo "[e2e] A 404 here would leak existence. A 200 would leak content." >&2
  exit 1
fi
echo "[e2e]   → cross-org returns 403 ✓"

# ---- 6b. X-Org-Id header alone — must be 401 (regression guard) ----
# The old trust-on-first-sight header must never be accepted again.
echo "[e2e] GET /app/trace/$TRACE_ID with only X-Org-Id (no bearer)"
HEADER_ONLY_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "X-Org-Id: org_acme" "$BASE/app/trace/$TRACE_ID")
if [ "$HEADER_ONLY_STATUS" != "401" ]; then
  echo "[e2e] FAIL: X-Org-Id-only returned $HEADER_ONLY_STATUS, expected 401 (auth hole regression)" >&2
  exit 1
fi
echo "[e2e]   → bare X-Org-Id ignored, returns 401 ✓"

# ---- 6c. GET /app/projects (auth'd) — project roll-up carries our trace ----
echo "[e2e] GET /app/projects"
curl -fsS -H "Authorization: Bearer $DASH_KEY_ACME" \
  "$BASE/app/projects" > /tmp/edgeprobe-projects.json
if ! grep -q "proj_voice" /tmp/edgeprobe-projects.json; then
  echo "[e2e] FAIL: /app/projects didn't surface proj_voice" >&2
  cat /tmp/edgeprobe-projects.json >&2
  exit 1
fi
echo "[e2e]   → projects list carries proj_voice ✓"

# ---- 6d. GET /app/projects/proj_voice/traces (auth'd) — surfaces our trace id ----
echo "[e2e] GET /app/projects/proj_voice/traces"
curl -fsS -H "Authorization: Bearer $DASH_KEY_ACME" \
  "$BASE/app/projects/proj_voice/traces" > /tmp/edgeprobe-project-traces.json
if ! grep -q "$TRACE_ID" /tmp/edgeprobe-project-traces.json; then
  echo "[e2e] FAIL: /app/projects/proj_voice/traces didn't surface $TRACE_ID" >&2
  cat /tmp/edgeprobe-project-traces.json >&2
  exit 1
fi
# Content must NOT leak into the summary rows — only timings + model name + device.
if grep -q "SECRET USER PROMPT" /tmp/edgeprobe-project-traces.json; then
  echo "[e2e] FAIL: project-traces list carries prompt text — PII BOUNDARY BREACH" >&2
  exit 1
fi
echo "[e2e]   → project-traces list has our trace, no prompt text ✓"

# ---- 6e. Same endpoint with the wrong bearer — empty list, not content ----
echo "[e2e] GET /app/projects/proj_voice/traces (competitor bearer)"
curl -fsS -H "Authorization: Bearer $DASH_KEY_COMP" \
  "$BASE/app/projects/proj_voice/traces" > /tmp/edgeprobe-project-traces-cross.json
if grep -q "$TRACE_ID" /tmp/edgeprobe-project-traces-cross.json; then
  echo "[e2e] FAIL: cross-org project-traces returned acme's trace id — ISOLATION BREACH" >&2
  exit 1
fi
echo "[e2e]   → cross-org project-traces returns no acme data ✓"

# ---- 7. GET /app/trace/unknown_id with a valid bearer — must be 404 ----
echo "[e2e] GET /app/trace/never_existed_$RANDOM"
NOT_FOUND_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $DASH_KEY_ACME" "$BASE/app/trace/never_existed_$RANDOM")
if [ "$NOT_FOUND_STATUS" != "404" ]; then
  echo "[e2e] FAIL: missing trace returned $NOT_FOUND_STATUS, expected 404" >&2
  exit 1
fi
echo "[e2e]   → missing trace returns 404 ✓"

# ---- 7a. Ingest hardening — same payload again in the same minute must be deduped ----
# Slice 4: a replay storm returns 202 deduped=true and does NOT double-insert.
echo "[e2e] POST /ingest (replay — must be deduped)"
DEDUP_STATUS=$(curl -sS -o /tmp/edgeprobe-dedup.json -w "%{http_code}" \
  -X POST "$BASE/ingest" \
  -H "Authorization: Bearer $PUB_KEY_ACME" \
  -H "Content-Type: application/json" \
  --data-binary "$PAYLOAD")
if [ "$DEDUP_STATUS" != "202" ]; then
  echo "[e2e] FAIL: dedup replay returned $DEDUP_STATUS, expected 202" >&2
  cat /tmp/edgeprobe-dedup.json >&2
  exit 1
fi
if ! grep -q '"deduped":true' /tmp/edgeprobe-dedup.json; then
  echo "[e2e] FAIL: dedup replay did not flag deduped:true — replay would have double-stored" >&2
  cat /tmp/edgeprobe-dedup.json >&2
  exit 1
fi
echo "[e2e]   → replay ingest deduped ✓"

# ---- 7b. Oversize ingest returns 413 ----
# We build a trivially-oversize payload by padding the attributes bag. With
# Content-Length headered truthfully, the backend must reject before parse.
echo "[e2e] POST /ingest (oversize — must be 413)"
BIG_PAYLOAD='{"trace":{"id":"t_big","orgId":"org_acme","projectId":"p","sessionId":null,"startedAt":"2026-04-17T12:00:00Z","endedAt":null,"device":{},'
BIG_PAYLOAD="${BIG_PAYLOAD}\"attributes\":{\"pad\":\"$(printf 'x%.0s' $(seq 1 2000000))\"},\"sensitive\":false},\"spans\":[]}"
BIG_STATUS=$(printf '%s' "$BIG_PAYLOAD" | curl -sS -o /dev/null -w "%{http_code}" \
  -X POST "$BASE/ingest" \
  -H "Authorization: Bearer $PUB_KEY_ACME" \
  -H "Content-Type: application/json" \
  --data-binary @-)
if [ "$BIG_STATUS" != "413" ]; then
  echo "[e2e] FAIL: oversize /ingest returned $BIG_STATUS, expected 413 (size cap broken?)" >&2
  exit 1
fi
echo "[e2e]   → oversize /ingest → 413 ✓"

# ---- 7c. GET /metrics — Prometheus exposition, counters present ----
echo "[e2e] GET /metrics"
curl -fsS "$BASE/metrics" > /tmp/edgeprobe-metrics.txt
if ! grep -q "edgeprobe_spans_dropped_total" /tmp/edgeprobe-metrics.txt; then
  echo "[e2e] FAIL: /metrics missing edgeprobe_spans_dropped_total counter" >&2
  cat /tmp/edgeprobe-metrics.txt >&2
  exit 1
fi
if ! grep -q "edgeprobe_spans_ingested_total" /tmp/edgeprobe-metrics.txt; then
  echo "[e2e] FAIL: /metrics missing edgeprobe_spans_ingested_total counter" >&2
  exit 1
fi
# Dedup branch must have registered at least 1 drop after 7a.
if ! grep -E 'edgeprobe_spans_dropped_total\{reason="dedup"\} [1-9]' /tmp/edgeprobe-metrics.txt >/dev/null; then
  echo "[e2e] FAIL: /metrics shows no dedup drops after replay storm" >&2
  cat /tmp/edgeprobe-metrics.txt >&2
  exit 1
fi
# Size branch must have registered at least 1 drop after 7b.
if ! grep -E 'edgeprobe_spans_dropped_total\{reason="size"\} [1-9]' /tmp/edgeprobe-metrics.txt >/dev/null; then
  echo "[e2e] FAIL: /metrics shows no size drops after oversize post" >&2
  exit 1
fi
echo "[e2e]   → /metrics has dedup + size counters incremented ✓"

# ======================================================================
# Slice 5: /app/keys admin surface + wrong-org-in-payload guard.
# This block intentionally runs AFTER the happy-path ingest flow so we
# can use the same minted pub key to exercise revoke → 401. It runs
# BEFORE the web section so the web tests below are unaffected by any
# admin-surface side effects (they only touch dashboard read routes).
# ======================================================================

# ---- 8a. Wrong-org-in-payload — must be 401 ----
# The pub key we minted above is bound to org_acme. A payload that claims
# `trace.orgId = "org_competitor"` must be rejected — otherwise a leaked
# acme key could scribble into the competitor's dashboard.
echo "[e2e] POST /ingest with body.orgId=org_competitor (acme pub key — must 401)"
WRONGORG_TRACE="trace_wrongorg_$(date +%s)"
read -r -d '' WRONGORG_PAYLOAD <<JSON || true
{
  "trace": {
    "id": "$WRONGORG_TRACE",
    "orgId": "org_competitor",
    "projectId": "proj_voice",
    "sessionId": null,
    "startedAt": "2026-04-15T12:00:00.000Z",
    "endedAt":   "2026-04-15T12:00:00.200Z",
    "device": { "device.os": "iOS", "sdk.version": "0.0.1" },
    "attributes": {},
    "sensitive": false
  },
  "spans": []
}
JSON
WRONGORG_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
  -X POST "$BASE/ingest" \
  -H "Authorization: Bearer $PUB_KEY_ACME" \
  -H "Content-Type: application/json" \
  --data-binary "$WRONGORG_PAYLOAD")
if [ "$WRONGORG_STATUS" != "401" ]; then
  echo "[e2e] FAIL: wrong-org-in-payload returned $WRONGORG_STATUS, expected 401" >&2
  echo "[e2e] A 202 here would let a leaked pub key cross-post into another org." >&2
  exit 1
fi
echo "[e2e]   → wrong-org-in-payload → 401 ✓"

# The /metrics counter for org_mismatch must now be ≥1.
curl -fsS "$BASE/metrics" > /tmp/edgeprobe-metrics-slice5.txt
if ! grep -E 'edgeprobe_spans_dropped_total\{reason="org_mismatch"\} [1-9]' /tmp/edgeprobe-metrics-slice5.txt >/dev/null; then
  echo "[e2e] FAIL: /metrics missing org_mismatch drop counter" >&2
  cat /tmp/edgeprobe-metrics-slice5.txt >&2
  exit 1
fi
echo "[e2e]   → org_mismatch counter incremented ✓"

# ---- 8b. GET /app/keys (priv bearer) — lists metadata, no secret leak ----
echo "[e2e] GET /app/keys"
curl -fsS -H "Authorization: Bearer $PRIV_KEY_ACME" \
  "$BASE/app/keys" > /tmp/edgeprobe-keys-list.json
if ! grep -q "$PUB_KEY_ID" /tmp/edgeprobe-keys-list.json; then
  echo "[e2e] FAIL: /app/keys didn't list the minted pub key id $PUB_KEY_ID" >&2
  cat /tmp/edgeprobe-keys-list.json >&2
  exit 1
fi
# Must not leak the raw token or the stored hash. A compromised dashboard
# session is bad, but it should NOT be a way to extract live bearer tokens.
if grep -q '"rawToken"' /tmp/edgeprobe-keys-list.json; then
  echo "[e2e] FAIL: /app/keys leaked rawToken field" >&2
  exit 1
fi
if grep -q '"keyHash"' /tmp/edgeprobe-keys-list.json; then
  echo "[e2e] FAIL: /app/keys leaked keyHash field" >&2
  exit 1
fi
# The raw-token shape itself must not appear in the response either, even
# under a different key name. Defense in depth against future regressions.
if grep -qE 'epk_(pub|priv)_[0-9a-f]{10}_[0-9a-f]{32}' /tmp/edgeprobe-keys-list.json; then
  echo "[e2e] FAIL: /app/keys response contains a raw-token-shaped string" >&2
  exit 1
fi
echo "[e2e]   → /app/keys lists metadata, no raw token / hash leaked ✓"

# ---- 8c. POST /app/keys with a pub bearer — must 401 ----
# Critical: `epk_pub_` tokens ship in the app bundle. They must NEVER be
# able to mint new keys, even inside their own org.
echo "[e2e] POST /app/keys with pub bearer (must 401)"
PUB_MINT_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
  -X POST "$BASE/app/keys" \
  -H "Authorization: Bearer $PUB_KEY_ACME" \
  -H "Content-Type: application/json" \
  --data '{"keyType":"pub","name":"should-fail"}')
if [ "$PUB_MINT_STATUS" != "401" ]; then
  echo "[e2e] FAIL: pub-bearer mint returned $PUB_MINT_STATUS, expected 401" >&2
  echo "[e2e] A 201 here would let a leaked pub key clone itself indefinitely." >&2
  exit 1
fi
echo "[e2e]   → pub bearer cannot mint → 401 ✓"

# ---- 8d. DELETE /app/keys/:id — revoke the minted pub key ----
echo "[e2e] DELETE /app/keys/$PUB_KEY_ID"
REVOKE_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
  -X DELETE "$BASE/app/keys/$PUB_KEY_ID" \
  -H "Authorization: Bearer $PRIV_KEY_ACME")
if [ "$REVOKE_STATUS" != "204" ]; then
  echo "[e2e] FAIL: revoke returned $REVOKE_STATUS, expected 204" >&2
  exit 1
fi
echo "[e2e]   → revoke → 204 ✓"

# A second revoke on the same id must collapse to 404 — same response as
# "that id doesn't exist at all" to avoid leaking anything about id space.
echo "[e2e] DELETE /app/keys/$PUB_KEY_ID (already revoked)"
DOUBLE_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
  -X DELETE "$BASE/app/keys/$PUB_KEY_ID" \
  -H "Authorization: Bearer $PRIV_KEY_ACME")
if [ "$DOUBLE_STATUS" != "404" ]; then
  echo "[e2e] FAIL: double-revoke returned $DOUBLE_STATUS, expected 404" >&2
  exit 1
fi
echo "[e2e]   → double-revoke → 404 ✓"

# ---- 8e. /ingest with the revoked pub key — must be 401 ----
# The load-bearing Slice 5 gate. Before this point the pub key worked; after
# DELETE it must stop working, on the SAME backend process, without restart.
echo "[e2e] POST /ingest with revoked pub key (must 401)"
POSTREV_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
  -X POST "$BASE/ingest" \
  -H "Authorization: Bearer $PUB_KEY_ACME" \
  -H "Content-Type: application/json" \
  --data-binary "$PAYLOAD")
if [ "$POSTREV_STATUS" != "401" ]; then
  echo "[e2e] FAIL: post-revoke ingest returned $POSTREV_STATUS, expected 401" >&2
  echo "[e2e] A 202 here would mean key revocation is lost — KEY ROTATION BROKEN" >&2
  exit 1
fi
echo "[e2e]   → post-revoke ingest → 401 ✓"

# ======================================================================
# Web dashboard: same checks, against the rendered HTML surface.
# Starts a second process pointing at the backend we just exercised.
# ======================================================================

echo
echo "[e2e] starting web dashboard on :$WEB_PORT (backend=$BASE)"
cd "$WEB_DIR"
# ORG_BEARERS is what the web process uses to resolve ?org=foo → bearer.
# Without this the web side of the e2e sees every /app/trace/:id as
# "no bearer for this org" and returns 401.
ORG_BEARERS_JSON='{"org_acme":"'"$DASH_KEY_ACME"'","org_competitor":"'"$DASH_KEY_COMP"'"}'
PORT="$WEB_PORT" BACKEND_URL="$BASE" ORG_BEARERS="$ORG_BEARERS_JSON" \
  bun run start >/tmp/edgeprobe-e2e-web.log 2>&1 &
WEB_PID=$!

for i in $(seq 1 50); do
  if curl -fsS "$WEB_BASE/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.2
  if [ "$i" -eq 50 ]; then
    echo "[e2e] web didn't come up in 10s; log:" >&2
    cat /tmp/edgeprobe-e2e-web.log >&2
    exit 1
  fi
done
echo "[e2e] web up"

# ---- 9. GET web /r/<token> — must render HTML, must not contain prompts ----
echo "[e2e] GET $WEB_BASE/r/<token>"
curl -fsS "$WEB_BASE/r/$SHARE_TOKEN" > /tmp/edgeprobe-web-public.html
if ! grep -q "<html" /tmp/edgeprobe-web-public.html; then
  echo "[e2e] FAIL: public page didn't render HTML" >&2
  head -c 2000 /tmp/edgeprobe-web-public.html >&2
  exit 1
fi
if grep -q "SECRET USER PROMPT" /tmp/edgeprobe-web-public.html; then
  echo "[e2e] FAIL: public HTML contains prompt text — PII BOUNDARY BREACH at view layer" >&2
  exit 1
fi
if grep -q "SECRET COMPLETION" /tmp/edgeprobe-web-public.html; then
  echo "[e2e] FAIL: public HTML contains completion text — PII BOUNDARY BREACH at view layer" >&2
  exit 1
fi
# Positive: the hero tiles and waterfall must have rendered.
if ! grep -q "metric-tile" /tmp/edgeprobe-web-public.html; then
  echo "[e2e] FAIL: public HTML is missing hero metric tiles" >&2
  exit 1
fi
if ! grep -q "waterfall" /tmp/edgeprobe-web-public.html; then
  echo "[e2e] FAIL: public HTML is missing waterfall" >&2
  exit 1
fi
echo "[e2e]   → public HTML renders, no prompt text ✓"

# ---- 9b. GET web /og/<token>.png — proxy to backend, PNG magic + 200 ----
echo "[e2e] GET $WEB_BASE/og/<token>.png"
WEB_OG_STATUS=$(curl -sS -o /tmp/edgeprobe-web-og.png -w "%{http_code}" "$WEB_BASE/og/$SHARE_TOKEN.png")
if [ "$WEB_OG_STATUS" != "200" ]; then
  echo "[e2e] FAIL: web /og proxy returned $WEB_OG_STATUS, expected 200" >&2
  exit 1
fi
WEB_OG_MAGIC=$(head -c 4 /tmp/edgeprobe-web-og.png | od -An -tx1 | tr -d ' ')
if [ "$WEB_OG_MAGIC" != "89504e47" ]; then
  echo "[e2e] FAIL: web /og proxy returned non-PNG bytes (magic=$WEB_OG_MAGIC)" >&2
  exit 1
fi
echo "[e2e]   → web OG proxy returns PNG ✓"

# ---- 9c. og:image in the public HTML is a same-origin URL to the token PNG ----
# Slack/Twitter pick up <meta property="og:image">. Must point at the web
# origin (not the backend) so cookies / redirects don't cross hosts.
echo "[e2e] verify og:image in public HTML"
if ! grep -q "property=\"og:image\" content=\"$WEB_BASE/og/" /tmp/edgeprobe-web-public.html; then
  echo "[e2e] FAIL: public HTML og:image doesn't point at $WEB_BASE/og/..." >&2
  grep -i "og:image" /tmp/edgeprobe-web-public.html >&2 || true
  exit 1
fi
echo "[e2e]   → og:image is same-origin ✓"

# ---- 10. GET web /r/<bogus> — single 404 page for every failure mode ----
echo "[e2e] GET $WEB_BASE/r/<bogus-token>"
BOGUS_STATUS=$(curl -sS -o /tmp/edgeprobe-web-404.html -w "%{http_code}" "$WEB_BASE/r/bogus.token")
if [ "$BOGUS_STATUS" != "404" ]; then
  echo "[e2e] FAIL: bogus token returned $BOGUS_STATUS, expected 404" >&2
  exit 1
fi
if ! grep -q "Not found" /tmp/edgeprobe-web-404.html; then
  echo "[e2e] FAIL: 404 page missing 'Not found' copy" >&2
  exit 1
fi
echo "[e2e]   → bogus token → 404 HTML ✓"

# ---- 11. GET web /app/trace/:id?org=<owning> — prompt text MUST be visible ----
echo "[e2e] GET $WEB_BASE/app/trace/$TRACE_ID?org=org_acme"
curl -fsS "$WEB_BASE/app/trace/$TRACE_ID?org=org_acme" > /tmp/edgeprobe-web-private.html
if ! grep -q "SECRET USER PROMPT" /tmp/edgeprobe-web-private.html; then
  echo "[e2e] FAIL: auth'd HTML is missing opted-in prompt text" >&2
  head -c 2000 /tmp/edgeprobe-web-private.html >&2
  exit 1
fi
if ! grep -q "Captured content" /tmp/edgeprobe-web-private.html; then
  echo "[e2e] FAIL: auth'd HTML is missing the Captured content block" >&2
  exit 1
fi
echo "[e2e]   → auth'd HTML shows content ✓"

# ---- 11b. GET web /app?org=<owning> — projects list HTML ----
echo "[e2e] GET $WEB_BASE/app?org=org_acme"
curl -fsS "$WEB_BASE/app?org=org_acme" > /tmp/edgeprobe-web-home.html
if ! grep -q "Projects" /tmp/edgeprobe-web-home.html; then
  echo "[e2e] FAIL: /app home missing Projects header" >&2
  exit 1
fi
if ! grep -q "proj_voice" /tmp/edgeprobe-web-home.html; then
  echo "[e2e] FAIL: /app home missing proj_voice row" >&2
  exit 1
fi
if ! grep -q "list-row-table" /tmp/edgeprobe-web-home.html; then
  echo "[e2e] FAIL: /app home isn't using list-row-table (design regression)" >&2
  exit 1
fi
echo "[e2e]   → /app home renders projects list ✓"

# ---- 11c. GET web /app/projects/proj_voice?org=<owning> — traces list HTML ----
echo "[e2e] GET $WEB_BASE/app/projects/proj_voice?org=org_acme"
curl -fsS "$WEB_BASE/app/projects/proj_voice?org=org_acme" > /tmp/edgeprobe-web-project.html
if ! grep -q "$TRACE_ID" /tmp/edgeprobe-web-project.html; then
  echo "[e2e] FAIL: project detail missing trace id $TRACE_ID" >&2
  exit 1
fi
if grep -q "SECRET USER PROMPT" /tmp/edgeprobe-web-project.html; then
  echo "[e2e] FAIL: project detail HTML leaked prompt text — PII BOUNDARY BREACH" >&2
  exit 1
fi
echo "[e2e]   → /app/projects/proj_voice renders trace rows, no prompt text ✓"

# ---- 12. GET web /app/trace/:id?org=<other> — 403 and no prompt text ----
echo "[e2e] GET $WEB_BASE/app/trace/$TRACE_ID?org=org_competitor"
CROSS_STATUS=$(curl -sS -o /tmp/edgeprobe-web-cross.html -w "%{http_code}" \
  "$WEB_BASE/app/trace/$TRACE_ID?org=org_competitor")
if [ "$CROSS_STATUS" != "403" ]; then
  echo "[e2e] FAIL: cross-org web request returned $CROSS_STATUS, expected 403" >&2
  exit 1
fi
if grep -q "SECRET USER PROMPT" /tmp/edgeprobe-web-cross.html; then
  echo "[e2e] FAIL: cross-org HTML leaked prompt text — PII BOUNDARY BREACH" >&2
  exit 1
fi
echo "[e2e]   → cross-org → 403, no prompt text ✓"

echo
echo "[e2e] ALL CHECKS PASSED — backend contract holds, web dashboard renders, PII boundary enforced at both layers"
