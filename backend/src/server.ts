import { Hono } from "hono"
import type { Context } from "hono"
import { InMemorySpanStore, SpanViews, type SpanStore, type Trace, type StoredSpan } from "./views.ts"
import { PgSpanStore } from "./pgSpanStore.ts"
import { createSQL } from "./db.ts"
import { runMigrations } from "./migrate.ts"
import {
  HmacShareTokenSigner,
  InvalidShareTokenError,
  DEFAULT_SHARE_TTL_SECONDS,
  MAX_SHARE_TTL_SECONDS,
  type ShareTokenSigner,
} from "./shareToken.ts"
import { DASHBOARD_KEY_PREFIX, parseDashboardKeys, testDashboardKeys } from "./auth.ts"
import { renderOgPng, renderFallbackPng } from "./og.ts"
import { RateLimiter } from "./rateLimit.ts"
import { Metrics } from "./metrics.ts"
import { contentHash, minuteBucket } from "./ingestHash.ts"
import {
  type ApiKeyStore,
  type KeyType,
  parseBootstrapKeys,
} from "./apiKeys.ts"
import { InMemoryApiKeyStore } from "./inMemoryApiKeyStore.ts"
import { PgApiKeyStore } from "./pgApiKeyStore.ts"

/** Default ingest guardrails. All env-overridable at boot. */
export const DEFAULT_INGEST_MAX_BYTES = 1 * 1024 * 1024 // 1 MB / request
export const DEFAULT_SPANS_PER_SEC = 100 // per org — 6000 spans/min sustained
export const DEFAULT_BYTES_PER_DAY = 100 * 1024 * 1024 // 100 MB / org / day
export const DEFAULT_RETENTION_DAYS = 30

export interface AppDeps {
  store: SpanStore
  views: SpanViews
  signer: ShareTokenSigner
  /**
   * Boot-time map from dashboard bearer key → orgId. Legacy surface from
   * pre-Slice-5 bootstrapping. As of Slice 5, `epk_priv_` keys minted via
   * `/app/keys` are first-class and can auth any `/app/*` route too — this
   * map is for operators who still use `DASHBOARD_KEYS` env to wire dev
   * bootstrap sessions. Either path works; both run through
   * `authenticateDashboard()`.
   */
  dashboardKeys: Map<string, string>
  /**
   * Load-bearing key store. `/ingest` authenticates against this; `/app/keys`
   * mints + revokes against this; `/app/*` dashboard routes fall back to
   * this when the presented bearer is `epk_priv_`. See `apiKeys.ts`.
   */
  apiKeyStore: ApiKeyStore
  /** Per-org token-bucket limiter. See `rateLimit.ts`. */
  rateLimiter: RateLimiter
  /** In-process counter registry exposed via `GET /metrics`. */
  metrics: Metrics
  /**
   * Max accepted request body size in bytes at /ingest. Enforced before
   * JSON parse — we don't read an arbitrary amount of memory on behalf of
   * an untrusted client.
   */
  maxIngestBytes: number
  /**
   * Clock used by dedup bucketing. Injectable so tests can freeze "now".
   * Rate limiter has its own clock (both default to Date.now).
   */
  now: () => Date
}

/**
 * Resolve the caller's orgId for a `/app/*` dashboard-style request.
 *
 * Accepts either:
 *   1. A dashboard key registered in `DASHBOARD_KEYS` env (legacy bootstrap).
 *   2. A fresh `epk_priv_` API key minted via `/app/keys`.
 *
 * Returns `null` on missing header, wrong scheme, unknown key, revoked key,
 * or a bearer that parses as `epk_pub_` (ingest keys cannot read dashboards).
 * Callers translate `null` → 401.
 *
 * Deliberately does not distinguish failure modes to the caller — same
 * 401 response shape for every reject keeps timing + probing unexciting.
 */
