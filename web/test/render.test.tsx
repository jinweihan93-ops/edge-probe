import { describe, test, expect } from "bun:test"
import { Hono } from "hono"
import { createWebApp, type WebDeps } from "../src/server.tsx"
import type {
  PublicTraceResponse,
  PrivateTraceResponse,
  BackendClient,
} from "../src/lib/backend.ts"

/**
 * View-layer PII boundary tests.
 *
 * The backend already enforces that `/r/:token` responses carry no content.
 * These tests prove the web layer does not somehow reintroduce content on
 * the public page (e.g. by pulling it from another endpoint, by fallback
 * rendering, by error messages echoing request bodies).
 *
 * Shape: stub the BackendClient, hand the web app fake responses where
 * public + private responses are BOTH populated with SECRET text (so we
 * could detect a cross-wiring bug where the public route accidentally
 * queried the private endpoint).
 */

const SECRET = "THIS-IS-SECRET-USER-PROMPT-TEXT"

function makeApp(
  overrides: Partial<BackendClient> = {},
  orgBearers: Map<string, string> = new Map([
    ["org_acme", "epk_dash_acme_test_render_xxxxxxxxxx"],
    ["org_competitor", "epk_dash_comp_test_render_xxxxxxxxx"],
  ]),
): { app: Hono } {
  const fakeBackend: BackendClient = {
    fetchPublic: async () => publicResponse(),
    fetchPrivate: async () => ({ status: 200, body: privateResponse() }),
    ...overrides,
  } as BackendClient

  const deps: WebDeps = { backend: fakeBackend, orgBearers }
  return { app: createWebApp(deps) }
}

function publicResponse(): PublicTraceResponse {
  return {
    trace: {
      id: "trace_t1",
      startedAt: "2026-04-15T12:00:00.000Z",
      endedAt: "2026-04-15T12:00:00.600Z",
      device: { model: "iPhone 15 Pro", os: "iOS 18.2" },
      attributes: {},
    },
    spans: [
      {
        id: "s1",
        traceId: "trace_t1",
        parentSpanId: null,
        name: "llama",
        kind: "llm",
        startedAt: "2026-04-15T12:00:00.000Z",
        endedAt: "2026-04-15T12:00:00.600Z",
        durationMs: 600,
        status: "ok",
        // Content fields are NOT present on a PublicSpan — this matches the
        // backend's /r/:token response shape exactly.
        attributes: { "gen_ai.request.model": "llama-3.2-3b" },
      },
    ],
  }
}

function privateResponse(): PrivateTraceResponse {
  return {
    trace: {
      id: "trace_t1",
      orgId: "org_acme",
      projectId: "proj_voice",
      sessionId: null,
      startedAt: "2026-04-15T12:00:00.000Z",
      endedAt: "2026-04-15T12:00:00.600Z",
      device: { model: "iPhone 15 Pro", os: "iOS 18.2" },
      attributes: {},
      sensitive: false,
    },
    spans: [
      {
        id: "s1",
        traceId: "trace_t1",
        parentSpanId: null,
        name: "llama",
        kind: "llm",
        startedAt: "2026-04-15T12:00:00.000Z",
        endedAt: "2026-04-15T12:00:00.600Z",
        durationMs: 600,
        status: "ok",
        attributes: { "gen_ai.request.model": "llama-3.2-3b" },
        includeContent: true,
        promptText: SECRET,
        completionText: SECRET + "-completion",
        transcriptText: null,
      },
    ],
  }
}

describe("Public share HTML — PII boundary at view layer", () => {
  test("GET /r/:token renders HTML with 200 and metric tiles", async () => {
    const { app } = makeApp()
    const res = await app.request("/r/any-token")
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain("<html")
    expect(html).toContain("metric-tile")
    expect(html).toContain("waterfall")
    expect(html).toContain("llama-3.2-3b")
  })

  test("GET /r/:token HTML contains no SECRET strings even if the fake backend sent them", async () => {
    const { app } = makeApp({
      // Hostile backend: returns prompt text on the public endpoint (shouldn't happen,
      // but proves our view layer doesn't look for it).
      fetchPublic: async () =>
        ({
          ...publicResponse(),
          spans: [
            // Cast because PublicSpan type does NOT have content fields.
            // We're forcing the stub to include them to prove the view layer ignores them.
            { ...publicResponse().spans[0], promptText: SECRET, completionText: SECRET } as unknown as PublicTraceResponse["spans"][0],
          ],
        }) as PublicTraceResponse,
    } as Partial<BackendClient>)
    const res = await app.request("/r/any-token")
    const html = await res.text()
    expect(html).not.toContain(SECRET)
  })

  test("GET /r/:token returns 404 HTML when backend says no", async () => {
    const { app } = makeApp({
      fetchPublic: async () => null,
    } as Partial<BackendClient>)
    const res = await app.request("/r/bogus")
    expect(res.status).toBe(404)
    const html = await res.text()
    expect(html).toContain("Not found")
    // The copy deliberately lists multiple possible reasons (expired / revoked /
    // never existed) without committing to one — an attacker cannot tell which
    // failure mode fired. So we check the opposite: no definite language that
    // would out a specific failure.
    expect(html).not.toContain("Token is tampered")
    expect(html).not.toContain("This trace is sensitive")
    expect(html).not.toContain("Signature invalid")
  })
})

