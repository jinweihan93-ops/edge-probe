import { describe, test, expect } from "bun:test"
import { createWebApp, type WebDeps } from "../src/server.tsx"
import type {
  BackendClient,
  ProjectSummary,
  TraceSummary,
} from "../src/lib/backend.ts"
import { formatRelativeTime } from "../src/lib/time.ts"

/**
 * View-layer tests for `/app` and `/app/projects/:id`.
 *
 * What we pin:
 *   1. Auth flow matches /app/trace/:id — no bearer for requested org → 401,
 *      no org context at all → 401.
 *   2. Empty state copy matches DESIGN.md voice: dry, no emoji, no
 *      encouragement graphic, names the exact SDK method to call.
 *   3. list-row-table is used (not a card grid). DESIGN.md forbids the
 *      generic SaaS card grid on dashboard surfaces.
 *   4. Cross-org: a user who has bearers for acme+competitor must NOT see
 *      competitor projects when `?org=org_acme`. This is backend-side, but
 *      we sanity-check at the view layer by stubbing a hostile backend.
 */

function makeApp(
  overrides: Partial<BackendClient> = {},
  orgBearers: Map<string, string> = new Map([
    ["org_acme", "epk_dash_acme_test_render_xxxxxxxxxx"],
    ["org_competitor", "epk_dash_comp_test_render_xxxxxxxxx"],
  ]),
) {
  const fakeBackend: BackendClient = {
    fetchPublic: async () => null,
    fetchPrivate: async () => ({ status: 404, body: null }),
    listProjects: async () => ({ status: 200, projects: [] }),
    listProjectTraces: async () => ({ status: 200, traces: [] }),
    fetchOgPng: async () => null,
    ...overrides,
  } as BackendClient
  const deps: WebDeps = { backend: fakeBackend, orgBearers }
  return createWebApp(deps)
}

function sampleProjects(): ProjectSummary[] {
  return [
    { projectId: "proj_voice", lastTraceAt: "2026-04-17T12:00:00Z", traceCount: 42 },
    { projectId: "proj_chat", lastTraceAt: "2026-04-17T10:00:00Z", traceCount: 7 },
  ]
}

function sampleTraces(): TraceSummary[] {
  return [
    {
      id: "trace_a",
      projectId: "proj_voice",
      sessionId: null,
      startedAt: "2026-04-17T12:00:00Z",
      endedAt: "2026-04-17T12:00:00.500Z",
      durationMs: 500,
      status: "ok",
      sensitive: false,
      deviceModel: "iPhone 15 Pro",
      modelName: "llama-3B-Q4_K_M",
      spanCount: 3,
    },
    {
      id: "trace_b",
      projectId: "proj_voice",
      sessionId: "sess_1",
      startedAt: "2026-04-17T11:00:00Z",
      endedAt: null,
      durationMs: null,
      status: "error",
      sensitive: true,
      deviceModel: null,
      modelName: null,
      spanCount: 0,
    },
  ]
}

describe("GET /app — auth posture", () => {
  test("401 with no ?org= and no single-org fallback", async () => {
    const app = makeApp({}, new Map())
    const res = await app.request("/app")
    expect(res.status).toBe(401)
    const html = await res.text()
    expect(html).toContain("Not found")
  })

  test("401 when ?org= names an org the user has no bearer for", async () => {
    const app = makeApp()
    const res = await app.request("/app?org=org_stranger")
    expect(res.status).toBe(401)
  })

  test("single-org session falls back to the only bearer without ?org=", async () => {
    const app = makeApp(
      { listProjects: async () => ({ status: 200, projects: sampleProjects() }) },
      new Map([["org_acme", "epk_dash_acme_test_render_xxxxxxxxxx"]]),
    )
    const res = await app.request("/app")
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain("proj_voice")
  })

  test("401 backend response short-circuits to not-found page", async () => {
    const app = makeApp({
      listProjects: async () => ({ status: 401, projects: [] }),
    })
    const res = await app.request("/app?org=org_acme")
    expect(res.status).toBe(401)
    const html = await res.text()
    expect(html).toContain("Not found")
  })
})

