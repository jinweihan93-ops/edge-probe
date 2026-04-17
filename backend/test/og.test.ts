import { describe, test, expect, beforeEach } from "bun:test"
import { createApp, makeMemoryDeps, type AppDeps } from "../src/server.ts"
import { HmacShareTokenSigner } from "../src/shareToken.ts"
import type { StoredSpan, Trace } from "../src/views.ts"
import { deriveCardMetrics, formatMsBig, renderFallbackPng, renderOgPng } from "../src/og.ts"

/**
 * og.test.ts — pins the shape + delivery of the OG unfurl image.
 *
 * What the product depends on:
 *   1. Valid token → 200, image/png, ~20–60 KB, PNG magic bytes, long
 *      cache header. Slack/Twitter can rely on it not moving.
 *   2. Invalid token → 404 with a BRANDED fallback, NEVER the hosting
 *      provider's default "image not available" placeholder. Must be a
 *      valid PNG of its own or unfurls look half-broken.
 *   3. Cross-org scan is indistinguishable from "trace doesn't exist" —
 *      same fallback, same 404. Critical Path #2 extends to OG.
 *   4. Sensitive traces never emit a hero card — same fallback as above.
 *   5. No prompt/completion text EVER appears in the rendered PNG.
 *      Enforced structurally via the public-views read path.
 */

const TEST_SHARE_SECRET = "z".repeat(48)
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b)
}

function freshDeps(): AppDeps {
  return makeMemoryDeps(TEST_SHARE_SECRET)
}

async function seedSharedTrace(deps: AppDeps): Promise<{ traceId: string; token: string }> {
  const trace: Trace = {
    id: "trace_og_happy",
    orgId: "org_acme",
    projectId: "proj_voice",
    sessionId: "sess_1",
    startedAt: "2026-04-17T12:00:00Z",
    endedAt: "2026-04-17T12:00:01Z",
    device: { model: "iPhone 15 Pro", os: "iOS 18.2" },
    attributes: {},
    sensitive: false,
  }
  const span: StoredSpan = {
    id: "span_1",
    traceId: trace.id,
    parentSpanId: null,
    name: "llama.prefill",
    kind: "llm",
    startedAt: "2026-04-17T12:00:00.100Z",
    endedAt: "2026-04-17T12:00:00.900Z",
    durationMs: 800,
    status: "ok",
    attributes: { "gen_ai.request.model": "llama-3B-Q4_K_M" },
    includeContent: false,
    promptText: null,
    completionText: null,
    transcriptText: null,
  }
  await deps.store.insertTrace(trace)
  await deps.store.insertSpan(span)
  const token = deps.signer.sign({
    traceId: trace.id,
    orgId: "org_acme",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  })
  return { traceId: trace.id, token }
}

describe("GET /og/:token.png — happy path", () => {
  let deps: AppDeps
  beforeEach(() => { deps = freshDeps() })

  test("returns a PNG with the right mimetype, cache headers, and PNG signature", async () => {
    const { token } = await seedSharedTrace(deps)
    const app = createApp(deps)
    const res = await app.fetch(new Request(`http://x/og/${token}.png`))

    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("image/png")
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600, immutable")

    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(isPng(bytes)).toBe(true)
    // Size floor — if this drops, something cratered in the renderer.
    // Ceiling is loose; resvg's output is deterministic but can shift a
    // few KB across library versions.
    expect(bytes.length).toBeGreaterThan(5_000)
    expect(bytes.length).toBeLessThan(120_000)
    expect(res.headers.get("Content-Length")).toBe(String(bytes.length))
  })

  test("Content-Length header matches body length", async () => {
    const { token } = await seedSharedTrace(deps)
    const app = createApp(deps)
    const res = await app.fetch(new Request(`http://x/og/${token}.png`))
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(res.headers.get("Content-Length")).toBe(String(bytes.length))
  })
})

