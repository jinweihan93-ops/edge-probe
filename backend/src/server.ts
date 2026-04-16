import { Hono } from "hono"
import { InMemorySpanStore, SpanViews, type Trace, type StoredSpan } from "./views.ts"

export interface AppDeps {
  store: InMemorySpanStore
  views: SpanViews
}

/**
 * Build a Hono app. Factored this way so tests can construct an isolated
 * instance without shared state.
 */
export function createApp(deps: AppDeps = makeDefaultDeps()) {
  const { store, views } = deps
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
   * GET /r/:token — public share URL. Queries ONLY the public view.
   * Critical Path #1: never renders prompt/completion text.
   * Critical Path #3: per-call opt-in on the SDK does not escalate to here.
   */
  app.get("/r/:token", (c) => {
    const token = c.req.param("token")
    // Day 1: token IS the trace id (we'll add real share_tokens table in month 13).
    const spans = views.public_forTrace(token)
    const trace = store.getTrace(token)
    if (!trace || trace.sensitive) {
      return c.json({ error: "not found" }, 404)
    }
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

export function makeDefaultDeps(): AppDeps {
  const store = new InMemorySpanStore()
  const views = new SpanViews(store)
  return { store, views }
}

// Allow `bun run src/server.ts` to boot the server directly.
if (import.meta.main) {
  const app = createApp()
  const port = Number(process.env.PORT ?? 3000)
  console.log(`EdgeProbe backend listening on :${port}`)
  Bun.serve({ port, fetch: app.fetch })
}
