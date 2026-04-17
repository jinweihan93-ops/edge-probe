import { describe, test, expect, beforeEach } from "bun:test"
import { createApp, makeMemoryDeps, type AppDeps } from "../src/server.ts"
import type { StoredSpan, Trace } from "../src/views.ts"
import {
  TEST_DASHBOARD_KEY_ACME,
  TEST_DASHBOARD_KEY_COMPETITOR,
} from "../src/auth.ts"

/**
 * PII boundary regression tests — the six Critical Paths, minus the iOS-only ones.
 * These guard the whole product. They run in CI, they block merge.
 *
 * If any of these fail, EdgeProbe leaks user prompts. The product is dead.
 *
 * Dashboard auth: `/app/*` uses `Authorization: Bearer epk_dash_...` where
 * the bearer maps to an orgId via the boot-time table. See src/auth.ts.
 */

const TEST_SHARE_SECRET = "x".repeat(48)
const BEARER_ACME = { Authorization: `Bearer ${TEST_DASHBOARD_KEY_ACME}` }
const BEARER_COMP = { Authorization: `Bearer ${TEST_DASHBOARD_KEY_COMPETITOR}` }

function freshDeps(): AppDeps {
  return makeMemoryDeps(TEST_SHARE_SECRET)
}

async function seedTraceWithContent(deps: AppDeps) {
  const trace: Trace = {
    id: "trace_abc",
    orgId: "org_acme",
    projectId: "proj_voice",
    sessionId: "sess_1",
    startedAt: "2026-04-15T12:00:00Z",
    endedAt: "2026-04-15T12:00:01Z",
    device: { model: "iPhone 15 Pro", os: "iOS 18.2" },
    attributes: { "build.commit": "abc123" },
    sensitive: false,
  }
  await deps.store.insertTrace(trace)

  const promptSpan: StoredSpan = {
    id: "span_prompt",
    traceId: "trace_abc",
    parentSpanId: null,
    name: "llama-decode",
    kind: "llm",
    startedAt: "2026-04-15T12:00:00.100Z",
    endedAt: "2026-04-15T12:00:00.700Z",
    durationMs: 600,
    status: "ok",
    attributes: {
      "gen_ai.request.model": "llama-3.2-3b-instruct-q4",
      "gen_ai.prompt": "THIS IS THE SECRET USER PROMPT — DO NOT LEAK",
      "gen_ai.completion": "THIS IS THE SECRET COMPLETION — DO NOT LEAK",
      "content.transcript": "another secret",
    },
    includeContent: true,
    promptText: "THIS IS THE SECRET USER PROMPT — DO NOT LEAK",
    completionText: "THIS IS THE SECRET COMPLETION — DO NOT LEAK",
    transcriptText: "also secret audio transcript",
  }
  await deps.store.insertSpan(promptSpan)

  return { trace, promptSpan }
}

/** Mint a valid share token for the seeded trace directly via the signer. */
function mintToken(deps: AppDeps, traceId = "trace_abc", orgId = "org_acme") {
  return deps.signer.sign({
    traceId,
    orgId,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  })
}

