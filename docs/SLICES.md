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
- [x] **Slice 8** — XCFramework build workflow on upstream tags _(retired in Slice 15 — upstream now ships prebuilt xcframeworks for both)_
- [x] **Slice 9** — Benchmark harness (Y1 OSS tool) — minimal first cut
- [x] **Slice 10** — VoiceProbe cleanup tail from Slice 0
- [x] **Slice 11** — Real on-device LLM on simulator via llama.cpp
- [x] **Slice 12** — Bump `actions/*` to Node 24 runtimes
- [x] **Slice 13** — Matrix iOS jobs across Xcode current + current-1
- [x] **Slice 14** — Upload bun + swift coverage artifacts on every PR
- [x] **Slice 15** — Retire the custom XCFramework workflow (upstream prebuilds cover the need)

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

### Slice 11 — Real on-device LLM on simulator via llama.cpp

**Why:** Slice 0's CoreML sim path is blocked on an Apple-side zero-logit
bug that we can't fix. The simulator has had no working real-LLM path
since — benchmarks, recorded demos, and any "does the voice turn actually
run inference" smoke needed a physical device. llama.cpp's prebuilt
xcframework runs CPU-only (no Metal, no CoreML) and is exactly the right
size for a 0.5B model on sim CPU, so a third sim path that bypasses both
failure modes unblocks everything without waiting on Apple.

**Scope:**
- New sibling SwiftPM package `ios/LlamaRuntime/` that pins upstream
  llama.cpp's prebuilt xcframework by URL + SHA-256 (tag `b8833`).
  Thin Swift wrapper (`LlamaModel` + `LlamaSession`) deliberately kept
  small — no streaming, no Config knobs, greedy sampling only. Lives
  outside `ios/` SDK so backend/CI consumers don't pay the 169 MB
  binaryTarget download cost.
- VoiceProbe: third simulator LLM path, shipped opt-in via
  `-EDGEPROBE_SIM_LLAMACPP` and promoted to simulator default on
  2026-04-18 (stub moved to opt-out via `-EDGEPROBE_SIM_STUB`, CoreML
  remains opt-in via `-EDGEPROBE_SIM_COREML`). Downloads
  `Qwen/Qwen2.5-0.5B-Instruct-GGUF` (q4_0, ~428 MB) on first launch
  via `HubApi.snapshot`; caches afterwards. Forces `n_gpu_layers = 0`
  so no Metal dep.
- `ModelHub.swift`: new `ensureLlamaCppGGUF(progress:)` helper,
  ungated (llama.cpp works on iOS 16.4+; `ensureAvailable` stays
  `@available(iOS 18.0, *)` for the CoreML path).
- `ContentView.loadProgressLabel` picks "Downloading Qwen GGUF X%"
  when the llama.cpp path is live.
- Docs: four-path table in both `README.md` and `ios/DemoApp/README.md`,
  launch-arg section updated.

**Done:** VoiceProbe built for simulator links `llama.framework` into
the `.app`, `swift test` in `ios/LlamaRuntime` passes 3/3 (error
descriptions, missing-file throw, raw C-symbol import), and a fresh
simulator launch produces model-generated tokens (not stub text)
after the first-launch Qwen GGUF download — no launch arg required
as of 2026-04-18.

### Slice 12 — Bump `actions/*` to Node 24 runtimes

**Why:** GitHub deprecated Node 20 on Actions 2026-09-19 with a 2026-06-02
hard cutoff. Every CI annotation had been warning since 2026-04-18.
Handle the bump before prod runs break, not after.

**Scope:**
- Probe each action's `action.yml` `using:` field to confirm the chosen
  tag actually ships on Node 24.
- Version bumps (Actions-owned repos keep bare-major alias):
  - `actions/checkout` v4 → v5
  - `actions/cache` v4 → v5
  - `actions/upload-artifact` v4 → v7 (v5/v6 still node20)
  - `actions/download-artifact` v4 → v8 (v5–v7 still node20)
  - `softprops/action-gh-release` v2 → v3