export async function authenticateDashboard(
  c: Context,
  dashboardKeys: Map<string, string>,
  apiKeyStore: ApiKeyStore,
): Promise<string | null> {
  const auth = c.req.header("Authorization")
  if (!auth || !auth.startsWith("Bearer ")) return null
  const key = auth.slice("Bearer ".length).trim()
  if (key.startsWith(DASHBOARD_KEY_PREFIX)) {
    return dashboardKeys.get(key) ?? null
  }
  if (key.startsWith("epk_priv_")) {
    const row = await apiKeyStore.verify(key)
    return row?.orgId ?? null
  }
  return null
}

/**
 * Build a Hono app. Factored this way so tests can construct an isolated
 * instance without shared state (and inject a test-only signer + store).
 *
 * Handlers are all async because `SpanStore` is async — the in-memory version
 * resolves immediately, the Postgres version actually awaits I/O. Same code,
 * two deployments.
 */
export function createApp(deps: AppDeps) {
  const {
    store,
    views,
    signer,
    dashboardKeys,
    apiKeyStore,
    rateLimiter,
    metrics,
    maxIngestBytes,
    now,
  } = deps
  const app = new Hono()

  app.get("/healthz", (c) => c.json({ ok: true }))

  /**
   * GET /metrics — Prometheus-style exposition. Zero auth on purpose:
   * everything here is counters about the server's own behavior, never
   * customer data. Scrapers come from inside the network boundary.
   *
   * If we ever expose this publicly on the internet we'll gate it —
   * for now it lives alongside /healthz as an ops-only surface.
   */
  app.get("/metrics", (c) => {
    return c.text(metrics.render(), 200, {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-store",
    })
  })

  /**
   * POST /ingest — accepts OTLP-shaped JSON (simplified Day 1 shape).
   *
   * Auth (Slice 5): `Authorization: Bearer epk_pub_<id>_<secret>`. The key
   * is looked up in `api_keys` (argon2-verified, revocation-checked), and
   * the ORG THAT OWNS THE KEY is what we trust for storage. The payload's
   * `orgId` must match — a mismatch is 401, not "silently overwrite", so a
   * compromised public key can't be used to scribble into another org's
   * dashboard.
   *
   * Hardening (Slice 4):
   *   1. Payload size cap (Content-Length + actual bytes).
   *   2. Per-org token bucket (spans/sec + bytes/day).
   *   3. SHA-256 content dedup with 1-minute buckets — identical retries
   *      return 202 `deduped: true` and are NOT stored.
   *
   * Each reject increments `edgeprobe_spans_dropped_total{reason=...}`.
   * Successful inserts increment `edgeprobe_spans_ingested_total`.
   */
  app.post("/ingest", async (c) => {
    const auth = c.req.header("Authorization")
    if (!auth || !auth.startsWith("Bearer ")) {
      metrics.inc("edgeprobe_ingest_requests_total", { outcome: "unauthorized" })
      return c.json({ error: "missing or malformed public ingest key" }, 401)
    }
    const rawBearer = auth.slice("Bearer ".length).trim()
    // We insist on pub tokens here by prefix — not because the prefix proves
    // anything, but because it gives a cheap reject path before we argon2-
    // verify. A priv-shaped token short-circuits to 401 without touching the
    // hash subsystem.
    if (!rawBearer.startsWith("epk_pub_")) {
      metrics.inc("edgeprobe_ingest_requests_total", { outcome: "unauthorized" })
      return c.json({ error: "missing or malformed public ingest key" }, 401)
    }
    const verifiedKey = await apiKeyStore.verify(rawBearer)
    if (!verifiedKey || verifiedKey.keyType !== "pub") {
      metrics.inc("edgeprobe_ingest_requests_total", { outcome: "unauthorized" })
      return c.json({ error: "missing or malformed public ingest key" }, 401)
    }

    // Size cap — reject declared-oversize requests before reading the body.
    // Defense in depth: we also re-check after reading, because a malicious
    // client can lie about Content-Length.
    const contentLengthHdr = c.req.header("Content-Length")
    const declaredLen = contentLengthHdr ? Number(contentLengthHdr) : NaN
    if (Number.isFinite(declaredLen) && declaredLen > maxIngestBytes) {
      metrics.inc("edgeprobe_spans_dropped_total", { reason: "size" })
      metrics.inc("edgeprobe_ingest_requests_total", { outcome: "too_large" })
      return c.json({ error: "payload too large" }, 413)
    }

    const rawBuffer = await c.req.arrayBuffer()
    const bytes = new Uint8Array(rawBuffer)
    if (bytes.byteLength > maxIngestBytes) {
      metrics.inc("edgeprobe_spans_dropped_total", { reason: "size" })
      metrics.inc("edgeprobe_ingest_requests_total", { outcome: "too_large" })
      return c.json({ error: "payload too large" }, 413)
    }

    let body: { trace: Trace; spans: StoredSpan[] }
    try {
      body = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      metrics.inc("edgeprobe_ingest_requests_total", { outcome: "bad_json" })
      return c.json({ error: "invalid json" }, 400)
    }

    if (!body?.trace?.id || !Array.isArray(body?.spans)) {
      metrics.inc("edgeprobe_ingest_requests_total", { outcome: "bad_shape" })
      return c.json({ error: "invalid ingest payload: need { trace, spans[] }" }, 400)
    }

    // Slice 5 wrong-org-in-payload check. A client holding a valid pub key
    // for org_acme cannot stuff `trace.orgId = "org_competitor"` and have
    // the trace land in the competitor's dashboard. 401, not 403: the key
    // itself is a secret, so even "your key is valid but the orgId is wrong"
    // doesn't leak anything that matters. One outcome, one response code.
    if (body.trace.orgId !== verifiedKey.orgId) {
      metrics.inc("edgeprobe_spans_dropped_total", { reason: "org_mismatch" })
      metrics.inc("edgeprobe_ingest_requests_total", { outcome: "org_mismatch" })
      return c.json({ error: "missing or malformed public ingest key" }, 401)
    }

    // Authoritative orgId from the key — we use this for rate limit + dedup
    // even though it now equals the payload's orgId. Defense in depth: if
    // the mismatch check above ever regresses, the rest of the pipeline
    // still groups on the key's org, not attacker-controlled input.
    const orgId = verifiedKey.orgId
    const spanCount = body.spans.length
    const decision = rateLimiter.check(orgId, spanCount, bytes.byteLength)
    if (!decision.allowed) {
      metrics.inc(
        "edgeprobe_spans_dropped_total",
        { reason: "rate_limit" },
        Math.max(1, spanCount),
      )
      metrics.inc("edgeprobe_ingest_requests_total", { outcome: "rate_limited" })
      return c.json(
        {
          error: "rate limited",
          reason: decision.reason,
          retryAfterSeconds: decision.retryAfterSeconds,
        },
        429,
        { "Retry-After": String(decision.retryAfterSeconds ?? 1) },
      )
    }

    // Dedup — (orgId, sha256(body), minute) must be novel.
    const hash = contentHash(bytes)
    const bucket = minuteBucket(now())
    const novel = await store.tryRecordContentHash(orgId, hash, bucket)
    if (!novel) {
      metrics.inc(
        "edgeprobe_spans_dropped_total",
        { reason: "dedup" },
        Math.max(1, spanCount),
      )
      metrics.inc("edgeprobe_ingest_requests_total", { outcome: "deduped" })
      // 202 on purpose — a dedup'd retry is the client's retry working as
      // designed. From the client's perspective the upload "happened". We
      // just don't store the second copy.
      return c.json(
        {
          accepted: { traceId: body.trace.id, spanCount, deduped: true },
        },
        202,
      )
    }

    await store.insertTrace(body.trace)
    for (const span of body.spans) {
      await store.insertSpan(span)
    }
    metrics.inc("edgeprobe_spans_ingested_total", {}, spanCount)
    metrics.inc("edgeprobe_ingest_requests_total", { outcome: "accepted" })

    return c.json({ accepted: { traceId: body.trace.id, spanCount } }, 202)
  })

  /**
   * POST /app/trace/:id/share — mint a short-lived signed token for a trace.
   * Auth: `Authorization: Bearer epk_dash_...` — the bearer maps to an orgId
   * via the boot-time `dashboardKeys` table. The client cannot self-assert
   * an org; the key IS the identity proof.
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
    const orgId = await authenticateDashboard(c, dashboardKeys, apiKeyStore)
    if (!orgId) {
      return c.json({ error: "unauthorized" }, 401)
    }

    const trace = await store.getTrace(id)
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
  app.get("/r/:token", async (c) => {
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

    const trace = await store.getTrace(payload.traceId)
    if (!trace || trace.sensitive || trace.orgId !== payload.orgId) {
      return c.json({ error: "not found" }, 404)
    }

    const spans = await views.public_forTrace(trace.id)
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
   * GET /og/:token.png — OG unfurl image for a public share token.
   *
   * Same auth posture as /r/:token — the token itself is the proof, there
   * is no Authorization header. Every failure collapses to a branded
   * fallback PNG with status 404; a scraper cannot distinguish a bad
   * token from a missing trace from a sensitive trace.
   *
   * Cache headers: `public, max-age=3600, immutable`. Tokens encode an
   * expiresAt, so the underlying resource is effectively frozen — 1 h
   * staleness is safe and keeps Slack/Twitter unfurls snappy.
   */
  // Route as `/og/:filename` and extract the token ourselves because Hono's
  // param syntax `/og/:token.png` treats `.png` as part of the param name —
  // and share tokens contain literal `.` (they're `<body>.<sig>`), so the
  // naive pattern double-misfires. Be explicit, then validate.
  app.get("/og/:filename", async (c) => {
    const filename = c.req.param("filename")
    const fallback = () => {
      const png = renderFallbackPng()
      return c.body(new Uint8Array(png), 404, {
        "Content-Type": "image/png",
        "Content-Length": String(png.length),
        "Cache-Control": "public, max-age=300",
      })
    }
    if (!filename.endsWith(".png")) {
      // Same fallback — don't leak "wrong extension" as a distinct 4xx.
      return fallback()
    }
    const token = filename.slice(0, -".png".length)
    if (!token) return fallback()

    let payload
    try {
      payload = signer.verify(token)
    } catch (err) {
      if (err instanceof InvalidShareTokenError) return fallback()
      throw err
    }

    const trace = await store.getTrace(payload.traceId)
    if (!trace || trace.sensitive || trace.orgId !== payload.orgId) {
      return fallback()
    }

    const spans = await views.public_forTrace(trace.id)
    const png = renderOgPng({ trace, spans })
    return c.body(new Uint8Array(png), 200, {
      "Content-Type": "image/png",
      "Content-Length": String(png.length),
      "Cache-Control": "public, max-age=3600, immutable",
    })
  }) // END GET /og/:filename

  /**
   * GET /app/projects — list projects under the authenticated org.
   *
   * Scope: project-level roll-up for the `/app` home dashboard. Each row
   * carries `projectId`, `lastTraceAt`, and `traceCount`. No cross-org data
   * can leak because `listProjects()` filters on the `orgId` resolved from
   * the bearer — not from a query param, not from a header.
   */
  app.get("/app/projects", async (c) => {
    const orgId = await authenticateDashboard(c, dashboardKeys, apiKeyStore)
    if (!orgId) {
      return c.json({ error: "unauthorized" }, 401)
    }
    const projects = await store.listProjects(orgId)
    return c.json({ projects })
  })

  /**
   * GET /app/projects/:projectId/traces — list of recent traces for one
   * project under the authenticated org.
   *
   * Query params:
   *   - `limit` (default 25, cap 100)
   *   - `before` (ISO8601; cursor-style — returns traces strictly earlier)
   *
   * Cross-project / cross-org poking is a non-event: the query is always
   * scoped to (orgId from bearer, projectId from path). An attacker who
   * flips `:projectId` to an org they don't own just gets an empty list,
   * same as a project with no traces. That's fine — there's nothing to
   * leak from an empty result.
   */
  app.get("/app/projects/:projectId/traces", async (c) => {
    const orgId = await authenticateDashboard(c, dashboardKeys, apiKeyStore)
    if (!orgId) {
      return c.json({ error: "unauthorized" }, 401)
    }
    const projectId = c.req.param("projectId")
    const limitRaw = c.req.query("limit")
    const before = c.req.query("before")
    const limit = limitRaw ? Number(limitRaw) : undefined
    if (limitRaw && (!Number.isFinite(limit) || (limit as number) <= 0)) {
      return c.json({ error: "invalid limit" }, 400)
    }
    const traces = await store.listTraces(orgId, projectId, {
      limit,
      before,
    })
    return c.json({ traces })
  })

  /**
   * GET /app/trace/:id — authenticated dashboard view. Full content when opted in.
   * Cross-org scan returns 403, not 404 (Critical Path #2 — never leak existence).
   * Auth: `Authorization: Bearer epk_dash_...` (see auth.ts).
   */
  app.get("/app/trace/:id", async (c) => {
    const id = c.req.param("id")
    const orgId = await authenticateDashboard(c, dashboardKeys, apiKeyStore)
    if (!orgId) {
      return c.json({ error: "unauthorized" }, 401)
    }

    const trace = await store.getTrace(id)
    if (!trace) {
      return c.json({ error: "not found" }, 404)
    }
    if (trace.orgId !== orgId) {
      // 403, NOT 404. Matching 404 here would let an attacker distinguish
      // "trace exists but not yours" from "trace doesn't exist".
      return c.json({ error: "forbidden" }, 403)
    }

    const spans = await views.private_forTrace(id, orgId)
    return c.json({
      trace,
      spans,
    })
  })

  // ==========================================================
  //  /app/keys — mint / list / revoke admin surface (Slice 5).
  //
  //  Gated strictly on a valid `epk_priv_` API key. A dashboard-only
  //  `epk_dash_` session cannot mint new keys: the priv-key tier is the
  //  "I can rotate our SDK keys" tier, separately guardable by the operator.
  //  We reuse `authenticateDashboard()` but then insist on the strict priv
  //  shape, so legacy `epk_dash_` bootstrap keys 401 here on purpose.
  // ==========================================================

  /**
   * Shared priv-only gate. Returns `{ orgId }` on success, or a
   * ready-to-return 401 Response when the bearer is missing / malformed /
   * revoked / a non-priv token. Keeping the reject path uniform prevents
   * accidental drift between the three routes below.
   */
  const requirePrivKey = async (c: Context): Promise<
    { kind: "ok"; orgId: string } | { kind: "reject"; response: Response }
  > => {
    const auth = c.req.header("Authorization")
    if (!auth || !auth.startsWith("Bearer ")) {
      return { kind: "reject", response: c.json({ error: "unauthorized" }, 401) }
    }
    const raw = auth.slice("Bearer ".length).trim()
    if (!raw.startsWith("epk_priv_")) {
      return { kind: "reject", response: c.json({ error: "unauthorized" }, 401) }
    }
    const row = await apiKeyStore.verify(raw)
    if (!row || row.keyType !== "priv") {
      return { kind: "reject", response: c.json({ error: "unauthorized" }, 401) }
    }
    return { kind: "ok", orgId: row.orgId }
  }

  /**
   * POST /app/keys — mint a new key in the caller's org.
   *
   * Body: `{ keyType: "pub" | "priv", name: string }`. We intentionally do
   * NOT accept `orgId` in the body — the orgId comes from the authenticating
   * priv key. Otherwise a compromised key could mint inside another org.
   *
   * Response (201): `{ row: ApiKeyRow, rawToken: string }`. The rawToken is
   * returned ONCE; we never store it in the clear, so there is no way to
   * retrieve it later. Operators who lose it must revoke and mint again.
   */
  app.post("/app/keys", async (c) => {
    const gate = await requirePrivKey(c)
    if (gate.kind === "reject") return gate.response
    let body: { keyType?: unknown; name?: unknown }
    try {
      body = (await c.req.json()) as typeof body
    } catch {
      return c.json({ error: "invalid json" }, 400)
    }
    if (body.keyType !== "pub" && body.keyType !== "priv") {
      return c.json({ error: "keyType must be 'pub' or 'priv'" }, 400)
    }
    if (typeof body.name !== "string" || body.name.trim() === "") {
      return c.json({ error: "name must be a non-empty string" }, 400)
    }
    const minted = await apiKeyStore.mint(gate.orgId, body.keyType as KeyType, body.name.trim())
    return c.json({ row: minted.row, rawToken: minted.rawToken }, 201)
  })

  /**
   * GET /app/keys — list metadata for the caller's org.
   *
   * Metadata only — we MUST never return `keyHash` or anything that could
   * be used to reconstruct a raw token. The store interface guarantees this
   * by typing the list return as `ApiKeyRow[]` (no hash field).
   */
  app.get("/app/keys", async (c) => {
    const gate = await requirePrivKey(c)
    if (gate.kind === "reject") return gate.response
    const rows = await apiKeyStore.list(gate.orgId)
    return c.json({ keys: rows })
  })

  /**
   * DELETE /app/keys/:id — soft-revoke a key in the caller's org.
   *
   * Returns 204 on success, 404 if the id doesn't belong to this org OR is
   * already revoked OR doesn't exist. We collapse "not yours" and "not
   * found" to the same 404 — a priv-auth'd operator poking at a competitor's
   * short-id should get no tell.
   *
   * Revoke is eventually-consistent across replicas only to the extent of
   * argon2 cost; the row is updated atomically, and `verify()` re-reads
   * `revoked_at` on every call.
   */
  app.delete("/app/keys/:id", async (c) => {
    const gate = await requirePrivKey(c)
    if (gate.kind === "reject") return gate.response
    const id = c.req.param("id")
    // Cross-org guard: fetch the row first, confirm it belongs to the caller.
    // Without this, `epk_priv_` for org_acme could revoke `epk_priv_` for
    // org_competitor by guessing a 10-hex id. Unlikely-to-land with 40 bits
    // of id space, but "unlikely" isn't "impossible".
    const rows = await apiKeyStore.list(gate.orgId)
    const target = rows.find((r) => r.id === id)
    if (!target) {
      return c.json({ error: "not found" }, 404)
    }
    const revoked = await apiKeyStore.revoke(id)
    if (!revoked) {
      // Already revoked — same response as "not found" on purpose.
      return c.json({ error: "not found" }, 404)
    }
    return c.body(null, 204)
  })

  return app
}

