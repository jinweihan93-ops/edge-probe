import { describe, test, expect } from "bun:test"
import { createApp, makeMemoryDeps, type AppDeps } from "../src/server.ts"
import { TEST_DASHBOARD_KEY_ACME, TEST_DASHBOARD_KEY_COMPETITOR } from "../src/auth.ts"
import type { StoredSpan, Trace } from "../src/views.ts"

/**
 * Critical Paths — the six ship-gating invariants from docs/TEST-PLAN.md §"Critical Paths".
 *
 * This file is the single-file roll-up the team uses as a pre-merge gate. CI
 * runs it as its own job (`critical-paths`) wired into the `required`
 * aggregator. If any test here fails, the branch cannot merge to main — no
 * exceptions, no skip flags.
 *
 * Coverage split:
 *   - #1, #2, #3 are backend-observable; they live here, one describe each.
 *   - #4, #5, #6 are SDK-internal (thread scheduling, ring buffer, idempotent
 *     static state). Those live in `ios/Tests/EdgeProbeTests/CriticalPathsTests.swift`.
 *     We STILL list them here — one describe each, with a placeholder that
 *     points reviewers at the Swift mirror — so scanning this one file gives
 *     a complete picture of all six.
 *
 * Naming convention: each `describe` opens with "Critical Path #N:" followed
 * by the invariant exactly as written in README.md / TEST-PLAN.md. Grep for
 * "Critical Path #" to see coverage at a glance.
 */

const TEST_SHARE_SECRET = "x".repeat(48)
const BEARER_ACME = { Authorization: `Bearer ${TEST_DASHBOARD_KEY_ACME}` }
const BEARER_COMP = { Authorization: `Bearer ${TEST_DASHBOARD_KEY_COMPETITOR}` }

function freshDeps(): AppDeps {
  return makeMemoryDeps(TEST_SHARE_SECRET)
}

async function seedTraceWithContent(deps: AppDeps) {
  const trace: Trace = {
    id: "trace_cp",
    orgId: "org_acme",
    projectId: "proj_voice",
    sessionId: null,
    startedAt: "2026-04-15T12:00:00Z",
    endedAt: "2026-04-15T12:00:01Z",
    device: { model: "iPhone 15 Pro" },
    attributes: { "build.commit": "cp_test" },
    sensitive: false,
  }
  await deps.store.insertTrace(trace)
  const span: StoredSpan = {
    id: "span_cp",
    traceId: "trace_cp",
    parentSpanId: null,
    name: "llama-decode",
    kind: "llm",
    startedAt: "2026-04-15T12:00:00.100Z",
    endedAt: "2026-04-15T12:00:00.700Z",
    durationMs: 600,
    status: "ok",
    attributes: {
      "gen_ai.request.model": "llama-3.2-3b-instruct-q4",
      "gen_ai.prompt": "CRITICAL-PATH-SECRET-PROMPT",
      "gen_ai.completion": "CRITICAL-PATH-SECRET-COMPLETION",
    },
    includeContent: true,
    promptText: "CRITICAL-PATH-SECRET-PROMPT",
    completionText: "CRITICAL-PATH-SECRET-COMPLETION",
    transcriptText: null,
  }
  await deps.store.insertSpan(span)
}

function mintToken(deps: AppDeps, traceId = "trace_cp", orgId = "org_acme") {
  return deps.signer.sign({
    traceId,
    orgId,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  })
}

// ───────────────────────────────────────────────────────────────────────────
// Backend-observable invariants — fully enforced here.
// ───────────────────────────────────────────────────────────────────────────

describe("Critical Path #1: prompt/completion text NEVER in /r/{token} response even if content was uploaded for that span", () => {
  test("uploaded content (includeContent: true) does not appear on the public share JSON", async () => {
    const deps = freshDeps()
    const app = createApp(deps)
    await seedTraceWithContent(deps)

    const token = mintToken(deps)
    const res = await app.request(`/r/${token}`)
    expect(res.status).toBe(200)
    const raw = await res.text()

    expect(raw).not.toContain("CRITICAL-PATH-SECRET-PROMPT")
    expect(raw).not.toContain("CRITICAL-PATH-SECRET-COMPLETION")

    const body = JSON.parse(raw) as { spans: Array<Record<string, unknown>> }
    for (const span of body.spans) {
      const keys = new Set(Object.keys(span))
      expect(keys.has("promptText")).toBe(false)
      expect(keys.has("completionText")).toBe(false)
      expect(keys.has("transcriptText")).toBe(false)
      expect(keys.has("includeContent")).toBe(false)
    }
  })
})

