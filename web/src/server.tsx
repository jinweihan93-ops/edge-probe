import { Hono } from "hono"
import { serveStatic } from "hono/bun"
import { BackendClient } from "./lib/backend.ts"
import { PublicTracePage } from "./pages/publicTrace.tsx"
import { PrivateTracePage } from "./pages/privateTrace.tsx"
import { AppHomePage } from "./pages/appHome.tsx"
import { ProjectDetailPage } from "./pages/projectDetail.tsx"
import { NotFoundPage } from "./pages/notFound.tsx"
import { parseOrgBearerMap } from "./lib/bearerMap.ts"

/**
 * Resolve the requesting org from `?org=` + `orgBearers`. Returns either a
 * concrete {orgId, bearer} pair or a response to short-circuit with.
 * Centralized so every auth'd page uses the same rules:
 *   - No bearer for the requested org → 401
 *   - `?org=` omitted AND the caller has exactly one bearer → use that one
 *   - `?org=` omitted AND the caller has zero or >1 bearers → 401
 */
function resolveOrg(
  queryOrg: string | undefined,
  orgBearers: Map<string, string>,
): { orgId: string; bearer: string } | null {
  const orgId = queryOrg ?? (orgBearers.size === 1 ? [...orgBearers.keys()][0] : undefined)
  if (!orgId) return null
  const bearer = orgBearers.get(orgId)
  if (!bearer) return null
  return { orgId, bearer }
}

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
  /**
   * `orgId → bearer`. In prod this is populated from the user's session
   * cookie (only one entry, for the signed-in org). In dev the env var
   * `ORG_BEARERS` lets you configure multiple so `?org=org_foo` flips
   * between them — but only orgs for which we actually hold a bearer are
   * reachable. A user can't claim an org they don't have a key for.
   */
  orgBearers: Map<string, string>
}

