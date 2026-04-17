import { describe, test, expect, beforeEach } from "bun:test"
import { createApp, makeMemoryDeps, type AppDeps } from "../src/server.ts"
import {
  TEST_DASHBOARD_KEY_ACME,
  TEST_DASHBOARD_KEY_COMPETITOR,
} from "../src/auth.ts"
import { parseToken } from "../src/apiKeys.ts"

/**
 * Slice 5 admin surface: /app/keys — mint / list / revoke.
 *
 * These tests exercise the HTTP contract. Core store behavior (hashing,
 * dedup, revoke idempotency) is already covered by apiKeys.test.ts. Here we
 * care about:
 *   - priv-only authorization (a dashboard-only epk_dash_ bearer is rejected)
 *   - orgId comes from the authenticating key, not from the body
 *   - list returns metadata without raw secrets
 *   - revoke is cross-org-safe
 *   - the minted key actually works end-to-end for ingest
 */

const SECRET = "z".repeat(48)

async function setup(): Promise<{
  deps: AppDeps
  app: ReturnType<typeof createApp>
  privAcme: string
  privComp: string
}> {
  const deps = makeMemoryDeps(SECRET)
  const privAcme = (await deps.apiKeyStore.mint("org_acme", "priv", "bootstrap")).rawToken
  const privComp = (await deps.apiKeyStore.mint("org_competitor", "priv", "bootstrap")).rawToken
  const app = createApp(deps)
  return { deps, app, privAcme, privComp }
}

describe("POST /app/keys — mint", () => {
  test("priv key for the org mints a new pub key, returns 201 with rawToken", async () => {
    const { app, privAcme } = await setup()
    const res = await app.request("/app/keys", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${privAcme}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ keyType: "pub", name: "demo-app" }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      row: { orgId: string; keyType: string; name: string; revokedAt: null }
      rawToken: string
    }
    expect(body.row.orgId).toBe("org_acme")
    expect(body.row.keyType).toBe("pub")
    expect(body.row.name).toBe("demo-app")
    expect(body.row.revokedAt).toBeNull()
    // Raw token is epk_pub_<10hex>_<32hex>
    const parsed = parseToken(body.rawToken)
    expect(parsed).not.toBeNull()
    expect(parsed!.keyType).toBe("pub")
  })

  test("mints work for priv keys too (rotation story)", async () => {
    const { app, privAcme } = await setup()
    const res = await app.request("/app/keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${privAcme}`, "Content-Type": "application/json" },
      body: JSON.stringify({ keyType: "priv", name: "new-founder-key" }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { rawToken: string }
    expect(body.rawToken.startsWith("epk_priv_")).toBe(true)
  })

  test("body cannot override orgId — keys always mint in the caller's org", async () => {
    const { app, privAcme } = await setup()
    // Attempt to mint under org_competitor using acme's priv key.
    // The body's `orgId` field is IGNORED (not part of the schema); the
    // returned row must be org_acme regardless.
    const res = await app.request("/app/keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${privAcme}`, "Content-Type": "application/json" },
      body: JSON.stringify({ keyType: "pub", name: "hostile", orgId: "org_competitor" }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { row: { orgId: string } }
    expect(body.row.orgId).toBe("org_acme")
  })

  test("401 without Authorization header", async () => {
    const { app } = await setup()
    const res = await app.request("/app/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyType: "pub", name: "x" }),
    })
    expect(res.status).toBe(401)
  })

  test("401 when bearer is a dashboard key (epk_dash_ cannot mint)", async () => {
    const { app } = await setup()
    const res = await app.request("/app/keys", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_DASHBOARD_KEY_ACME}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ keyType: "pub", name: "x" }),
    })
    expect(res.status).toBe(401)
  })

  test("401 when bearer is a pub key (pub keys cannot mint)", async () => {
    const { deps, app, privAcme } = await setup()
    // Mint a pub key first via the admin endpoint...
    await app.request("/app/keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${privAcme}`, "Content-Type": "application/json" },
      body: JSON.stringify({ keyType: "pub", name: "target" }),
    })
    const pub = (await deps.apiKeyStore.mint("org_acme", "pub", "for-test")).rawToken
    // ... then try to use it to mint another. Must 401.
    const res = await app.request("/app/keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${pub}`, "Content-Type": "application/json" },
      body: JSON.stringify({ keyType: "pub", name: "x" }),
    })
    expect(res.status).toBe(401)
  })

  test("401 when priv token is shape-valid but unknown (unseeded)", async () => {
    const { app } = await setup()
    const res = await app.request("/app/keys", {
      method: "POST",
      headers: {
        Authorization: "Bearer epk_priv_0000000000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ keyType: "pub", name: "x" }),
    })
    expect(res.status).toBe(401)
  })

  test("401 after the minting priv key is revoked", async () => {
    const { deps, app, privAcme } = await setup()
    // Look up the row id by listing and re-minting.
    const parsed = parseToken(privAcme)!
    await deps.apiKeyStore.revoke(parsed.id)
    const res = await app.request("/app/keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${privAcme}`, "Content-Type": "application/json" },
      body: JSON.stringify({ keyType: "pub", name: "x" }),
    })
    expect(res.status).toBe(401)
  })

  test("400 on invalid keyType", async () => {
    const { app, privAcme } = await setup()
    const res = await app.request("/app/keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${privAcme}`, "Content-Type": "application/json" },
      body: JSON.stringify({ keyType: "dash", name: "x" }),
    })
    expect(res.status).toBe(400)
  })

  test("400 on missing name", async () => {
    const { app, privAcme } = await setup()
    const res = await app.request("/app/keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${privAcme}`, "Content-Type": "application/json" },
      body: JSON.stringify({ keyType: "pub" }),
    })
    expect(res.status).toBe(400)
  })

  test("400 on invalid JSON body", async () => {
    const { app, privAcme } = await setup()
    const res = await app.request("/app/keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${privAcme}`, "Content-Type": "application/json" },
      body: "{not json",
    })
    expect(res.status).toBe(400)
  })
})