describe("Critical Path #2: /app/trace/{id} blocks access from other orgs (not 404 — 403, so we don't confirm existence)", () => {
  test("auth'd requester from another org gets 403, and truly-missing returns 404 distinctly", async () => {
    const deps = freshDeps()
    const app = createApp(deps)
    await seedTraceWithContent(deps) // stored under org_acme

    const crossOrg = await app.request("/app/trace/trace_cp", { headers: BEARER_COMP })
    expect(crossOrg.status).toBe(403)

    // A missing trace must return 404 — the distinct code is the entire point.
    // If both returned the same status, an attacker could not distinguish
    // "this exists, I just can't see it" from "doesn't exist" — but defense-
    // in-depth says we ALSO hide existence by returning 403 (not 404) on
    // wrong-org, so the "distinct code" cuts the other way here: 403 means
    // the id is valid shape but denied; 404 means absent.
    const missing = await app.request("/app/trace/trace_nope_cp", { headers: BEARER_COMP })
    expect(missing.status).toBe(404)
  })
})

describe("Critical Path #3: opting in to content upload does NOT make that span visible on public URLs", () => {
  test("same seeded span (includeContent: true server-side) is visible to owner, invisible to public", async () => {
    const deps = freshDeps()
    const app = createApp(deps)
    await seedTraceWithContent(deps)

    const token = mintToken(deps)
    const publicBody = await (await app.request(`/r/${token}`)).text()
    expect(publicBody).not.toContain("CRITICAL-PATH-SECRET-PROMPT")

    const privateBody = await (
      await app.request("/app/trace/trace_cp", { headers: BEARER_ACME })
    ).text()
    expect(privateBody).toContain("CRITICAL-PATH-SECRET-PROMPT")
    expect(privateBody).toContain("CRITICAL-PATH-SECRET-COMPLETION")
  })
})

// ───────────────────────────────────────────────────────────────────────────
// iOS-internal invariants — real tests live in the Swift mirror file.
// Listed here with a pointer so reviewers see all six in one place.
// ───────────────────────────────────────────────────────────────────────────

describe("Critical Path #4: main thread never blocked by SDK (network + serialization on background DispatchQueue)", () => {
  // The SDK-side enforcement is `ios/Tests/EdgeProbeTests/CriticalPathsTests.swift`
  // `test_mainThread_isNeverBlocked_byTraceExport` — it asserts that
  // `trace()` returns in <1ms even when the background exporter is under
  // load. Running the full ring-buffer + BSP plumbing from TypeScript
  // doesn't exercise the real threading model; we'd just be mocking our
  // own code. Trust the SDK tests, trust the e2e, and keep this stub as a
  // visible placeholder so the critical-paths file is complete.
  test.skip("enforced in ios/Tests/EdgeProbeTests/CriticalPathsTests.swift — see Swift mirror", () => {})
})

describe("Critical Path #5: drop-oldest on buffer overflow (bounded memory during backend outage; counter emitted on reconnect)", () => {
  // The SDK-side enforcement is
  // `ios/Tests/EdgeProbeTests/CriticalPathsTests.swift`
  // `test_ringBuffer_dropsOldest_whenOverflowing_andIncrementsCounter`.
  // The backend would only see the `edgeprobe.spans_dropped_total` metric
  // after reconnect — relevant but downstream of the invariant itself.
  test.skip("enforced in ios/Tests/EdgeProbeTests/CriticalPathsTests.swift — see Swift mirror", () => {})
})

describe("Critical Path #6: start() called twice does not double-init, does not duplicate exports", () => {
  // The SDK-side enforcement is
  // `ios/Tests/EdgeProbeTests/CriticalPathsTests.swift`
  // `test_start_isIdempotent_underConcurrentCalls`.
  // Pure SDK-static-state concern; no backend signal.
  test.skip("enforced in ios/Tests/EdgeProbeTests/CriticalPathsTests.swift — see Swift mirror", () => {})
})