export function createWebApp(deps: WebDeps) {
  const { backend, orgBearers } = deps
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
   *
   * We mint an absolute `ogImageUrl` from the request URL (NOT from an env
   * var), so the OG card is always same-origin with the share page. Some
   * unfurl bots follow cross-origin redirects, some don't — matching origins
   * is the boring safe move.
   */
  app.get("/r/:token", async (c) => {
    const token = c.req.param("token")
    const data = await backend.fetchPublic(token)
    if (!data) {
      return c.html(<NotFoundPage />, 404)
    }
    const url = new URL(c.req.url)
    const ogImageUrl = `${url.protocol}//${url.host}/og/${encodeURIComponent(token)}.png`
    return c.html(<PublicTracePage data={data} ogImageUrl={ogImageUrl} />)
  })

  /**
   * GET /og/:filename — OG card proxy.
   *
   * Pure pass-through to the backend: the web layer has no trace data of
   * its own, no rendering, no caching decision. We forward the status code
   * and `Cache-Control` header intact so the backend remains the single
   * source of truth for both the PNG bytes and the freshness policy.
   *
   * The route exists purely so `<meta property="og:image">` can point at
   * the same origin as `/r/:token`. See the comment in the `/r/:token`
   * handler for why that matters.
   *
   * Failure modes:
   *   - Backend returns 404 + branded fallback PNG → we pipe it through.
   *     A scraper sees a valid PNG either way; 200 vs 404 is the only
   *     observable difference.
   *   - Backend unreachable (network error) → we render our own 404
   *     JSON stub. This is the ONLY path that emits non-PNG bytes; it's
   *     reserved for the degenerate "backend is down entirely" case and
   *     is not reachable in the security model.
   */
  app.get("/og/:filename", async (c) => {
    const filename = c.req.param("filename")
    const resp = await backend.fetchOgPng(filename)
    if (!resp) {
      return c.json({ error: "backend unavailable" }, 502)
    }
    // `new Uint8Array(resp.body)` re-wraps the backed ArrayBufferLike as a
    // concrete ArrayBuffer for Hono's body typing; zero-copy in practice
    // because we're sharing the underlying buffer.
    const payload = new Uint8Array(resp.body)
    return c.body(payload, resp.status as 200 | 404, {
      "Content-Type": "image/png",
      "Content-Length": String(payload.length),
      "Cache-Control": resp.cacheControl,
    })
  })

  /**
   * GET /app — home dashboard. Lists projects under the requesting org.
   *
   * Auth model: same as `/app/trace/:id`. `?org=` selects an org the user
   * already has a bearer for; it cannot grant access.
   */
  app.get("/app", async (c) => {
    const resolved = resolveOrg(c.req.query("org"), orgBearers)
    if (!resolved) {
      return c.html(<NotFoundPage />, 401)
    }
    const { status, projects } = await backend.listProjects(resolved.bearer)
    if (status === 401 || status === 403) {
      return c.html(<NotFoundPage />, status as 401 | 403)
    }
    return c.html(<AppHomePage projects={projects} orgId={resolved.orgId} />)
  })

  /**
   * GET /app/projects/:projectId — recent traces for one project.
   *
   * Cross-project poking across orgs: the backend already scopes the
   * query to (orgId from bearer, projectId from path). Unknown projectId
   * just renders the empty state — there's no "project exists but you
   * can't see it" error because there's nothing to leak from an empty
   * result.
   */
  app.get("/app/projects/:projectId", async (c) => {
    const resolved = resolveOrg(c.req.query("org"), orgBearers)
    if (!resolved) {
      return c.html(<NotFoundPage />, 401)
    }
    const projectId = c.req.param("projectId")
    const { status, traces } = await backend.listProjectTraces(projectId, resolved.bearer)
    if (status === 401 || status === 403) {
      return c.html(<NotFoundPage />, status as 401 | 403)
    }
    return c.html(
      <ProjectDetailPage
        projectId={projectId}
        orgId={resolved.orgId}
        traces={traces}
      />,
    )
  })

  /**
   * GET /app/trace/:id — authenticated dashboard detail.
   *
   * Auth model: the user's org is looked up in `orgBearers`, which is
   * populated from the session (prod) or `ORG_BEARERS` env (dev). The
   * `?org=` query param SELECTS which of the user's orgs to render — it
   * does NOT grant access. If the caller requests an org they don't have
   * a bearer for, we return the single not-found page, same as a missing
   * trace.
   *
   * 401 from the backend → our own "not found"; a stranger probing should
   * not learn that a trace id exists. 403 (wrong org) collapses the same
   * way as per Critical Path #2.
   */
  app.get("/app/trace/:id", async (c) => {
    const resolved = resolveOrg(c.req.query("org"), orgBearers)
    if (!resolved) {
      return c.html(<NotFoundPage />, 401)
    }

    const { status, body } = await backend.fetchPrivate(c.req.param("id"), resolved.bearer)
    if (!body) {
      // 401, 403, 404 — all collapse to the same not-found page for the
      // public-facing guarantee. The status code we return mirrors the backend.
      return c.html(<NotFoundPage />, status as 401 | 403 | 404)
    }
    return c.html(<PrivateTracePage data={body} orgId={resolved.orgId} />)
  })

  return app
}

export function makeDefaultWebDeps(): WebDeps {
  const baseUrl = process.env.BACKEND_URL ?? "http://127.0.0.1:3000"
  const orgBearers = parseOrgBearerMap(process.env.ORG_BEARERS)
  return { backend: new BackendClient({ baseUrl }), orgBearers }
}

if (import.meta.main) {
  const app = createWebApp(makeDefaultWebDeps())
  const port = Number(process.env.PORT ?? 3001)
  console.log(`EdgeProbe web dashboard listening on :${port}`)
  console.log(`Backend: ${process.env.BACKEND_URL ?? "http://127.0.0.1:3000"}`)
  Bun.serve({ port, fetch: app.fetch })
}