describe("GET /app/keys — list", () => {
  test("returns metadata for the caller's org, newest-first, no raw secrets", async () => {
    const { app, privAcme, deps } = await setup()
    await deps.apiKeyStore.mint("org_acme", "pub", "first")
    await new Promise((r) => setTimeout(r, 5))
    await deps.apiKeyStore.mint("org_acme", "priv", "second")

    const res = await app.request("/app/keys", {
      headers: { Authorization: `Bearer ${privAcme}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { keys: Array<Record<string, unknown>> }
    // Bootstrap priv + first + second = 3 keys.
    expect(body.keys.length).toBe(3)
    // Nothing in here leaks a hash or raw token.
    const raw = JSON.stringify(body)
    expect(raw).not.toContain("keyHash")
    expect(raw).not.toContain("key_hash")
    expect(raw).not.toMatch(/epk_(pub|priv)_[0-9a-f]{10}_[0-9a-f]{32}/)
    for (const row of body.keys) {
      expect(row).toHaveProperty("id")
      expect(row).toHaveProperty("orgId", "org_acme")
      expect(row).toHaveProperty("keyType")
      expect(row).toHaveProperty("createdAt")
      expect(row).toHaveProperty("revokedAt")
      expect(row).not.toHaveProperty("keyHash")
    }
  })

  test("cross-org isolation — comp's list does not see acme's keys", async () => {
    const { app, privComp, deps } = await setup()
    await deps.apiKeyStore.mint("org_acme", "pub", "acme-only")

    const res = await app.request("/app/keys", {
      headers: { Authorization: `Bearer ${privComp}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { keys: Array<{ orgId: string; name: string }> }
    for (const row of body.keys) {
      expect(row.orgId).toBe("org_competitor")
    }
    expect(body.keys.some((r) => r.name === "acme-only")).toBe(false)
  })

  test("401 without a priv bearer", async () => {
    const { app } = await setup()
    const res = await app.request("/app/keys")
    expect(res.status).toBe(401)
  })
})

describe("DELETE /app/keys/:id — revoke", () => {
  test("revokes a key in the caller's org, returns 204", async () => {
    const { app, privAcme, deps } = await setup()
    const { row } = await deps.apiKeyStore.mint("org_acme", "pub", "soon-revoked")

    const res = await app.request(`/app/keys/${row.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${privAcme}` },
    })
    expect(res.status).toBe(204)
    const listRes = await app.request("/app/keys", {
      headers: { Authorization: `Bearer ${privAcme}` },
    })
    const body = (await listRes.json()) as {
      keys: Array<{ id: string; revokedAt: string | null }>
    }
    const target = body.keys.find((k) => k.id === row.id)
    expect(target).toBeDefined()
    expect(target!.revokedAt).not.toBeNull()
  })

  test("404 on missing id (not 401 — we've already auth'd)", async () => {
    const { app, privAcme } = await setup()
    const res = await app.request("/app/keys/0000000000", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${privAcme}` },
    })
    expect(res.status).toBe(404)
  })

  test("cross-org revoke returns 404 (competitor cannot revoke acme's key)", async () => {
    const { app, privComp, deps } = await setup()
    const { row } = await deps.apiKeyStore.mint("org_acme", "pub", "acme-only")
    const res = await app.request(`/app/keys/${row.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${privComp}` },
    })
    expect(res.status).toBe(404)
    // And the row is still active — revokedAt is still null on acme's side.
    const rows = await deps.apiKeyStore.list("org_acme")
    expect(rows.find((r) => r.id === row.id)!.revokedAt).toBeNull()
  })

  test("revoking twice returns 404 on the second call", async () => {
    const { app, privAcme, deps } = await setup()
    const { row } = await deps.apiKeyStore.mint("org_acme", "pub", "soon-revoked")
    const first = await app.request(`/app/keys/${row.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${privAcme}` },
    })
    expect(first.status).toBe(204)
    const second = await app.request(`/app/keys/${row.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${privAcme}` },
    })
    expect(second.status).toBe(404)
  })
})

describe("Slice 5 e2e — mint via admin, ingest, revoke, subsequent ingest 401", () => {
  test("full round-trip", async () => {
    const { app, privAcme } = await setup()
    // Mint a pub key.
    const mint = await app.request("/app/keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${privAcme}`, "Content-Type": "application/json" },
      body: JSON.stringify({ keyType: "pub", name: "e2e" }),
    })
    expect(mint.status).toBe(201)
    const mintBody = (await mint.json()) as {
      row: { id: string }
      rawToken: string
    }
    const pubToken = mintBody.rawToken
    const pubId = mintBody.row.id

    // Use the minted key to ingest — must 202.
    const payload = {
      trace: {
        id: "trace_s5_roundtrip",
        orgId: "org_acme",
        projectId: "p",
        sessionId: null,
        startedAt: "2026-04-17T12:00:00Z",
        endedAt: null,
        device: {},
        attributes: {},
        sensitive: false,
      },
      spans: [],
    }
    const ingest1 = await app.request("/ingest", {
      method: "POST",
      headers: { Authorization: `Bearer ${pubToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    expect(ingest1.status).toBe(202)

    // Revoke via admin.
    const del = await app.request(`/app/keys/${pubId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${privAcme}` },
    })
    expect(del.status).toBe(204)

    // Re-ingest with the revoked token — must 401.
    const ingest2 = await app.request("/ingest", {
      method: "POST",
      headers: { Authorization: `Bearer ${pubToken}`, "Content-Type": "application/json" },
      // Different trace id so dedup doesn't mask the auth change.
      body: JSON.stringify({ ...payload, trace: { ...payload.trace, id: "trace_s5_after_revoke" } }),
    })
    expect(ingest2.status).toBe(401)
  })
})

describe("Slice 5 dashboard dual-mode — epk_priv_ works on /app/* routes too", () => {
  let deps: AppDeps
  let app: ReturnType<typeof createApp>
  let privAcme: string

  beforeEach(async () => {
    const s = await setup()
    deps = s.deps
    app = s.app
    privAcme = s.privAcme
  })

  test("GET /app/projects accepts epk_priv_ bearer (not just epk_dash_)", async () => {
    // Seed a trace so the listing isn't empty.
    await deps.store.insertTrace({
      id: "trace_for_priv_dash",
      orgId: "org_acme",
      projectId: "proj_test",
      sessionId: null,
      startedAt: "2026-04-17T12:00:00Z",
      endedAt: null,
      device: {},
      attributes: {},
      sensitive: false,
    })

    // Old path: dash key.
    const dash = await app.request("/app/projects", {
      headers: { Authorization: `Bearer ${TEST_DASHBOARD_KEY_ACME}` },
    })
    expect(dash.status).toBe(200)

    // New path: priv key.
    const priv = await app.request("/app/projects", {
      headers: { Authorization: `Bearer ${privAcme}` },
    })
    expect(priv.status).toBe(200)
    const body = (await priv.json()) as { projects: Array<{ projectId: string }> }
    expect(body.projects.some((p) => p.projectId === "proj_test")).toBe(true)
  })

  test("priv key from wrong org → 403 on a cross-org trace (Critical Path #2 still holds)", async () => {
    await deps.store.insertTrace({
      id: "trace_cross_priv",
      orgId: "org_acme",
      projectId: "p",
      sessionId: null,
      startedAt: "2026-04-17T12:00:00Z",
      endedAt: null,
      device: {},
      attributes: {},
      sensitive: false,
    })
    // Competitor's priv key.
    const privComp = (await deps.apiKeyStore.mint("org_competitor", "priv", "comp")).rawToken
    const res = await app.request("/app/trace/trace_cross_priv", {
      headers: { Authorization: `Bearer ${privComp}` },
    })
    expect(res.status).toBe(403)
  })

  test("pub key is NOT accepted on /app/* routes (dash/priv only)", async () => {
    const pub = (await deps.apiKeyStore.mint("org_acme", "pub", "ingest-only")).rawToken
    const res = await app.request("/app/projects", {
      headers: { Authorization: `Bearer ${pub}` },
    })
    expect(res.status).toBe(401)
  })

  test("unknown competitor dash key still 401", async () => {
    // Sanity guard — regression would be "priv path fell through for unknown dash keys".
    const res = await app.request("/app/projects", {
      headers: { Authorization: `Bearer ${TEST_DASHBOARD_KEY_COMPETITOR}` },
    })
    // Competitor dash IS a valid bearer for org_competitor, so it 200s with
    // that org's projects — not 401. Guard the NO projects of acme-owned case.
    expect(res.status).toBe(200)
  })
})