/**
 * Test-default deps: in-memory store, deterministic, zero I/O. Stays sync
 * at construction time so tests can do `const deps = makeMemoryDeps(s)`
 * without juggling await in every setup.
 *
 * `dashboardKeys` defaults to the test mapping (acme + competitor). Tests
 * that want to exercise "no valid key" can pass an empty Map.
 *
 * The rate limiter is generously sized so existing fixtures don't trip it
 * accidentally — tests that specifically exercise rate limiting construct
 * their own tight limiter.
 */
export function makeMemoryDeps(
  shareTokenSecret: string,
  dashboardKeys: Map<string, string> = testDashboardKeys(),
  overrides: Partial<
    Pick<AppDeps, "rateLimiter" | "metrics" | "maxIngestBytes" | "now" | "apiKeyStore">
  > = {},
): AppDeps {
  const store = new InMemorySpanStore()
  const views = new SpanViews(store)
  const signer = new HmacShareTokenSigner(shareTokenSecret)
  const rateLimiter =
    overrides.rateLimiter ??
    new RateLimiter({
      // Loose by default for existing tests; tight limiter is injected by
      // the few tests that actually exercise /ingest rate limiting.
      spansPerSec: 10_000,
      bytesPerDay: 10 * 1024 * 1024 * 1024, // 10 GB
    })
  const metrics = overrides.metrics ?? new Metrics()
  const maxIngestBytes = overrides.maxIngestBytes ?? DEFAULT_INGEST_MAX_BYTES
  const now = overrides.now ?? (() => new Date())
  const apiKeyStore = overrides.apiKeyStore ?? new InMemoryApiKeyStore()
  return {
    store,
    views,
    signer,
    dashboardKeys,
    apiKeyStore,
    rateLimiter,
    metrics,
    maxIngestBytes,
    now,
  }
}