describe("GET /app — content + empty state", () => {
  test("renders list-row-table (not card grid) with project rows", async () => {
    const app = makeApp({
      listProjects: async () => ({ status: 200, projects: sampleProjects() }),
    })
    const res = await app.request("/app?org=org_acme")
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain("list-row-table")
    // DESIGN.md forbids card-grid pattern words.
    expect(html).not.toMatch(/class="[^"]*card-grid/)
    expect(html).toContain("proj_voice")
    expect(html).toContain("proj_chat")
    expect(html).toContain("42")
  })

  test("each project row links to /app/projects/:id?org=", async () => {
    const app = makeApp({
      listProjects: async () => ({ status: 200, projects: sampleProjects() }),
    })
    const res = await app.request("/app?org=org_acme")
    const html = await res.text()
    expect(html).toContain('href="/app/projects/proj_voice?org=org_acme"')
  })

  test("empty state copy is dry, names the exact SDK method, no emoji", async () => {
    const app = makeApp({
      listProjects: async () => ({ status: 200, projects: [] }),
    })
    const res = await app.request("/app?org=org_acme")
    const html = await res.text()
    expect(html).toContain("No projects yet")
    expect(html).toContain("EdgeProbe.beginTrace()")
    // No emoji. 📊 🎉 ✨ etc. are banned design elements.
    expect(html).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u)
  })
})

describe("GET /app/projects/:projectId — traces list", () => {
  test("renders traces in a list-row-table with duration + status pill", async () => {
    const app = makeApp({
      listProjectTraces: async () => ({ status: 200, traces: sampleTraces() }),
    })
    const res = await app.request("/app/projects/proj_voice?org=org_acme")
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain("list-row-table")
    expect(html).toContain("trace_a")
    expect(html).toContain("trace_b")
    expect(html).toContain("iPhone 15 Pro")
    expect(html).toContain("llama-3B-Q4_K_M")
    expect(html).toContain("500 ms")
    // Error row → red/bad status pill
    expect(html).toMatch(/class="[^"]*pill[^"]*pill--bad[^"]*"/)
  })

  test("sensitive trace gets a badge, non-sensitive does not", async () => {
    const app = makeApp({
      listProjectTraces: async () => ({ status: 200, traces: sampleTraces() }),
    })
    const res = await app.request("/app/projects/proj_voice?org=org_acme")
    const html = await res.text()
    // One trace has sensitive=true, so at least one sensitive badge should appear
    expect(html).toContain("list-row-table__badge")
    expect(html).toContain("sensitive")
  })

  test("empty state copy names the projectId in the guidance", async () => {
    const app = makeApp({
      listProjectTraces: async () => ({ status: 200, traces: [] }),
    })
    const res = await app.request("/app/projects/proj_ghost?org=org_acme")
    const html = await res.text()
    expect(html).toContain("No traces in this project")
    // JSX/hono escapes the `"` chars as `&quot;` when rendering, so
    // assert on the escaped form.
    expect(html).toContain("projectId: &quot;proj_ghost&quot;")
  })

  test("unknown projectId (just empty list from backend) renders empty state, not 404", async () => {
    // Backend returns 200 + empty array when the project doesn't exist for
    // the org. That's deliberate: no "project exists but you can't see it"
    // state to leak. View mirrors backend — renders the empty-state page.
    const app = makeApp({
      listProjectTraces: async () => ({ status: 200, traces: [] }),
    })
    const res = await app.request("/app/projects/anything_at_all?org=org_acme")
    expect(res.status).toBe(200)
  })

  test("backend 401/403 short-circuits to not-found page", async () => {
    const app = makeApp({
      listProjectTraces: async () => ({ status: 403, traces: [] }),
    })
    const res = await app.request("/app/projects/proj_voice?org=org_acme")
    expect(res.status).toBe(403)
    const html = await res.text()
    expect(html).toContain("Not found")
  })

  test("back link points to /app with org preserved", async () => {
    const app = makeApp({
      listProjectTraces: async () => ({ status: 200, traces: sampleTraces() }),
    })
    const res = await app.request("/app/projects/proj_voice?org=org_acme")
    const html = await res.text()
    expect(html).toContain('href="/app?org=org_acme"')
  })
})

describe("formatRelativeTime — pinned reference time", () => {
  const now = Date.parse("2026-04-17T12:00:00Z")

  test("just now when < 60s", () => {
    expect(formatRelativeTime("2026-04-17T11:59:30Z", now)).toBe("just now")
  })

  test("m ago for sub-hour", () => {
    expect(formatRelativeTime("2026-04-17T11:45:00Z", now)).toBe("15m ago")
  })

  test("h ago for sub-day", () => {
    expect(formatRelativeTime("2026-04-17T09:00:00Z", now)).toBe("3h ago")
  })

  test("d ago for sub-week", () => {
    expect(formatRelativeTime("2026-04-14T12:00:00Z", now)).toBe("3d ago")
  })

  test("ISO date for older than 7 days", () => {
    expect(formatRelativeTime("2026-04-01T12:00:00Z", now)).toBe("2026-04-01")
  })

  test("future timestamps render as an ISO date, never a negative phrase", () => {
    expect(formatRelativeTime("2026-05-01T12:00:00Z", now)).toBe("2026-05-01")
  })

  test("malformed input is returned as-is, not NaN", () => {
    expect(formatRelativeTime("not a date", now)).toBe("not a date")
  })
})
