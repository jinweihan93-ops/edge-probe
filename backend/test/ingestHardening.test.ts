import { describe, test, expect, beforeEach } from "bun:test"
import {
  createApp,
  makeMemoryDeps,
  runRetentionSweep,
  type AppDeps,
} from "../src/server.ts"
import { RateLimiter } from "../src/rateLimit.ts"
import { Metrics } from "../src/metrics.ts"

/**
 * End-to-end tests for Slice 4 ingest hardening. Each test exercises one
 * reject path and asserts (a) the HTTP response shape and (b) the right
 * counter incremented. If any of these regress, `edgeprobe_spans_dropped_total`
 * on the /metrics page will silently stop reporting that class — so the
 * test is the only tripwire.
 */

const SECRET = "y".repeat(48)
const PUB_KEY = "Bearer epk_pub_slice4_test"

function mkPayload(
  overrides: Partial<{ orgId: string; traceId: string; spanCount: number }> = {},
) {
  const orgId = overrides.orgId ?? "org_acme"
  const traceId = overrides.traceId ?? "trace_slice4_1"
  const spanCount = overrides.spanCount ?? 2
  const spans = Array.from({ length: spanCount }, (_, i) => ({
    id: `span_${traceId}_${i}`,
    traceId,
    parentSpanId: null,
    name: "llama.prefill",
    kind: "llm",
    startedAt: "2026-04-17T12:00:00.000Z",
    endedAt: "2026-04-17T12:00:00.500Z",
    durationMs: 500,
    status: "ok",
    attributes: {},
    includeContent: false,
    promptText: null,
    completionText: null,
    transcriptText: null,
  }))
  return {
    trace: {
      id: traceId,
      orgId,
      projectId: "proj_voice",
      sessionId: null,
      startedAt: "2026-04-17T12:00:00.000Z",
      endedAt: null,
      device: { model: "iPhone 15 Pro" },
      attributes: {},
      sensitive: false,
    },
    spans,
  }
}