describe("GET /og/:token.png — fallback paths all collapse to 404 + branded PNG", () => {
  let deps: AppDeps
  beforeEach(() => { deps = freshDeps() })

  async function hitWithToken(token: string): Promise<Response> {
    const app = createApp(deps)
    return app.fetch(new Request(`http://x/og/${token}.png`))
  }

  test("malformed token → 404 branded PNG", async () => {
    const res = await hitWithToken("not-a-real-token")
    expect(res.status).toBe(404)
    expect(res.headers.get("Content-Type")).toBe("image/png")
    expect(isPng(new Uint8Array(await res.arrayBuffer()))).toBe(true)
  })

  test("token signed with a different secret → 404 branded PNG (no leak)", async () => {
    // Attacker mints a token using their own secret. Our signer rejects
    // the HMAC; we must return the same 404 as a malformed token.
    const evilSigner = new HmacShareTokenSigner("a".repeat(48))
    const evilToken = evilSigner.sign({
      traceId: "trace_og_happy",
      orgId: "org_acme",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    })
    const res = await hitWithToken(evilToken)
    expect(res.status).toBe(404)
    expect(isPng(new Uint8Array(await res.arrayBuffer()))).toBe(true)
  })

  test("valid token but trace is sensitive → 404 branded PNG (never render sensitive)", async () => {
    const trace: Trace = {
      id: "trace_og_sensitive",
      orgId: "org_acme",
      projectId: "proj_voice",
      sessionId: null,
      startedAt: "2026-04-17T12:00:00Z",
      endedAt: "2026-04-17T12:00:01Z",
      device: { model: "iPhone 15 Pro" },
      attributes: {},
      sensitive: true, // the trigger
    }
    await deps.store.insertTrace(trace)
    const token = deps.signer.sign({
      traceId: trace.id, orgId: "org_acme",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    })
    const res = await hitWithToken(token)
    expect(res.status).toBe(404)
    expect(isPng(new Uint8Array(await res.arrayBuffer()))).toBe(true)
  })

  test("valid token but trace is unknown → 404 branded PNG", async () => {
    // Don't seed the trace; mint a token for a nonexistent id.
    const token = deps.signer.sign({
      traceId: "trace_ghost", orgId: "org_acme",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    })
    const res = await hitWithToken(token)
    expect(res.status).toBe(404)
    expect(isPng(new Uint8Array(await res.arrayBuffer()))).toBe(true)
  })

  test("token for trace owned by a different org → 404 (cross-org leak guard)", async () => {
    const trace: Trace = {
      id: "trace_og_competitor",
      orgId: "org_competitor",
      projectId: "proj_voice",
      sessionId: null,
      startedAt: "2026-04-17T12:00:00Z",
      endedAt: "2026-04-17T12:00:01Z",
      device: { model: "Pixel 8" },
      attributes: {},
      sensitive: false,
    }
    await deps.store.insertTrace(trace)
    // Token asserts org_acme, but the trace is org_competitor.
    const token = deps.signer.sign({
      traceId: trace.id, orgId: "org_acme",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    })
    const res = await hitWithToken(token)
    expect(res.status).toBe(404)
    expect(isPng(new Uint8Array(await res.arrayBuffer()))).toBe(true)
  })

  test("expired token → 404", async () => {
    const token = deps.signer.sign({
      traceId: "trace_og_happy", orgId: "org_acme",
      expiresAt: Math.floor(Date.now() / 1000) - 10, // past
    })
    const res = await hitWithToken(token)
    expect(res.status).toBe(404)
    expect(isPng(new Uint8Array(await res.arrayBuffer()))).toBe(true)
  })
})

describe("renderOgPng + renderFallbackPng — unit-level rasterization", () => {
  test("deriveCardMetrics picks up gen_ai.request.model from the first llm span", () => {
    const trace: Trace = {
      id: "t", orgId: "o", projectId: "p", sessionId: null,
      startedAt: "2026-04-17T12:00:00Z", endedAt: "2026-04-17T12:00:01Z",
      device: { model: "iPhone 15 Pro" }, attributes: {}, sensitive: false,
    }
    const spans = [{
      id: "s", traceId: "t", parentSpanId: null,
      name: "llama.prefill", kind: "llm",
      startedAt: "2026-04-17T12:00:00.100Z", endedAt: "2026-04-17T12:00:00.400Z",
      durationMs: 300, status: "ok" as const,
      attributes: { "gen_ai.request.model": "llama-3B-Q4_K_M" },
    }]
    const m = deriveCardMetrics({ trace, spans })
    expect(m.modelName).toBe("llama-3B-Q4_K_M")
    expect(m.deviceModel).toBe("iPhone 15 Pro")
    expect(m.totalMs).toBe(1000)
    expect(m.status).toBe("ok")
    expect(m.spanCount).toBe(1)
  })

  test("formatMsBig: sub-second ms, second-plus two-decimal seconds", () => {
    expect(formatMsBig(980)).toBe("980 ms")
    expect(formatMsBig(1280)).toBe("1.28 s")
    expect(formatMsBig(12345)).toBe("12.35 s")
    expect(formatMsBig(-1)).toBe("—")
    expect(formatMsBig(NaN)).toBe("—")
  })

  test("fallback rasterizes a valid PNG", () => {
    const bytes = renderFallbackPng()
    expect(isPng(bytes)).toBe(true)
    expect(bytes.length).toBeGreaterThan(3_000)
  })

  test("hero rasterizes a valid PNG with the expected dimensions encoded in the header", () => {
    const trace: Trace = {
      id: "t", orgId: "o", projectId: "p", sessionId: null,
      startedAt: "2026-04-17T12:00:00Z", endedAt: "2026-04-17T12:00:01Z",
      device: { model: "iPhone 15 Pro" }, attributes: {}, sensitive: false,
    }
    const bytes = renderOgPng({ trace, spans: [] })
    expect(isPng(bytes)).toBe(true)
    // PNG width + height live at bytes 16–23 (big-endian u32 each).
    // We fit to width=1200, so expect 1200×630.
    const width = (bytes[16]! << 24) | (bytes[17]! << 16) | (bytes[18]! << 8) | bytes[19]!
    const height = (bytes[20]! << 24) | (bytes[21]! << 16) | (bytes[22]! << 8) | bytes[23]!
    expect(width).toBe(1200)
    expect(height).toBe(630)
  })
})
