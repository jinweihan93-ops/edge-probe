import { Hono } from "hono"
import { InMemorySpanStore, SpanViews, type Trace, type StoredSpan } from "./views.ts"
import {
  HmacShareTokenSigner,
  InvalidShareTokenError,
  DEFAULT_SHARE_TTL_SECONDS,
  MAX_SHARE_TTL_SECONDS,
  type ShareTokenSigner,
} from "./shareToken.ts"

export interface AppDeps {
  store: InMemorySpanStore
  views: SpanViews
  signer: ShareTokenSigner
}

/**
 * Build a Hono app. Factored this way so tests can construct an isolated
 * instance without shared state (and inject a test-only signer).
 */
export function createApp(deps: AppDeps = makeDefaultDeps({ shareTokenSecret: requireShareSecret() })) {
  const { store, views, signer } = deps
  const app = new Hono()

  app.get("/healthz", (c) => c.json({ ok: true }))

  /**
   * POST /ingest — accepts OTLP-shaped JSON (simplified Day 1 shape).
   * Auth: `Authorization: Bearer epk_pub_...` (verification is a TODO; for now
   * we require any Bearer header to land, to exercise the contract).
   *
   * Real OTLP/HTTP protobuf lands in month 13. This shape is the minimum to
   * wire the SDK to an endpoint end-to-end.
   */
  app.post("/ingest", async (c) => {
    const auth = c.req.header("Authorization")
    if (!auth || !auth.startsWith("Bearer epk_pub_")) {
      return c.json({ error: "missing or malformed public ingest key" }, 401)
    }

    const body = (await c.req.json()) as {
      trace: Trace
      spans: StoredSpan[]
    }

    if (!body?.trace?.id || !Array.isArray(body?.spans)) {
      return c.json({ error: "invalid ingest payload: need { trace, spans[] }" }, 400)
    }

    store.insertTrace(body.trace)
    for (const span of body.spans) {
      store.insertSpan(span)
    }

    return c.json({ accepted: { traceId: body.trace.id, spanCount: body.spans.length } }, 202)
  })

  /**
   * POST /app/trace/:id/share — mint a short-lived signed token for a trace.
   * Auth: `X-Org-Id` header (stand-in for real session auth).
   *
   * Only the owning org may mint a share. The returned token encodes
   * (traceId, orgId, expiresAt) and is verified on every /r/:token hit. A
   * user who already knows a raw trace id can NOT turn it into a working
   * public link without hitting this endpoint authenticated.
   *
   * Body (optional): `{ expiresInSeconds?: number }`. Default 7 days, capped 30.
   */
  app.post("/app/trace/:id/share", async (c) => {
    const id = c.req.param("id")
    const orgId = c.req.header("X-Org-Id")
    if (!orgId) {
      return c.json({ error: "unauthorized" }, 401)
    }

    const trace = store.getTrace(id)
    if (!trace) {
      return c.json({ error: "not found" }, 404)
    }
    if (trace.orgId !== orgId) {
      // 403, not 404: Critical Path #2 — never leak existence across orgs.
      return c.json({ error: "forbidden" }, 403)
    }

    let expiresInSeconds = DEFAULT_SHARE_TTL_SECONDS
    try {
      const body = (await c.req.json().catch(() => ({}))) as { expiresInSeconds?: number }
      if (typeof body.expiresInSeconds === "number" && body.expiresInSeconds > 0) {
        expiresInSeconds = Math.min(body.expiresInSeconds, MAX_SHARE_TTL_SECONDS)
      }
    } catch {
      // Empty/invalid body is fine; use default.
    }
    const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds
    const token = signer.sign({ traceId: id, orgId, expiresAt })

    return c.json(
      {
        token,
        url: `/r/${token}`,
        expiresAt,
      },
      201,
    )
  })

  /**
   * GET /r/:token — public share URL. Queries ONLY the public view.
   * Critical Path #1: never renders prompt/completion text.
   * Critical Path #3: per-call SDK opt-in does not escalate to here.
   *
   * Every failure mode collapses to 404. A stranger probing the endpoint
   * cannot tell whether a token is malformed, expired, tampered, points at
   * a trace that doesn't exist, or points at a sensitive trace. They all
   * look identical from the outside. This is deliberate.
   */
  app.get("/r/:token", (c) => {
    const token = c.req.param("token")
    let payload
    try {
      payload = signer.verify(token)
    } catch (err) {
      if (err instanceof InvalidShareTokenError) {
        return c.json({ error: "not found" }, 404)
      }
      throw err
    }

    const trace = store.getTrace(payload.traceId)
    if (!trace || trace.sensitive || trace.orgId !== payload.orgId) {
      return c.json({ error: "not found" }, 404)
    }

    const spans = views.public_forTrace(trace.id)
    return c.json({
      trace: {
        id: trace.id,
        startedAt: trace.startedAt,
        endedAt: trace.endedAt,
        device: trace.device,
        attributes: trace.attributes,
      },
      spans,
    })
  })

  /**
   * GET /app/trace/:id — authenticated dashboard view. Full content when opted in.
   * Cross-org scan returns 403, not 404 (Critical Path #2 — never leak existence).
   */
  app.get("/app/trace/:id", (c) => {
    const id = c.req.param("id")
    const orgId = c.req.header("X-Org-Id") // stand-in for real session auth
    if (!orgId) {
      return c.json({ error: "unauthorized" }, 401)
    }

    const trace = store.getTrace(id)
    if (!trace) {
      return c.json({ error: "not found" }, 404)
    }
    if (trace.orgId !== orgId) {
      // 403, NOT 404. Matching 404 here would let an attacker distinguish
      // "trace exists but not yours" from "trace doesn't exist".
      return c.json({ error: "forbidden" }, 403)
    }

    const spans = views.private_forTrace(id, orgId)
    return c.json({
      trace,
      spans,
    })
  })

  return app
}

export function makeDefaultDeps(config: { shareTokenSecret: string }): AppDeps {
  const store = new InMemorySpanStore()
  const views = new SpanViews(store)
  const signer = new HmacShareTokenSigner(config.shareTokenSecret)
  return { store, views, signer }
}

function requireShareSecret(): string {
  const s = process.env.SHARE_TOKEN_SECRET
  if (!s || s.length < 32) {
    throw new Error(
      "SHARE_TOKEN_SECRET env var must be set to a string of at least 32 characters. " +
        "Generate one with: openssl rand -hex 32",
    )
  }
  return s
}

// Allow `bun run src/server.ts` to boot the server directly.
if (import.meta.main) {
  const app = createApp()
  const port = Number(process.env.PORT ?? 3000)
  console.log(`EdgeProbe backend listening on :${port}`)
  Bun.serve({ port, fetch: app.fetch })
}
