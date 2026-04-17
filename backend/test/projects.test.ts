import { describe, test, expect, beforeEach } from "bun:test"
import { createApp, makeMemoryDeps, type AppDeps } from "../src/server.ts"
import type { StoredSpan, Trace } from "../src/views.ts"

/**
 * `/app/projects` + `/app/projects/:projectId/traces` tests.
 *
 * The dashboard home depends on two invariants:
 *   1. A user NEVER sees projects or traces from another org — even if they
 *      probe with known-good project ids. We seed two orgs with deliberately
 *      overlapping project names to make this bug observable if it existed.
 *   2. Pagination is cursor-based on `startedAt`. A client that passes
 *      `before=<prev-last-startedAt>` sees strictly earlier rows. No gap,
 *      no double-read, no reliance on `offset`.
 */

const SECRET = "z".repeat(48)

function deps(): AppDeps {
  return makeMemoryDeps(SECRET)
}

const DASH_ACME = "epk_dash_acme_test_0000000000000000"
const DASH_COMP = "epk_dash_comp_test_0000000000000000"

function mkTrace(
  id: string,
  orgId: string,
  projectId: string,
  startedAt: string,
  extras: Partial<Trace> = {},
): Trace {
  return {
    id,
    orgId,
    projectId,
    sessionId: null,
    startedAt,
    endedAt: extras.endedAt ?? null,
    device: extras.device ?? { model: "iPhone 15 Pro" },
    attributes: extras.attributes ?? {},
    sensitive: extras.sensitive ?? false,
  }
}

function mkSpan(id: string, traceId: string, extras: Partial<StoredSpan> = {}): StoredSpan {
  return {
    id,
    traceId,
    parentSpanId: null,
    name: extras.name ?? "llama.prefill",
    kind: extras.kind ?? "llm",
    startedAt: extras.startedAt ?? "2026-04-17T12:00:00.000Z",
    endedAt: extras.endedAt ?? "2026-04-17T12:00:00.600Z",
    durationMs: extras.durationMs ?? 600,
    status: extras.status ?? "ok",
    attributes: extras.attributes ?? { "gen_ai.request.model": "llama-3B" },
    includeContent: extras.includeContent ?? false,
    promptText: extras.promptText ?? null,
    completionText: extras.completionText ?? null,
    transcriptText: extras.transcriptText ?? null,
  }
}