- Pin `minor.patch` on third-party actions whose bare-major alias has
  stopped advancing (per the deprecation warnings' name-check):
  - `maxim-lobanov/setup-xcode` v1 → v1.7.0
  - `oven-sh/setup-bun` v2 → v2.2.0
- Sanity-check release notes for each bump; inputs we pass
  (`fetch-depth`, `key`, `path`, `name`, `tag_name`, `draft`, `files`)
  unchanged across the tag jumps.

**Done:** CI passes on `main` and on a fresh PR with zero Node 20
deprecation annotations in the logs. Change surface is 7 string swaps
in `.github/workflows/`, trivially bisectable if a regression shows up.

### Slice 13 — Matrix iOS jobs across Xcode current + current-1

**Why:** `docs/TEST-PLAN.md` §CI Matrix calls for Swift toolchain
coverage across `current + current-1`. The original `ci.yml` explicitly
deferred it ("lands in month 13 once the XCFramework build job exists").
Slice 8 shipped that job and Slice 12 unblocked Node 24; runway is now
clear.

**Scope:**
- Two matrix cells per iOS-flavored job:
  - `"16"` — tracks the latest 16.x via `maxim-lobanov/setup-xcode`'s
    major selector. Catches Swift 6.x patch drift automatically;
    patch bumps don't churn the workflow file.
  - `"16.1"` — explicit current-1 pin. When Apple rotates it off the
    `macos-14` image (as happened to 16.0 on 2026-04-18), THIS cell
    fails red and forces a deliberate bump rather than accepting the
    drop silently.
- Matrix applied to all three iOS-flavored jobs: `ios` (primary suite),
  `critical-paths-ios` (ship-gating invariants #4–#6), `harness`
  (benchmark CLI + golden diff).
- Per-cell cache keys (`swiftpm-<os>-xcode-<version>-<hash>`) so a
  16.1 `.build/` can't restore on top of a 16.2 run and blow up with
  opaque module-incompatibility errors. Fallback `restore-keys`
  preserved for cold-start warmth.

**Done:** `needs.ios.result` still returns `success` only when all
matrix cells pass, so the `required` aggregator continues to gate
merges unchanged. Cost: ~+$2.80/PR in macOS runner minutes —
acceptable for catching Xcode drift before merge.

### Slice 14 — Upload bun + swift coverage artifacts on every PR

**Why:** `docs/TEST-PLAN.md` §Coverage Targets declares `SDK ≥90%
line coverage` and `Backend 100% of HTTP endpoints + 100% of auth
boundaries`. Today those targets are folklore — there's no per-PR
artifact a reviewer can read. Ship coverage observability before
gating on it.

**Scope:**
- `bun test --coverage` on the backend job; text reporter goes to
  stdout so PR-log scanners see per-file numbers without downloading
  anything, LCOV emitted alongside for downstream integrations
  (Codecov, Coveralls, Sonar).
- Swift coverage on the iOS job via
  `swift test --enable-code-coverage`, extracted with
  `xcrun llvm-cov export` to LCOV.
- Coverage captured on the `"16"` Xcode matrix cell only, not `"16.1"`
  — source-level output is identical across Xcode patch levels, so
  running it on both cells just duplicates a ~30 KB artifact and
  invites an artifact-name collision.
- Artifacts uploaded with 14-day retention — long enough to correlate
  a regression to its PR without letting old artifacts pile up
  against the org's storage quota.
- Day-1 posture is **observability, not gate**. A threshold gate with
  no baseline data would false-positive on the `pg*` production-only
  stubs (excluded from the in-memory suite) and cry wolf before
  anyone has intuition for realistic numbers. `--coverage-threshold`
  lands in a follow-up slice once a week of baseline data is in.

**Done:** PRs surface `bun-coverage` and `swift-coverage` artifacts.
Baseline at merge time: iOS SDK 90.73% lines / 82.86% funcs (meets
target), backend 64.78% lines (72.98% on `server.ts` hot path; the
drag is `pgApiKeyStore` / `pgSpanStore` / `migrate.ts` which are
production-only paths), web 90.82% on `server.tsx` with pages all
100%, action covers cross-package smoke against `../backend`.

### Slice 15 — Retire the custom XCFramework workflow

**Why:** Slice 8 landed a matrix-fan-out workflow that builds llama.cpp
and whisper.cpp as XCFrameworks, explicitly shipping the SHAPE only
(`--real` path is a `touch .stub` + log-and-exit stub; no run has ever
actually compiled). The follow-up to flip `--real` on was gated on
"once Package.swift consumes the uploaded XCFrameworks." Two things
have changed since:

1. **Upstream `ggml-org/llama.cpp` ships a prebuilt xcframework on
   every `bNNNN` tag.** `ios/LlamaRuntime/` already pins it by URL +
   SHA-256 (tag `b8833`), bypassing our workflow entirely.
2. **Upstream `ggml-org/whisper.cpp` started publishing a prebuilt
   xcframework too** (`whisper-v<tag>-xcframework.zip`, first at
   v1.8.4 on 2026-03-19). The last remaining rationale for a custom
   whisper build is gone.

VoiceProbe's ASR uses Apple's `SFSpeechRecognizer` (see
`ios/DemoApp/.../ASRService.swift` — explicitly chosen over whisper.cpp
per the file's docstring: "Whisper.cpp would be more accurate but
bigger and off-topic for the SDK demo"), so there's no remaining
consumer of the workflow's output even if whisper-via-llama.cpp-wrap
lands later. A future `ios/WhisperRuntime/` would mirror `LlamaRuntime`
and pin upstream directly, same as llama.

The build flags we planned (`LLAMA_METAL=ON`, `WHISPER_COREML=ON`,
`BUILD_SHARED_LIBS=OFF`) match what upstream already ships, so there's
no flag-customization escape hatch we'd lose.

**Scope:**
- Delete `.github/workflows/xcframework.yml` (~220 lines of YAML).
- Delete `scripts/build-xcframework.sh` (the orchestration shell
  script that was still a log-only stub).
- `docs/SLICES.md`: mark Slice 8 as `(retired in Slice 15 — upstream
  now ships prebuilt xcframeworks for both)` in the status list.
  Slice 8's contract section is preserved verbatim for history
  (append-only slice numbering means we don't rewrite the past; we
  annotate it).
- `README.md`: drop the "XCFramework builds" advanced-section bullet
  (both EN + 中文), and trim the project-layout `.github/` row to
  just "Workflows (CI matrix)".
- `.gitignore`: drop the `build/xcframework/` scratch-dir entry —
  no script will write there anymore.

**Done:** `.github/workflows/xcframework.yml` and
`scripts/build-xcframework.sh` gone from the tree. `actionlint
.github/workflows/` covers one fewer file. `bun test` and `swift
test` unchanged (neither ever touched these files). `git log -p
4db7036^..HEAD -- .github/workflows/xcframework.yml scripts/build-xcframework.sh`
is the recoverable history if a future slice actually needs custom
compilation (e.g., stripping Metal for size).

**Reversibility note:** pulling the workflow back is a `git revert`
or a cherry-pick from before Slice 15. No data loss, no external
dependency — upstream's prebuilts live on GitHub Releases, which
LlamaRuntime already consumes and a hypothetical WhisperRuntime
would too.