/**
 * Production deps. If `databaseUrl` is set, connect to Postgres, run
 * migrations, and return a Pg-backed store. Otherwise fall back to
 * in-memory (useful for local smoke tests when PG isn't running, and for
 * the `bun run src/server.ts` path in dev).
 *
 * Migrations run at boot. If they fail, the app doesn't start. Loud > quiet.
 */
export async function makeDefaultDeps(config: {
  shareTokenSecret: string
  dashboardKeys: Map<string, string>
  databaseUrl?: string | undefined
  maxIngestBytes?: number
  spansPerSec?: number
  bytesPerDay?: number
  /**
   * Raw `BOOTSTRAP_API_KEYS` env var (JSON). Seeded into the ApiKeyStore at
   * boot. Lets the Day-1 operator ship a known priv key so they can hit
   * `/app/keys` before any keys exist in the DB. After boot the `/app/keys`
   * admin endpoint is the only mint surface.
   */
  bootstrapApiKeysJson?: string | undefined
}): Promise<AppDeps> {
  const signer = new HmacShareTokenSigner(config.shareTokenSecret)
  const metrics = new Metrics()
  const rateLimiter = new RateLimiter({
    spansPerSec: config.spansPerSec ?? DEFAULT_SPANS_PER_SEC,
    bytesPerDay: config.bytesPerDay ?? DEFAULT_BYTES_PER_DAY,
  })
  const maxIngestBytes = config.maxIngestBytes ?? DEFAULT_INGEST_MAX_BYTES
  const now = () => new Date()

  let apiKeyStore: ApiKeyStore
  let deps: AppDeps
  if (config.databaseUrl) {
    const sql = createSQL(config.databaseUrl)
    const applied = await runMigrations(sql)
    if (applied.length > 0) {
      console.log(`[migrate] applied: ${applied.join(", ")}`)
    }
    const store = new PgSpanStore(sql)
    apiKeyStore = new PgApiKeyStore(sql)
    deps = {
      store,
      views: new SpanViews(store),
      signer,
      dashboardKeys: config.dashboardKeys,
      apiKeyStore,
      rateLimiter,
      metrics,
      maxIngestBytes,
      now,
    }
  } else {
    console.warn("[server] DATABASE_URL not set — using in-memory store (data lost on restart)")
    apiKeyStore = new InMemoryApiKeyStore()
    deps = makeMemoryDeps(config.shareTokenSecret, config.dashboardKeys, {
      rateLimiter,
      metrics,
      maxIngestBytes,
      now,
      apiKeyStore,
    })
  }

  // Seed the store from BOOTSTRAP_API_KEYS. Idempotent across restarts
  // because `seed()` is a no-op when the row already exists.
  const bootstrapEntries = parseBootstrapKeys(config.bootstrapApiKeysJson)
  if (bootstrapEntries.length > 0) {
    for (const entry of bootstrapEntries) {
      await apiKeyStore.seed(entry.rawToken, entry.orgId, entry.keyType, entry.name)
    }
    console.log(`[bootstrap] seeded ${bootstrapEntries.length} API key(s) from BOOTSTRAP_API_KEYS`)
  }
  return deps
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

/**
 * Load optional dashboard keys from env. Unlike pre-Slice-5, this is NOT
 * fatal if unset: `epk_priv_` keys minted via `/app/keys` authenticate the
 * dashboard too, so an operator can boot with only `BOOTSTRAP_API_KEYS` and
 * skip the legacy `DASHBOARD_KEYS` surface entirely.
 *
 * If BOTH are unset we warn loudly — boots like that cannot auth any
 * dashboard call; the operator probably made a mistake and won't realize
 * it until the first 401 rolls in. Warn, don't crash.
 */
function loadDashboardKeys(): Map<string, string> {
  return parseDashboardKeys(process.env.DASHBOARD_KEYS)
}

/**
 * Run the retention sweep once. Drops traces (and cascades to spans) older
 * than `retentionDays`. Returns the count purged for log/metric purposes.
 *
 * Exposed so tests can call it directly with a pinned `now`, and the
 * scheduled timer below can call it on an interval without re-implementing
 * the math.
 */
export async function runRetentionSweep(
  deps: AppDeps,
  retentionDays: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)
  const removed = await deps.store.purgeExpired(cutoff)
  if (removed > 0) {
    deps.metrics.inc("edgeprobe_traces_purged_total", {}, removed)
    console.log(`[retention] purged ${removed} traces older than ${cutoff.toISOString()}`)
  }
  return removed
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return Math.floor(n)
}

