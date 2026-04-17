# Slices — Y2 P0 burndown

One slice = one commit-sized unit of work with a named `done` gate.
Each slice leaves the tree green (all tests, typecheck, e2e, CI pass).

Slice numbering is append-only: once landed, a slice is never renumbered.
Follow-up work creates a new slice, not a rename.

## Status

- [x] **Slice 0** — Sim CoreML LLM scaffolding, default stub fallback (`ae8e91f`)
- [x] **Slice 1** — GitHub Action + PR comment template
- [x] **Slice 2** — OG image generator (`/og/{token}.png`)
- [x] **Slice 3** — `/app` home dashboard (project + session lists)
- [x] **Slice 4** — Per-org rate limits + content-hash dedup + payload caps + 30-day expiry
- [x] **Slice 5** — Two-key auth finish (`epk_pub_` ingest vs `epk_priv_` dashboard, rotation)
- [x] **Slice 6** — Per-call `includeContent` + `sensitive=true` projection guard (SDK + backend)
- [x] **Slice 7** — Six critical regression tests as an explicit named suite
- [x] **Slice 8** — XCFramework build workflow on upstream tags
- [x] **Slice 9** — Benchmark harness (Y1 OSS tool) — minimal first cut
- [ ] **Slice 10** — VoiceProbe cleanup tail from Slice 0

## Slice contracts

### Slice 1 — GitHub Action + PR comment template

**Why:** the PR comment is the viral mechanism the plan calls the wedge.

**Scope:**
- New package `action/` with a composite GitHub Action and an entry script.
- CI job `action` runs a smoke that:
  - Ingests a deterministic synthetic trace via `/ingest`.
  - Mints a share token via `/app/trace/:id/share`.
  - Formats a PR-comment markdown blob matching the `DESIGN.md` template
    (header line, `<details>` per-turn table, `View full trace →` link,
    `<sub>` footer, no emoji beyond `▲`).
- `--threshold` and `--baseline` flags honored; above-threshold regression
  flips the comment verdict. `--fail-on-regression` controls exit code.

**Done:** CI job runs end-to-end against an ephemeral backend, asserts the
comment body matches the committed golden fixture, asserts exit code flips
on simulated regression.

### Slice 2 — OG image generator

**Why:** Slack/Twitter unfurls are the primary acquisition surface per
`DESIGN.md`. Plain text unfurls kill reach.

**Scope:**
- New backend route `GET /og/:token.png`.
- Render server-side via `@resvg/resvg-js` from an SVG template that uses
  IBM Plex Mono + Inter already vendored under `web/public/fonts`.
- Response is `image/png`, `Cache-Control: public, max-age=3600, immutable`
  keyed on token (token itself encodes `expiresAt`).
