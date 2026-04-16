import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test"
import { createSQL, type Sql } from "../src/db.ts"
import { runMigrations } from "../src/migrate.ts"
import { PgSpanStore } from "../src/pgSpanStore.ts"
import { SpanViews, type StoredSpan, type Trace } from "../src/views.ts"

/**
 * Roundtrip tests against a real Postgres. Gated on TEST_DATABASE_URL so the
 * default `bun test` run on a laptop with no Postgres stays green. CI sets
 * TEST_DATABASE_URL to the docker-compose instance and runs these alongside
 * the in-memory suite.
 *
 * The same PII boundary that the in-memory tests prove — public view vs
 * private view — needs to hold against Postgres too, because the production
 * path runs Pg. These tests prove the Pg store gives SpanViews the same
 * contract, row-for-row.
 *
 * Isolation: TRUNCATE in beforeEach. The `_migrations` table is left alone
 * so we don't rerun the schema on every test.
 */

const TEST_DB_URL = process.env.TEST_DATABASE_URL
const describePg = TEST_DB_URL ? describe : describe.skip

describePg("PgSpanStore roundtrip (TEST_DATABASE_URL)", () => {
  let sql: Sql
  let store: PgSpanStore
  let views: SpanViews

  beforeAll(async () => {
    sql = createSQL(TEST_DB_URL!)
    await runMigrations(sql)
    store = new PgSpanStore(sql)
    views = new SpanViews(store)
  })

  afterAll(async () => {
    await sql.end({ timeout: 5 })
  })

  beforeEach(async () => {
    // Order matters: spans → traces → share_tokens → api_keys → org_members → orgs.
    // CASCADE from orgs handles child tables, but being explicit keeps errors
    // legible if the FK graph changes.
    await sql`TRUNCATE TABLE spans, share_tokens, traces, api_keys, org_members, orgs CASCADE`
  })

  test("insertTrace + getTrace roundtrip preserves all fields", async () => {
    const trace: Trace = {
      id: "trace_pg_1",
      orgId: "org_acme",
      projectId: "proj_voice",
      sessionId: "sess_xyz",
      startedAt: "2026-04-15T12:00:00.123Z",
      endedAt: "2026-04-15T12:00:01.456Z",
      device: { model: "iPhone 15 Pro", os: "iOS 18.2" },
      attributes: { "build.commit": "abc123", count: 42 },
      sensitive: false,
    }
    await store.insertTrace(trace)

    const got = await store.getTrace("trace_pg_1")
    expect(got).toBeDefined()
    expect(got!.id).toBe("trace_pg_1")
    expect(got!.orgId).toBe("org_acme")
    expect(got!.projectId).toBe("proj_voice")
    expect(got!.sessionId).toBe("sess_xyz")
    expect(got!.startedAt).toBe("2026-04-15T12:00:00.123Z")
    expect(got!.endedAt).toBe("2026-04-15T12:00:01.456Z")
    expect(got!.device).toEqual({ model: "iPhone 15 Pro", os: "iOS 18.2" })
    expect(got!.attributes).toEqual({ "build.commit": "abc123", count: 42 })
    expect(got!.sensitive).toBe(false)
  })

  test("insertTrace auto-upserts the orgs FK row", async () => {
    // No explicit orgs INSERT — this is the whole point of the auto-upsert.
    await store.insertTrace({
      id: "trace_pg_fk",
      orgId: "org_fresh",
      projectId: "p",
      sessionId: null,
      startedAt: "2026-04-15T12:00:00Z",
      endedAt: null,
      device: {},
      attributes: {},
      sensitive: false,
    })
    const rows = await sql<Array<{ id: string }>>`SELECT id FROM orgs WHERE id = 'org_fresh'`
    expect(rows.length).toBe(1)
  })

  test("insertTrace is idempotent (ON CONFLICT DO NOTHING)", async () => {
    const t: Trace = {
      id: "trace_pg_dup",
      orgId: "org_acme",
      projectId: "p",
      sessionId: null,
      startedAt: "2026-04-15T12:00:00Z",
      endedAt: null,
      device: {},
      attributes: {},
      sensitive: false,
    }
    await store.insertTrace(t)
    await store.insertTrace(t) // must not throw
    const got = await store.getTrace("trace_pg_dup")
    expect(got).toBeDefined()
  })

  test("insertSpan + getSpansForTrace roundtrip preserves content fields", async () => {
    await store.insertTrace({
      id: "trace_pg_2",
      orgId: "org_acme",
      projectId: "p",
      sessionId: null,
      startedAt: "2026-04-15T12:00:00Z",
      endedAt: "2026-04-15T12:00:01Z",
      device: {},
      attributes: {},
      sensitive: false,
    })
    const span: StoredSpan = {
      id: "span_pg_1",
      traceId: "trace_pg_2",
      parentSpanId: null,
      name: "llama-decode",
      kind: "llm",
      startedAt: "2026-04-15T12:00:00.100Z",
      endedAt: "2026-04-15T12:00:00.700Z",
      durationMs: 600,
      status: "ok",
      attributes: { "gen_ai.request.model": "llama-3.2-3b" },
      includeContent: true,
      promptText: "round-trip prompt",
      completionText: "round-trip completion",
      transcriptText: null,
    }
    await store.insertSpan(span)

    const spans = await store.getSpansForTrace("trace_pg_2")
    expect(spans.length).toBe(1)
    expect(spans[0]).toEqual(span)
  })

  test("getSpansForTrace orders by started_at", async () => {
    await store.insertTrace({
      id: "trace_pg_order",
      orgId: "org_acme",
      projectId: "p",
      sessionId: null,
      startedAt: "2026-04-15T12:00:00Z",
      endedAt: null,
      device: {},
      attributes: {},
      sensitive: false,
    })
    const later: StoredSpan = {
      id: "span_later",
      traceId: "trace_pg_order",
      parentSpanId: null,
      name: "b",
      kind: "llm",
      startedAt: "2026-04-15T12:00:02.000Z",
      endedAt: "2026-04-15T12:00:02.100Z",
      durationMs: 100,
      status: "ok",
      attributes: {},
      includeContent: false,
      promptText: null,
      completionText: null,
      transcriptText: null,
    }
    const earlier: StoredSpan = { ...later, id: "span_earlier", name: "a", startedAt: "2026-04-15T12:00:01.000Z", endedAt: "2026-04-15T12:00:01.100Z" }
    // Insert in reverse order to make sure the ORDER BY is doing the work.
    await store.insertSpan(later)
    await store.insertSpan(earlier)

    const spans = await store.getSpansForTrace("trace_pg_order")
    expect(spans.map((s) => s.id)).toEqual(["span_earlier", "span_later"])
  })

  test("getTrace returns undefined for missing id", async () => {
    const got = await store.getTrace("trace_never_existed")
    expect(got).toBeUndefined()
  })

  test("getSpansForTrace returns [] for missing trace", async () => {
    const spans = await store.getSpansForTrace("trace_never_existed")
    expect(spans).toEqual([])
  })

  test("SpanViews.public_forTrace strips content when backed by Pg", async () => {
    // The whole reason the Pg store exists: same PII contract as in-memory.
    await store.insertTrace({
      id: "trace_pg_pii",
      orgId: "org_acme",
      projectId: "p",
      sessionId: null,
      startedAt: "2026-04-15T12:00:00Z",
      endedAt: "2026-04-15T12:00:01Z",
      device: {},
      attributes: {},
      sensitive: false,
    })
    await store.insertSpan({
      id: "span_pg_pii",
      traceId: "trace_pg_pii",
      parentSpanId: null,
      name: "llama",
      kind: "llm",
      startedAt: "2026-04-15T12:00:00.100Z",
      endedAt: "2026-04-15T12:00:00.700Z",
      durationMs: 600,
      status: "ok",
      attributes: {
        "gen_ai.request.model": "llama-3.2-3b",
        "gen_ai.prompt": "SECRET USER PROMPT",
        "content.transcript": "SECRET",
      },
      includeContent: true,
      promptText: "SECRET USER PROMPT",
      completionText: "SECRET COMPLETION",
      transcriptText: null,
    })

    const pub = await views.public_forTrace("trace_pg_pii")
    const raw = JSON.stringify(pub)
    expect(raw).not.toContain("SECRET USER PROMPT")
    expect(raw).not.toContain("SECRET COMPLETION")
    expect(pub[0].attributes).not.toHaveProperty("gen_ai.prompt")
    expect(pub[0].attributes).not.toHaveProperty("content.transcript")
    // Non-content attributes still come through.
    expect(pub[0].attributes).toHaveProperty("gen_ai.request.model")

    // Private view, same org, DOES have content.
    const priv = await views.private_forTrace("trace_pg_pii", "org_acme")
    expect(JSON.stringify(priv)).toContain("SECRET USER PROMPT")
  })

  test("SpanViews.public_forTrace returns [] for sensitive trace", async () => {
    await store.insertTrace({
      id: "trace_pg_sens",
      orgId: "org_acme",
      projectId: "p",
      sessionId: null,
      startedAt: "2026-04-15T12:00:00Z",
      endedAt: null,
      device: {},
      attributes: {},
      sensitive: true,
    })
    const pub = await views.public_forTrace("trace_pg_sens")
    expect(pub).toEqual([])
  })

  test("SpanViews.private_forTrace returns [] on cross-org", async () => {
    await store.insertTrace({
      id: "trace_pg_crossorg",
      orgId: "org_acme",
      projectId: "p",
      sessionId: null,
      startedAt: "2026-04-15T12:00:00Z",
      endedAt: null,
      device: {},
      attributes: {},
      sensitive: false,
    })
    const priv = await views.private_forTrace("trace_pg_crossorg", "org_competitor")
    expect(priv).toEqual([])
  })

  test("runMigrations is idempotent", async () => {
    // We already called it in beforeAll; a second call should no-op.
    const applied = await runMigrations(sql)
    expect(applied).toEqual([])
  })
})