describe("POST /ingest — payload size cap", () => {
  test("413 when Content-Length declares an oversize body", async () => {
    const metrics = new Metrics()
    const deps = makeMemoryDeps(SECRET, undefined, {
      metrics,
      maxIngestBytes: 500, // tiny cap for test
    })
    const app = createApp(deps)
    const payload = JSON.stringify(mkPayload({ spanCount: 0 }))
    const res = await app.fetch(
      new Request("http://x/ingest", {
        method: "POST",
        headers: {
          Authorization: PUB_KEY,
          "Content-Type": "application/json",
          "Content-Length": "99999", // lie big
        },
        body: payload,
      }),
    )
    expect(res.status).toBe(413)
    expect(metrics.get("edgeprobe_spans_dropped_total", { reason: "size" })).toBe(1)
  })

  test("413 when actual body exceeds cap even if Content-Length absent", async () => {
    const metrics = new Metrics()
    const deps = makeMemoryDeps(SECRET, undefined, {
      metrics,
      maxIngestBytes: 200,
    })
    const app = createApp(deps)
    // Build a >200B payload by padding attributes.
    const padded = mkPayload({ spanCount: 0 })
    padded.trace.attributes = { pad: "x".repeat(1000) }
    const res = await app.fetch(
      new Request("http://x/ingest", {
        method: "POST",
        headers: { Authorization: PUB_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(padded),
      }),
    )
    expect(res.status).toBe(413)
    expect(metrics.get("edgeprobe_spans_dropped_total", { reason: "size" })).toBeGreaterThanOrEqual(1)
  })

  test("right at cap: accepted", async () => {
    const deps = makeMemoryDeps(SECRET, undefined, { maxIngestBytes: 10 * 1024 })
    const app = createApp(deps)
    const res = await app.fetch(
      new Request("http://x/ingest", {
        method: "POST",
        headers: { Authorization: PUB_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(mkPayload()),
      }),
    )
    expect(res.status).toBe(202)
  })
})

describe("POST /ingest — rate limit", () => {
  test("429 with Retry-After header after bucket exhausted", async () => {
    const metrics = new Metrics()
    const rateLimiter = new RateLimiter({ spansPerSec: 3, bytesPerDay: 1e9 })
    const deps = makeMemoryDeps(SECRET, undefined, { metrics, rateLimiter })
    const app = createApp(deps)

    // First request carries 2 spans, lands.
    const ok = await app.fetch(
      new Request("http://x/ingest", {
        method: "POST",
        headers: { Authorization: PUB_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(mkPayload({ traceId: "t1", spanCount: 2 })),
      }),
    )
    expect(ok.status).toBe(202)

    // Second request: 2 more spans would need 2 tokens; only 1 left → 429.
    const rate = await app.fetch(
      new Request("http://x/ingest", {
        method: "POST",
        headers: { Authorization: PUB_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(mkPayload({ traceId: "t2", spanCount: 2 })),
      }),
    )
    expect(rate.status).toBe(429)
    expect(rate.headers.get("Retry-After")).toBeDefined()
    expect(Number(rate.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1)
    const body = (await rate.json()) as { reason: string; retryAfterSeconds: number }
    expect(body.reason).toBe("spans_per_sec")
    expect(metrics.get("edgeprobe_spans_dropped_total", { reason: "rate_limit" })).toBe(2)
  })

  test("different orgs do NOT share buckets", async () => {
    const rateLimiter = new RateLimiter({ spansPerSec: 2, bytesPerDay: 1e9 })
    const deps = makeMemoryDeps(SECRET, undefined, { rateLimiter })
    const app = createApp(deps)
    // Exhaust org_a.
    await app.fetch(
      new Request("http://x/ingest", {
        method: "POST",
        headers: { Authorization: PUB_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(mkPayload({ orgId: "org_a", traceId: "a1", spanCount: 2 })),
      }),
    )
    const rateA = await app.fetch(
      new Request("http://x/ingest", {
        method: "POST",
        headers: { Authorization: PUB_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(mkPayload({ orgId: "org_a", traceId: "a2", spanCount: 1 })),
      }),
    )
    expect(rateA.status).toBe(429)

    // org_b still has its own full bucket.
    const okB = await app.fetch(
      new Request("http://x/ingest", {
        method: "POST",
        headers: { Authorization: PUB_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(mkPayload({ orgId: "org_b", traceId: "b1", spanCount: 2 })),
      }),
    )
    expect(okB.status).toBe(202)
  })
})

describe("POST /ingest — content-hash dedup", () => {
  test("second identical request inside the same minute is 202 deduped=true and NOT stored", async () => {
    const metrics = new Metrics()
    const frozen = new Date("2026-04-17T12:34:56.789Z")
    const deps = makeMemoryDeps(SECRET, undefined, {
      metrics,
      now: () => frozen,
    })
    const app = createApp(deps)
    const body = JSON.stringify(mkPayload({ traceId: "dup_1", spanCount: 3 }))

    const first = await app.fetch(
      new Request("http://x/ingest", {
        method: "POST",
        headers: { Authorization: PUB_KEY, "Content-Type": "application/json" },
        body,
      }),
    )
    expect(first.status).toBe(202)
    const firstJson = (await first.json()) as {
      accepted: { deduped?: boolean }
    }
    expect(firstJson.accepted.deduped).toBeUndefined()

    // Same bytes, same minute → dedup.
    const second = await app.fetch(
      new Request("http://x/ingest", {
        method: "POST",
        headers: { Authorization: PUB_KEY, "Content-Type": "application/json" },
        body,
      }),
    )
    expect(second.status).toBe(202)
    const secondJson = (await second.json()) as {
      accepted: { deduped: boolean }
    }
    expect(secondJson.accepted.deduped).toBe(true)

    // ingest counter only counts successful NEW spans (3 from first), dropped
    // counter gained 3 on dedup.
    expect(metrics.get("edgeprobe_spans_ingested_total")).toBe(3)
    expect(metrics.get("edgeprobe_spans_dropped_total", { reason: "dedup" })).toBe(3)
  })

  test("different minute bucket lets the same body through (retries past 60s)", async () => {
    let t = new Date("2026-04-17T12:00:30.000Z").getTime()
    const deps = makeMemoryDeps(SECRET, undefined, {
      now: () => new Date(t),
    })
    const app = createApp(deps)
    const body = JSON.stringify(mkPayload({ traceId: "bucket_1" }))
    const first = await app.fetch(
      new Request("http://x/ingest", {
        method: "POST",
        headers: { Authorization: PUB_KEY, "Content-Type": "application/json" },
        body,
      }),
    )
    expect(first.status).toBe(202)
    // Advance to next minute.
    t += 60 * 1000
    const second = await app.fetch(
      new Request("http://x/ingest", {
        method: "POST",
        headers: { Authorization: PUB_KEY, "Content-Type": "application/json" },
        body,
      }),
    )
    expect(second.status).toBe(202)
    const secondJson = (await second.json()) as { accepted: { deduped?: boolean } }
    expect(secondJson.accepted.deduped).toBeUndefined()
  })

  test("identical bodies from different orgs do not collide", async () => {
    const frozen = new Date("2026-04-17T12:00:00Z")
    const deps = makeMemoryDeps(SECRET, undefined, { now: () => frozen })
    const app = createApp(deps)

    // Distinct orgs = different dedup keys even with same trace content.
    for (const orgId of ["org_a", "org_b"]) {
      const res = await app.fetch(
        new Request("http://x/ingest", {
          method: "POST",
          headers: { Authorization: PUB_KEY, "Content-Type": "application/json" },
          body: JSON.stringify(mkPayload({ orgId, traceId: `t_${orgId}` })),
        }),
      )
      expect(res.status).toBe(202)
      const j = (await res.json()) as { accepted: { deduped?: boolean } }
      expect(j.accepted.deduped).toBeUndefined()
    }
  })
})

describe("GET /metrics — Prometheus exposition", () => {
  test("returns text/plain with the registered counter names", async () => {
    const deps = makeMemoryDeps(SECRET)
    const app = createApp(deps)
    const res = await app.fetch(new Request("http://x/metrics"))
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toContain("text/plain")
    const body = await res.text()
    expect(body).toContain("edgeprobe_spans_dropped_total")
    expect(body).toContain("edgeprobe_spans_ingested_total")
    expect(body).toContain("edgeprobe_traces_purged_total")
    expect(body).toContain("# TYPE edgeprobe_spans_dropped_total counter")
  })

  test("counters reflect /ingest outcomes", async () => {
    const metrics = new Metrics()
    const deps = makeMemoryDeps(SECRET, undefined, { metrics })
    const app = createApp(deps)

    await app.fetch(
      new Request("http://x/ingest", {
        method: "POST",
        headers: { Authorization: PUB_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(mkPayload({ traceId: "m_ok", spanCount: 4 })),
      }),
    )
    const res = await app.fetch(new Request("http://x/metrics"))
    const body = await res.text()
    // The successful ingest put 4 in the ingested counter. Render includes it.
    expect(body).toContain("edgeprobe_spans_ingested_total 4")
  })
})

describe("Retention sweep — purgeExpired", () => {
  let deps: AppDeps
  beforeEach(() => { deps = makeMemoryDeps(SECRET) })

  test("drops traces older than cutoff, keeps newer ones, counts + metrics correct", async () => {
    const baseOld = "2026-01-01T00:00:00Z"
    const baseNew = "2026-04-17T00:00:00Z"
    for (let i = 0; i < 3; i++) {
      await deps.store.insertTrace({
        id: `old_${i}`,
        orgId: "org_acme",
        projectId: "p",
        sessionId: null,
        startedAt: baseOld,
        endedAt: null,
        device: {},
        attributes: {},
        sensitive: false,
      })
    }
    await deps.store.insertTrace({
      id: "new_1",
      orgId: "org_acme",
      projectId: "p",
      sessionId: null,
      startedAt: baseNew,
      endedAt: null,
      device: {},
      attributes: {},
      sensitive: false,
    })

    const now = new Date("2026-04-17T12:00:00Z")
    const removed = await runRetentionSweep(deps, 30, now)
    expect(removed).toBe(3)
    expect(deps.metrics.get("edgeprobe_traces_purged_total")).toBe(3)
    expect(await deps.store.getTrace("new_1")).toBeDefined()
    expect(await deps.store.getTrace("old_0")).toBeUndefined()
  })

  test("no-op when nothing is stale (returns 0, does not touch metric)", async () => {
    await deps.store.insertTrace({
      id: "fresh",
      orgId: "org_acme",
      projectId: "p",
      sessionId: null,
      startedAt: "2026-04-17T00:00:00Z",
      endedAt: null,
      device: {},
      attributes: {},
      sensitive: false,
    })
    const removed = await runRetentionSweep(deps, 30, new Date("2026-04-17T12:00:00Z"))
    expect(removed).toBe(0)
    expect(deps.metrics.get("edgeprobe_traces_purged_total")).toBe(0)
  })

  test("dropping a trace also drops its spans from the in-memory store", async () => {
    await deps.store.insertTrace({
      id: "t_old",
      orgId: "org_acme",
      projectId: "p",
      sessionId: null,
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: null,
      device: {},
      attributes: {},
      sensitive: false,
    })
    await deps.store.insertSpan({
      id: "s_old",
      traceId: "t_old",
      parentSpanId: null,
      name: "x",
      kind: "llm",
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T00:00:01Z",
      durationMs: 1000,
      status: "ok",
      attributes: {},
      includeContent: false,
      promptText: null,
      completionText: null,
      transcriptText: null,
    })
    await runRetentionSweep(deps, 30, new Date("2026-04-17T12:00:00Z"))
    expect(await deps.store.getSpansForTrace("t_old")).toEqual([])
  })
})