describe("Private trace HTML — auth'd dashboard", () => {
  test("GET /app/trace/:id with ?org= renders content block containing prompt text", async () => {
    const { app } = makeApp()
    const res = await app.request("/app/trace/trace_t1?org=org_acme")
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain("Captured content")
    expect(html).toContain(SECRET) // the prompt text IS visible to the authed org
    expect(html).toContain("content-block__body")
  })

  test("GET /app/trace/:id without any org context renders 401 not-found", async () => {
    // Empty orgBearers — the caller has no session, so there's no implicit
    // single-org default to fall back on.
    const { app } = makeApp({}, new Map())
    const res = await app.request("/app/trace/trace_t1")
    expect(res.status).toBe(401)
    const html = await res.text()
    expect(html).toContain("Not found")
  })

  test("GET /app/trace/:id with ?org= for an org we have no bearer for → 401 not-found", async () => {
    // Prevents "flip the query param to probe a foreign org's traces".
    // Only orgs present in orgBearers are reachable.
    const { app } = makeApp({}, new Map([["org_acme", "epk_dash_acme_test_0000000000000000"]]))
    const res = await app.request("/app/trace/trace_t1?org=org_stranger")
    expect(res.status).toBe(401)
    const html = await res.text()
    expect(html).toContain("Not found")
  })

  test("GET /app/trace/:id when backend returns 403 renders not-found (never leak existence)", async () => {
    const { app } = makeApp({
      fetchPrivate: async () => ({ status: 403, body: null }),
    } as Partial<BackendClient>)
    const res = await app.request("/app/trace/trace_t1?org=org_competitor")
    expect(res.status).toBe(403)
    const html = await res.text()
    expect(html).toContain("Not found")
    expect(html).not.toContain("forbidden")
  })

  test("GET /app/trace/:id when backend returns 404 renders not-found", async () => {
    const { app } = makeApp({
      fetchPrivate: async () => ({ status: 404, body: null }),
    } as Partial<BackendClient>)
    const res = await app.request("/app/trace/nope?org=org_acme")
    expect(res.status).toBe(404)
  })
})

describe("OG + social unfurl metadata", () => {
  test("public page declares og:title + og:description that carry no prompt text", async () => {
    const { app } = makeApp()
    const res = await app.request("/r/tok")
    const html = await res.text()
    expect(html).toContain('property="og:title"')
    expect(html).toContain('property="og:description"')
    const ogDescMatch = html.match(/property="og:description" content="([^"]+)"/)
    expect(ogDescMatch).not.toBeNull()
    expect(ogDescMatch![1]).not.toContain(SECRET)
    expect(ogDescMatch![1]).toMatch(/\d+ ms turn/)
  })

  test("public page emits og:image pointing at same-origin /og/:token.png", async () => {
    const { app } = makeApp()
    const res = await app.request("http://dashboard.example/r/tok.abc")
    const html = await res.text()
    // Same-origin URL (host = dashboard.example), token URL-encoded.
    expect(html).toContain('property="og:image"')
    expect(html).toMatch(/property="og:image" content="http:\/\/dashboard\.example\/og\/tok\.abc\.png"/)
    // With an og:image, the twitter card upgrades to summary_large_image.
    expect(html).toContain('name="twitter:card" content="summary_large_image"')
  })

  test("og:image URL URL-encodes the token safely (no HTML injection)", async () => {
    const { app } = makeApp()
    const res = await app.request("http://x/r/" + encodeURIComponent("weird token"))
    const html = await res.text()
    // The ` ` in "weird token" must be %20 inside the og:image URL, not a literal space.
    expect(html).not.toMatch(/og:image" content="[^"]*weird token[^"]*\.png"/)
    expect(html).toMatch(/og:image" content="[^"]*weird(%20|\+)token[^"]*\.png"/)
  })
})

describe("OG proxy — /og/:filename", () => {
  function deps(fetchOgPng: BackendClient["fetchOgPng"]): WebDeps {
    const fakeBackend = {
      fetchPublic: async () => null,
      fetchPrivate: async () => ({ status: 404, body: null }),
      fetchOgPng,
    } as unknown as BackendClient
    return { backend: fakeBackend, orgBearers: new Map() }
  }

  test("proxies a 200 PNG with backend's Cache-Control", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])
    const app = createWebApp(
      deps(async () => ({
        status: 200,
        body: png,
        cacheControl: "public, max-age=3600, immutable",
      })),
    )
    const res = await app.request("/og/tok.abc.png")
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("image/png")
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600, immutable")
    expect(res.headers.get("Content-Length")).toBe(String(png.length))
    const body = new Uint8Array(await res.arrayBuffer())
    expect(body.length).toBe(png.length)
    expect(body[0]).toBe(0x89)
  })

  test("proxies a 404 fallback PNG (never leaks failure reason)", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const app = createWebApp(
      deps(async () => ({
        status: 404,
        body: png,
        cacheControl: "public, max-age=300",
      })),
    )
    const res = await app.request("/og/not-a-token.png")
    expect(res.status).toBe(404)
    expect(res.headers.get("Content-Type")).toBe("image/png")
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300")
  })

  test("returns 502 when backend is unreachable (null response)", async () => {
    const app = createWebApp(deps(async () => null))
    const res = await app.request("/og/anything.png")
    expect(res.status).toBe(502)
  })
})

describe("Healthz", () => {
  test("GET /healthz returns ok", async () => {
    const { app } = makeApp()
    const res = await app.request("/healthz")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})