- Failure modes render a branded fallback (never the default hosting
  provider's "image not found"), matching the `DESIGN.md` OG caveats.
- `<Layout>` `ogImage` prop wired on the public page to point at
  `/og/:token.png` so `<meta property="og:image">` resolves.

**Done:** hitting the route with a valid token returns a ~20–60 KB PNG;
hitting it with an invalid token returns a branded fallback PNG with 404
status; the response mimetype + cache headers are asserted in a test.

### Slice 3 — `/app` home dashboard

**Why:** after a user hits the auth wall, there needs to be a dashboard
other than the single trace detail page.

**Scope:**
- Backend: new endpoints
  - `GET /app/projects` → list projects (distinct `project_id`) for the
    requesting org, with last-trace-at, trace count, etc.
  - `GET /app/projects/:projectId/traces` → list recent traces, paginated.
- Web: new page `pages/appHome.tsx` rendered at `/app` (list-row layout
  per `DESIGN.md` — not card grid, not left sidebar).
- Web: new page `pages/projectDetail.tsx` at `/app/projects/:projectId`.
- All auth'd with the existing `Authorization: Bearer epk_dash_…` model.

**Done:** e2e covers both HTML renders, empty state matches the copy
specified in `DESIGN.md` interaction coverage table.

### Slice 4 — Ingest hardening

**Why:** `epk_pub_` keys ship in the app bundle — leaks are expected.
Replay floods, oversize payloads, and stale data must all be survivable
without paging a human.

**Scope:**
- Per-org token bucket rate limiter (in-process, Map-backed) — spans/sec
  and MB/day. Returns 429 with `Retry-After` on overflow.
- SHA-256 content hash dedup at insert: `(orgId, contentHash, minuteBucket)`
  UNIQUE index; duplicates silently accepted at the endpoint but not stored.
- Payload size cap (default 1 MB, env-configurable) enforced before parse.
- Free-tier expiry job: traces older than 30 days purged via a scheduled
  worker (for tests: a sync `purgeExpired(now)` we drive directly).

**Done:** new `bun test` covers each failure mode; `edgeprobe.spans_dropped_total`
counter equivalent exposed via `GET /metrics` stub for dashboard consumption.

### Slice 5 — Two-key auth finish

**Why:** today `/ingest` accepts any `Bearer epk_pub_…`. That doesn't
actually authenticate. The plan says public keys are identified but
replaceable.

**Scope:**
- `api_keys` table becomes load-bearing: `/ingest` looks up the presented
  key (hashed) and derives `orgId` from the row. The payload's `orgId`
  must match the key's org or the request is 401.
- Admin endpoints (auth'd with `epk_priv_`):
  - `POST /app/keys` — mint a new `epk_pub_` or `epk_priv_` key for an org.
  - `DELETE /app/keys/:id` — revoke.
  - `GET /app/keys` — list (metadata only, never the raw token).
- Key hashing via `Bun.password.hash` (argon2id). Never store raw tokens.

**Done:** e2e flow: mint key via `epk_priv_` admin call, use it to ingest,
revoke it, assert subsequent ingests 401. Test the "wrong-org-in-payload"
mismatch returns 401 explicitly.

### Slice 6 — Per-call content opt-in + sensitive flag

**Why:** the SDK surface already accepts `includeContent: true` but the
backend projection test asserting "opt-in does not escalate to public"
relies on today's hand-waved flow. Need the whole path end-to-end.

**Scope:**
- SDK: `EdgeProbe.trace(.llm, sensitive: true) { … }` marks the trace
  `sensitive: true`, which strips it from `/r/:token` entirely (backend
  already enforces). Round-trip via `beginTrace(..., sensitive: true)`.
- SDK: populate `promptText` / `completionText` via the existing
  `SpanReporter` — add an integration test that asserts they travel over
  the wire when `includeContent: true` and do NOT otherwise.
- Backend: projection guard in `views.ts` — `toPublicSpan` must fail-closed
  if it sees a content-keyed attr that slipped past the denylist. Property
  test with random attr bags.

**Done:** explicit regression test set that says "stored span with
`includeContent: true` is invisible on `/r/:token` JSON and on
`/og/:token.png` description", and "`sensitive: true` trace returns 404
on public AND does not render in OG".

### Slice 7 — Six critical regression tests, named

**Why:** `docs/TEST-PLAN.md` lists six ship-gating invariants. Today they
are spread across `backend/test/pii-boundary.test.ts`, `ios/Tests`, and
the e2e shell script. Reviewers can't see coverage at a glance.

**Scope:**
- New file `backend/test/critical-paths.test.ts` (or a `describe` block)
  with exactly six named tests, one per invariant, each `describe`'s name
  matching the invariant as written in `README.md`.
- SDK: `ios/Tests/EdgeProbeTests/CriticalPathsTests.swift` mirror for the
  iOS-only ones (main thread never blocked, idempotent start, drop-oldest).
- Every critical test is tagged so CI can run only-that-suite as a
  fast pre-merge gate.

**Done:** the six invariants map one-to-one to six named tests, and CI has
a new "critical-paths" job that runs just those — if any fail, the `required`
aggregator fails.

### Slice 8 — XCFramework build workflow

**Why:** the plan calls hand-building XCFrameworks across the matrix
unsustainable. One-time eng investment, pays back every llama.cpp bump.

**Scope:**
- New workflow `.github/workflows/xcframework.yml`:
  - Triggers on repository dispatch (so a separate watcher can fire it on
    upstream tags) and on manual workflow_dispatch for founder testing.
  - Inputs: `llama_cpp_tag`, `whisper_cpp_tag`.
  - Matrix: `{ ios, ios-simulator, macos }` × `{ arm64, x86_64 }`.
  - Builds XCFrameworks, strips, tags, uploads as release assets.
- README section linking to the workflow and documenting the
  `gh workflow run xcframework.yml -f llama_cpp_tag=b4321` flow.

**Done:** workflow manually dispatchable and succeeds in dry-run mode
(the compile step itself may be gated behind a real tag; the workflow's
shape and YAML validity land in this slice).

### Slice 9 — Benchmark harness (Y1 OSS tool)

**Why:** `PLAN.md` calls out the benchmark harness as shared infrastructure
between Y1 content posts and Y2 SDK integration tests. Starting it now
even as a minimal shell both seeds the Y1 content pipeline and gives us
a reusable integration-test fixture.

**Scope:**
- New top-level `harness/` dir with a Swift CLI:
  - `harness run --model <mlx-id> --prompt <fixture> --iters N` emits
    JSON timing blobs per iteration.
  - `harness diff <a.json> <b.json>` produces a textual perf-diff matching
    the PR-comment template.
- Deterministic seeding + hash of output tokens so drift is catchable.
- Integration with EdgeProbe: `EdgeProbe.beginTrace()` per iteration so the
  harness doubles as a span-pipeline exerciser.

**Done:** `harness run --iters 2 --prompt tests/fixtures/prompts/cap.txt`
produces a JSON timing blob; a committed golden for `harness diff`
succeeds; the harness itself ships as a distinct SwiftPM product so the
SDK package doesn't bloat.

### Slice 10 — VoiceProbe cleanup tail from Slice 0

**Why:** Slice 0 ended with the CoreML sim path throwing early. A few
loose ends remain that are either one-liners or small tidy-ups.

**Scope:** audit VoiceProbe against today's `README.md` and fix whatever
drift remains — stub reply text polish, status chip wording, any dead
imports, an explicit test that "`-EDGEPROBE_AUTOGENERATE` with no flag
returns stub text" is stable.

**Done:** VoiceProbe `README.md` matches what the code actually does, no
new TODOs introduced, simulator smoke via `-EDGEPROBE_AUTOLOAD 1
-EDGEPROBE_AUTOGENERATE "hello"` produces a stable textual output.