describe("Critical Path #1: public share never renders prompt/completion text", () => {
  let app: ReturnType<typeof createApp>
  let deps: AppDeps

  beforeEach(async () => {
    deps = freshDeps()
    app = createApp(deps)
    await seedTraceWithContent(deps)
  })

  test("GET /r/:token response JSON contains no content fields", async () => {
    const token = mintToken(deps)
    const res = await app.request(`/r/${token}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { spans: unknown[] }
    const raw = JSON.stringify(body)

    expect(raw).not.toContain("THIS IS THE SECRET USER PROMPT")
    expect(raw).not.toContain("THIS IS THE SECRET COMPLETION")
    expect(raw).not.toContain("secret audio transcript")
    expect(raw).not.toContain("another secret")

    // Structural check: span objects have no prompt/completion/transcript keys.
    for (const span of body.spans as Record<string, unknown>[]) {
      expect(span).not.toHaveProperty("promptText")
      expect(span).not.toHaveProperty("completionText")
      expect(span).not.toHaveProperty("transcriptText")
      expect(span).not.toHaveProperty("includeContent")
    }
  })

  test("GET /r/:token strips content-keyed attributes even if stored", async () => {
    const token = mintToken(deps)
    const res = await app.request(`/r/${token}`)
    const body = (await res.json()) as { spans: Array<{ attributes: Record<string, unknown> }> }
    for (const span of body.spans) {
      expect(span.attributes).not.toHaveProperty("gen_ai.prompt")
      expect(span.attributes).not.toHaveProperty("gen_ai.completion")
      expect(span.attributes).not.toHaveProperty("content.transcript")
      expect(span.attributes).not.toHaveProperty("user.input")
      expect(span.attributes).not.toHaveProperty("user.output")
    }
  })

  test("sensitive:true trace returns 404, not a redacted render", async () => {
    await deps.store.insertTrace({
      id: "trace_sensitive",
      orgId: "org_acme",
      projectId: "proj_voice",
      sessionId: null,
      startedAt: "2026-04-15T12:00:00Z",
      endedAt: null,
      device: {},
      attributes: {},
      sensitive: true,
    })
    const token = mintToken(deps, "trace_sensitive", "org_acme")
    const res = await app.request(`/r/${token}`)
    expect(res.status).toBe(404)
  })
})

describe("Critical Path #3: per-call includeContent:true does not escalate public visibility", () => {
  test("even with includeContent:true, public view hides content", async () => {
    const deps = freshDeps()
    const app = createApp(deps)
    await seedTraceWithContent(deps) // stored span has includeContent: true and text fields populated

    const token = mintToken(deps)
    const pub = await (await app.request(`/r/${token}`)).json()
    const raw = JSON.stringify(pub)
    expect(raw).not.toContain("SECRET USER PROMPT")

    // And the private view DOES have it (authed requester from same org)
    const priv = await (
      await app.request("/app/trace/trace_abc", { headers: BEARER_ACME })
    ).json()
    const privRaw = JSON.stringify(priv)
    expect(privRaw).toContain("SECRET USER PROMPT")
    expect(privRaw).toContain("SECRET COMPLETION")
  })
})

describe("Critical Path #2: cross-org access returns 403, not 404", () => {
  test("auth'd requester from another org gets 403 (not 404 — never leak existence)", async () => {
    const deps = freshDeps()
    const app = createApp(deps)
    await seedTraceWithContent(deps) // stored under org_acme

    const res = await app.request("/app/trace/trace_abc", {
      headers: BEARER_COMP,
    })
    expect(res.status).toBe(403)

    // A truly-missing trace returns 404 for the same requester, so we have a
    // tangible difference that an attacker could probe — that is exactly why
    // 403 on wrong-org matters: the response codes are DIFFERENT on purpose,
    // and wrong-org must NEVER fall through to the "not found" path.
    const missing = await app.request("/app/trace/trace_nope", {
      headers: BEARER_COMP,
    })
    expect(missing.status).toBe(404)
  })

  test("unauthenticated request returns 401", async () => {
    const deps = freshDeps()
    const app = createApp(deps)
    await seedTraceWithContent(deps)

    const res = await app.request("/app/trace/trace_abc")
    expect(res.status).toBe(401)
  })
})

describe("Share tokens: /r/:token must be unforgeable, raw trace-ids do not work", () => {
  let deps: AppDeps
  let app: ReturnType<typeof createApp>

  beforeEach(async () => {
    deps = freshDeps()
    app = createApp(deps)
    await seedTraceWithContent(deps)
  })

  test("GET /r/<raw-traceId> returns 404 — not a token", async () => {
    // Before share tokens existed this worked. It must not anymore.
    const res = await app.request("/r/trace_abc")
    expect(res.status).toBe(404)
  })

  test("GET /r/<tampered-token> returns 404", async () => {
    const token = mintToken(deps)
    // Flip one character in the body half.
    const [body, sig] = token.split(".")
    const tampered = `${body.slice(0, -1)}${body.endsWith("a") ? "b" : "a"}.${sig}`
    const res = await app.request(`/r/${tampered}`)
    expect(res.status).toBe(404)
  })

  test("GET /r/<expired-token> returns 404", async () => {
    const expired = deps.signer.sign({
      traceId: "trace_abc",
      orgId: "org_acme",
      expiresAt: Math.floor(Date.now() / 1000) - 10,
    })
    const res = await app.request(`/r/${expired}`)
    expect(res.status).toBe(404)
  })

  test("GET /r/<token-for-nonexistent-trace> returns 404", async () => {
    const token = deps.signer.sign({
      traceId: "trace_never_existed",
      orgId: "org_acme",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    })
    const res = await app.request(`/r/${token}`)
    expect(res.status).toBe(404)
  })

  test("GET /r/<token-with-wrong-org> returns 404 (defense in depth)", async () => {
    // Someone mints a token claiming the trace belongs to their org.
    // The server must re-check trace.orgId against payload.orgId.
    const sneaky = deps.signer.sign({
      traceId: "trace_abc",
      orgId: "org_attacker",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    })
    const res = await app.request(`/r/${sneaky}`)
    expect(res.status).toBe(404)
  })
})

describe("POST /app/trace/:id/share: auth'd mint endpoint", () => {
  let deps: AppDeps
  let app: ReturnType<typeof createApp>

  beforeEach(async () => {
    deps = freshDeps()
    app = createApp(deps)
    await seedTraceWithContent(deps)
  })

  test("returns 201 with { token, url, expiresAt } for the owning org", async () => {
    const res = await app.request("/app/trace/trace_abc/share", {
      method: "POST",
      headers: { ...BEARER_ACME, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { token: string; url: string; expiresAt: number }
    expect(typeof body.token).toBe("string")
    expect(body.token.split(".").length).toBe(2)
    expect(body.url).toBe(`/r/${body.token}`)
    expect(body.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000))

    // The minted token actually works against /r/:token.
    const pub = await app.request(body.url)
    expect(pub.status).toBe(200)
  })

  test("returns 401 without Authorization header", async () => {
    const res = await app.request("/app/trace/trace_abc/share", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
    expect(res.status).toBe(401)
  })

  test("returns 401 with a Bearer value that isn't a known dashboard key", async () => {
    const res = await app.request("/app/trace/trace_abc/share", {
      method: "POST",
      headers: {
        Authorization: "Bearer epk_dash_unknown_key_0000000000",
        "Content-Type": "application/json",
      },
      body: "{}",
    })
    expect(res.status).toBe(401)
  })

  test("returns 403 when a different org tries to mint (never 404 — existence leak)", async () => {
    const res = await app.request("/app/trace/trace_abc/share", {
      method: "POST",
      headers: { ...BEARER_COMP, "Content-Type": "application/json" },
      body: "{}",
    })
    expect(res.status).toBe(403)
  })

  test("returns 404 for a trace that doesn't exist", async () => {
    const res = await app.request("/app/trace/trace_nope/share", {
      method: "POST",
      headers: { ...BEARER_ACME, "Content-Type": "application/json" },
      body: "{}",
    })
    expect(res.status).toBe(404)
  })

  test("caps expiresInSeconds at MAX_SHARE_TTL_SECONDS (30 days)", async () => {
    const res = await app.request("/app/trace/trace_abc/share", {
      method: "POST",
      headers: { ...BEARER_ACME, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresInSeconds: 99999999 }), // ~3 years, should be capped
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { expiresAt: number }
    const maxReasonable = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30 + 5
    expect(body.expiresAt).toBeLessThanOrEqual(maxReasonable)
  })
})

describe("POST /ingest smoke", () => {
  test("accepts valid trace+spans with a minted epk_pub_ key", async () => {
    const deps = freshDeps()
    // Slice 5: ingest auth is now a real hashed-key lookup. Mint one first.
    const { rawToken } = await deps.apiKeyStore.mint("org_acme", "pub", "test-pub")
    const app = createApp(deps)
    const payload = {
      trace: {
        id: "trace_e2e",
        orgId: "org_acme",
        projectId: "proj_voice",
        sessionId: null,
        startedAt: "2026-04-15T12:00:00Z",
        endedAt: null,
        device: {},
        attributes: {},
        sensitive: false,
      },
      spans: [],
    }
    const res = await app.request("/ingest", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${rawToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    })
    expect(res.status).toBe(202)
  })

  test("rejects missing auth header with 401", async () => {
    const app = createApp(freshDeps())
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trace: { id: "x" }, spans: [] }),
    })
    expect(res.status).toBe(401)
  })

  test("rejects non-public key prefix with 401", async () => {
    const deps = freshDeps()
    // Even a *valid* priv key does not authorize /ingest.
    const { rawToken: privToken } = await deps.apiKeyStore.mint("org_acme", "priv", "demo")
    const app = createApp(deps)
    const res = await app.request("/ingest", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${privToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ trace: { id: "x" }, spans: [] }),
    })
    expect(res.status).toBe(401)
  })

  test("rejects a pub-prefixed but unrecognized token with 401 (Slice 5 lookup)", async () => {
    // Shape-valid token that was never seeded: argon2 verify fails → 401.
    // Pre-Slice-5 this would have landed as 400 once we parsed the payload;
    // now we reject before that.
    const app = createApp(freshDeps())
    const res = await app.request("/ingest", {
      method: "POST",
      headers: {
        "Authorization": "Bearer epk_pub_0123456789_abcdef0123456789abcdef0123456789",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ trace: { id: "x" }, spans: [] }),
    })
    expect(res.status).toBe(401)
  })

  test("rejects malformed payload with 400", async () => {
    const deps = freshDeps()
    const { rawToken } = await deps.apiKeyStore.mint("org_acme", "pub", "demo")
    const app = createApp(deps)
    const res = await app.request("/ingest", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${rawToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ not_a_trace: true }),
    })
    expect(res.status).toBe(400)
  })

  test("Slice 5: payload.orgId must equal the key's org or 401", async () => {
    const deps = freshDeps()
    const { rawToken } = await deps.apiKeyStore.mint("org_acme", "pub", "demo")
    const app = createApp(deps)
    // Valid pub key for org_acme, but payload claims org_competitor.
    // Must 401 — a compromised public key cannot scribble into another org.
    const payload = {
      trace: {
        id: "trace_cross",
        orgId: "org_competitor",
        projectId: "p",
        sessionId: null,
        startedAt: "2026-04-15T12:00:00Z",
        endedAt: null,
        device: {},
        attributes: {},
        sensitive: false,
      },
      spans: [],
    }
    const res = await app.request("/ingest", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${rawToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    })
    expect(res.status).toBe(401)
  })

  test("Slice 5: revoked pub key no longer authorizes /ingest", async () => {
    const deps = freshDeps()
    const { rawToken, row } = await deps.apiKeyStore.mint("org_acme", "pub", "demo")
    const app = createApp(deps)
    const payload = {
      trace: {
        id: "trace_pre_revoke",
        orgId: "org_acme",
        projectId: "p",
        sessionId: null,
        startedAt: "2026-04-15T12:00:00Z",
        endedAt: null,
        device: {},
        attributes: {},
        sensitive: false,
      },
      spans: [],
    }
    // Pre-revoke, accepted.
    const okRes = await app.request("/ingest", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${rawToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    })
    expect(okRes.status).toBe(202)

    await deps.apiKeyStore.revoke(row.id)

    const afterRes = await app.request("/ingest", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${rawToken}`,
        "Content-Type": "application/json",
      },
      // Use a different trace id so dedup doesn't muddy the test.
      body: JSON.stringify({ ...payload, trace: { ...payload.trace, id: "trace_post_revoke" } }),
    })
    expect(afterRes.status).toBe(401)
  })
})