describe("GET /app/projects — auth + cross-org isolation", () => {
  let d: AppDeps
  beforeEach(() => { d = deps() })

  test("401 without bearer", async () => {
    const app = createApp(d)
    const res = await app.fetch(new Request("http://x/app/projects"))
    expect(res.status).toBe(401)
  })

  test("empty list for an org with no traces", async () => {
    const app = createApp(d)
    const res = await app.fetch(
      new Request("http://x/app/projects", {
        headers: { Authorization: `Bearer ${DASH_ACME}` },
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projects: unknown[] }
    expect(body.projects).toEqual([])
  })

  test("rolls up per project, newest-first by lastTraceAt, correct counts", async () => {
    await d.store.insertTrace(mkTrace("t1", "org_acme", "proj_voice", "2026-04-17T11:00:00Z"))
    await d.store.insertTrace(mkTrace("t2", "org_acme", "proj_voice", "2026-04-17T12:00:00Z"))
    await d.store.insertTrace(mkTrace("t3", "org_acme", "proj_chat", "2026-04-17T10:00:00Z"))

    const app = createApp(d)
    const res = await app.fetch(
      new Request("http://x/app/projects", {
        headers: { Authorization: `Bearer ${DASH_ACME}` },
      }),
    )
    const body = (await res.json()) as {
      projects: Array<{ projectId: string; lastTraceAt: string; traceCount: number }>
    }
    expect(body.projects).toHaveLength(2)
    // Newest first — proj_voice's latest is 12:00, proj_chat's is 10:00.
    expect(body.projects[0]!.projectId).toBe("proj_voice")
    expect(body.projects[0]!.traceCount).toBe(2)
    expect(body.projects[0]!.lastTraceAt).toBe("2026-04-17T12:00:00Z")
    expect(body.projects[1]!.projectId).toBe("proj_chat")
    expect(body.projects[1]!.traceCount).toBe(1)
  })

  test("cross-org: acme cannot see competitor's project (even with same name)", async () => {
    // Deliberately overlapping project names.
    await d.store.insertTrace(
      mkTrace("t_a", "org_acme", "proj_shared", "2026-04-17T12:00:00Z"),
    )
    await d.store.insertTrace(
      mkTrace("t_c", "org_competitor", "proj_shared", "2026-04-17T11:00:00Z"),
    )

    const app = createApp(d)
    const res = await app.fetch(
      new Request("http://x/app/projects", {
        headers: { Authorization: `Bearer ${DASH_COMP}` },
      }),
    )
    const body = (await res.json()) as {
      projects: Array<{ projectId: string; traceCount: number }>
    }
    expect(body.projects).toHaveLength(1)
    expect(body.projects[0]!.projectId).toBe("proj_shared")
    // Count MUST be 1, not 2 — the acme trace must not be mixed in.
    expect(body.projects[0]!.traceCount).toBe(1)
  })
})

describe("GET /app/projects/:projectId/traces — pagination + isolation", () => {
  let d: AppDeps
  beforeEach(() => { d = deps() })

  async function seedNTraces(n: number, projectId = "proj_voice", orgId = "org_acme") {
    // IDs are namespaced by org so two concurrent seeds don't collide on
    // the in-memory store's primary key.
    const shortOrg = orgId === "org_acme" ? "a" : orgId === "org_competitor" ? "c" : orgId
    for (let i = 0; i < n; i++) {
      const startedAt = new Date(Date.UTC(2026, 3, 17, 12, 0, 0, 0) - i * 1000).toISOString()
      const endedAt = new Date(Date.UTC(2026, 3, 17, 12, 0, 0, 500) - i * 1000).toISOString()
      const t = mkTrace(`t_${shortOrg}_${i}`, orgId, projectId, startedAt, { endedAt })
      await d.store.insertTrace(t)
      await d.store.insertSpan(mkSpan(`s_${shortOrg}_${i}`, t.id))
    }
  }

  test("401 without bearer", async () => {
    const app = createApp(d)
    const res = await app.fetch(
      new Request("http://x/app/projects/proj_voice/traces"),
    )
    expect(res.status).toBe(401)
  })

  test("empty list for a project that has no traces for this org", async () => {
    const app = createApp(d)
    const res = await app.fetch(
      new Request("http://x/app/projects/nope/traces", {
        headers: { Authorization: `Bearer ${DASH_ACME}` },
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { traces: unknown[] }
    expect(body.traces).toEqual([])
  })

  test("newest-first with summary fields + default limit 25", async () => {
    await seedNTraces(30)
    const app = createApp(d)
    const res = await app.fetch(
      new Request("http://x/app/projects/proj_voice/traces", {
        headers: { Authorization: `Bearer ${DASH_ACME}` },
      }),
    )
    const body = (await res.json()) as {
      traces: Array<{
        id: string
        startedAt: string
        durationMs: number | null
        status: "ok" | "error"
        sensitive: boolean
        modelName: string | null
        deviceModel: string | null
        spanCount: number
      }>
    }
    expect(body.traces).toHaveLength(25)
    expect(body.traces[0]!.id).toBe("t_a_0") // t_a_0 has the newest startedAt
    // sanity: durationMs ≈ 500ms
    expect(body.traces[0]!.durationMs).toBe(500)
    expect(body.traces[0]!.modelName).toBe("llama-3B")
    expect(body.traces[0]!.deviceModel).toBe("iPhone 15 Pro")
    expect(body.traces[0]!.spanCount).toBe(1)
    // monotonically decreasing
    for (let i = 1; i < body.traces.length; i++) {
      expect(body.traces[i]!.startedAt < body.traces[i - 1]!.startedAt).toBe(true)
    }
  })

  test("limit=5 returns 5", async () => {
    await seedNTraces(30)
    const app = createApp(d)
    const res = await app.fetch(
      new Request("http://x/app/projects/proj_voice/traces?limit=5", {
        headers: { Authorization: `Bearer ${DASH_ACME}` },
      }),
    )
    const body = (await res.json()) as { traces: unknown[] }
    expect(body.traces).toHaveLength(5)
  })

  test("limit is capped at 100 even if caller asks for 1000", async () => {
    await seedNTraces(150)
    const app = createApp(d)
    const res = await app.fetch(
      new Request("http://x/app/projects/proj_voice/traces?limit=1000", {
        headers: { Authorization: `Bearer ${DASH_ACME}` },
      }),
    )
    const body = (await res.json()) as { traces: unknown[] }
    expect(body.traces).toHaveLength(100)
  })

  test("invalid limit returns 400", async () => {
    const app = createApp(d)
    const res = await app.fetch(
      new Request("http://x/app/projects/proj_voice/traces?limit=abc", {
        headers: { Authorization: `Bearer ${DASH_ACME}` },
      }),
    )
    expect(res.status).toBe(400)
  })

  test("before=<cursor> returns strictly earlier traces and no duplicates", async () => {
    await seedNTraces(10)
    const app = createApp(d)
    const firstRes = await app.fetch(
      new Request("http://x/app/projects/proj_voice/traces?limit=3", {
        headers: { Authorization: `Bearer ${DASH_ACME}` },
      }),
    )
    const first = (await firstRes.json()) as {
      traces: Array<{ id: string; startedAt: string }>
    }
    expect(first.traces).toHaveLength(3)
    const lastSeen = first.traces[2]!.startedAt

    const secondRes = await app.fetch(
      new Request(
        `http://x/app/projects/proj_voice/traces?limit=3&before=${encodeURIComponent(lastSeen)}`,
        { headers: { Authorization: `Bearer ${DASH_ACME}` } },
      ),
    )
    const second = (await secondRes.json()) as {
      traces: Array<{ id: string; startedAt: string }>
    }
    expect(second.traces).toHaveLength(3)
    // No overlap
    const firstIds = new Set(first.traces.map((t) => t.id))
    for (const t of second.traces) {
      expect(firstIds.has(t.id)).toBe(false)
      expect(t.startedAt < lastSeen).toBe(true)
    }
  })

  test("cross-org: acme cannot list competitor's traces even at the same projectId", async () => {
    await seedNTraces(3, "proj_shared", "org_acme")
    await seedNTraces(5, "proj_shared", "org_competitor")
    const app = createApp(d)
    const res = await app.fetch(
      new Request("http://x/app/projects/proj_shared/traces", {
        headers: { Authorization: `Bearer ${DASH_ACME}` },
      }),
    )
    const body = (await res.json()) as { traces: Array<{ id: string }> }
    expect(body.traces).toHaveLength(3)
    for (const t of body.traces) {
      // Every id must belong to the acme set (t_a_0..t_a_2). If the cross-org
      // filter regressed we'd see `t_c_*` ids mixed in.
      expect(t.id.startsWith("t_a_")).toBe(true)
    }
  })

  test("sensitive flag propagates to the list row", async () => {
    await d.store.insertTrace(
      mkTrace("t_sens", "org_acme", "proj_voice", "2026-04-17T12:00:00Z", {
        sensitive: true,
        endedAt: "2026-04-17T12:00:01Z",
      }),
    )
    const app = createApp(d)
    const res = await app.fetch(
      new Request("http://x/app/projects/proj_voice/traces", {
        headers: { Authorization: `Bearer ${DASH_ACME}` },
      }),
    )
    const body = (await res.json()) as { traces: Array<{ sensitive: boolean }> }
    expect(body.traces[0]!.sensitive).toBe(true)
  })
})
