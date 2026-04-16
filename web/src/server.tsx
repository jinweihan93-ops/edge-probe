import { Hono } from "hono"
import { serveStatic } from "hono/bun"
import { BackendClient } from "./lib/backend.ts"
import { PublicTracePage } from "./pages/publicTrace.tsx"
import { PrivateTracePage } from "./pages/privateTrace.tsx"
import { NotFoundPage } from "./pages/notFound.tsx"

/**
 * EdgeProbe web dashboard.
 *
 * Separate process from the backend. Calls backend over HTTP, renders HTML
 * via hono/jsx. Zero client-side framework, zero bundler. Slack and Twitter
 * unfurls work because there's nothing to hydrate.
 *
 * Why separate: the backend stays a pure data plane. If tomorrow we want
 * to swap this web layer for Next.js without touching /ingest, we can.
 * The split also exercises the public API — anything this layer can do is
 * something a third-party can do.
 */

export interface WebDeps {
  backend: BackendClient
}

export function createWebApp(deps: WebDeps) {
  const { backend } = deps
  const app = new Hono()

  app.get("/healthz", (c) => c.json({ ok: true }))

  // Static assets: fonts + tokens.css live under web/public/.
  // Served with long caching headers — the filenames will get versioned
  // once we introduce a release pipeline.
  app.use("/styles/*", serveStatic({ root: "./public" }))
  app.use("/fonts/*", serveStatic({ root: "./public" }))

  /**
   * GET /r/:token — public share HTML.
   *
   * Security contract (same as backend):
   *   - Every failure collapses to the single `NotFoundPage` render.
   *   - A stranger cannot distinguish expired / tampered / missing / sensitive.
   *   - No content text can be rendered because the backend's /r/:token
   *     response has no content fields.
   */
  app.get("/r/:token", async (c) => {
    const data = await backend.fetchPublic(c.req.param("token"))
    if (!data) {
      return c.html(<NotFoundPage />, 404)
    }
    return c.html(<PublicTracePage data={data} />)
  })

  /**
   * GET /app/trace/:id — authenticated dashboard detail.
   *
   * Auth model for Day 1: the browser must send `X-Org-Id` (set by the real
   * auth shell that will live here later). If absent, we fall back to
   * `?org=` query param so the dev flow (`open http://localhost:3001/app/trace/xxx?org=org_acme`)
   * works without cookies.
   *
   * 401 from the backend → our own "not found"; a stranger probing should
   * not learn that a trace id exists. 403 (wrong org) collapses the same
   * way as per Critical Path #2.
   */
  app.get("/app/trace/:id", async (c) => {
    const headerOrg = c.req.header("X-Org-Id")
    const queryOrg = c.req.query("org")
    const orgId = headerOrg ?? queryOrg
    if (!orgId) {
      return c.html(
        <NotFoundPage reason="This page requires org context. Pass ?org=your_org_id for dev, or sign in." />,
        401,
      )
    }

    const { status, body } = await backend.fetchPrivate(c.req.param("id"), orgId)
    if (!body) {
      // 401, 403, 404 — all collapse to the same not-found page for the
      // public-facing guarantee. The status code we return mirrors the backend.
      return c.html(<NotFoundPage />, status as 401 | 403 | 404)
    }
    return c.html(<PrivateTracePage data={body} orgId={orgId} />)
  })

  return app
}

export function makeDefaultWebDeps(): WebDeps {
  const baseUrl = process.env.BACKEND_URL ?? "http://127.0.0.1:3000"
  return { backend: new BackendClient({ baseUrl }) }
}

if (import.meta.main) {
  const app = createWebApp(makeDefaultWebDeps())
  const port = Number(process.env.PORT ?? 3001)
  console.log(`EdgeProbe web dashboard listening on :${port}`)
  console.log(`Backend: ${process.env.BACKEND_URL ?? "http://127.0.0.1:3000"}`)
  Bun.serve({ port, fetch: app.fetch })
}