// Allow `bun run src/server.ts` to boot the server directly.
if (import.meta.main) {
  const maxIngestBytes = envInt("INGEST_MAX_BYTES", DEFAULT_INGEST_MAX_BYTES)
  const spansPerSec = envInt("INGEST_SPANS_PER_SEC", DEFAULT_SPANS_PER_SEC)
  const bytesPerDay = envInt("INGEST_BYTES_PER_DAY", DEFAULT_BYTES_PER_DAY)
  const retentionDays = envInt("RETENTION_DAYS", DEFAULT_RETENTION_DAYS)

  const dashboardKeys = loadDashboardKeys()
  const bootstrapApiKeysJson = process.env.BOOTSTRAP_API_KEYS
  if (dashboardKeys.size === 0 && !bootstrapApiKeysJson) {
    console.warn(
      "[server] neither DASHBOARD_KEYS nor BOOTSTRAP_API_KEYS is set — " +
        "no dashboard bearer will authenticate. Mint an epk_priv_ key out-of-band " +
        "or set one of these envs.",
    )
  }
  const deps = await makeDefaultDeps({
    shareTokenSecret: requireShareSecret(),
    dashboardKeys,
    databaseUrl: process.env.DATABASE_URL,
    maxIngestBytes,
    spansPerSec,
    bytesPerDay,
    bootstrapApiKeysJson,
  })
  const app = createApp(deps)
  const port = Number(process.env.PORT ?? 3000)
  console.log(
    `EdgeProbe backend listening on :${port} ` +
      `(max ${maxIngestBytes}B/req, ${spansPerSec} spans/s, ${bytesPerDay}B/day, retain ${retentionDays}d)`,
  )

  // Run the retention sweep once at boot (so a stopped backend that missed
  // ticks still catches up), then hourly. 1h is the smallest useful cadence —
  // more frequent and we'd be reading the index for no new deletes.
  await runRetentionSweep(deps, retentionDays).catch((err) => {
    console.error("[retention] boot sweep failed", err)
  })
  setInterval(
    () => {
      runRetentionSweep(deps, retentionDays).catch((err) => {
        console.error("[retention] sweep failed", err)
      })
    },
    60 * 60 * 1000,
  )

  Bun.serve({ port, fetch: app.fetch })
}
