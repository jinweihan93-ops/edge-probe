import { describe, test, expect } from "bun:test"
import { createApp, makeMemoryDeps } from "../src/server.ts"
import {
  parseDashboardKeys,
  DashboardKeysConfigError,
  TEST_DASHBOARD_KEY_ACME,
  TEST_DASHBOARD_KEY_COMPETITOR,
} from "../src/auth.ts"

/**
 * Auth-middleware tests. Complement pii-boundary.test.ts, which exercises
 * the Critical Paths through the full app. Here we prove the individual
 * moving parts in isolation so a regression tells us which piece broke.
 */

const SECRET = "x".repeat(48)

describe("parseDashboardKeys", () => {
  test("empty or missing env → empty map (boot may still fail, not our job)", () => {
    expect(parseDashboardKeys(undefined).size).toBe(0)
    expect(parseDashboardKeys("").size).toBe(0)
    expect(parseDashboardKeys("   ").size).toBe(0)
  })

  test("happy path: JSON object → key → orgId Map", () => {
    const map = parseDashboardKeys(
      JSON.stringify({
        [TEST_DASHBOARD_KEY_ACME]: "org_acme",
        [TEST_DASHBOARD_KEY_COMPETITOR]: "org_competitor",
      }),
    )
    expect(map.size).toBe(2)
    expect(map.get(TEST_DASHBOARD_KEY_ACME)).toBe("org_acme")
    expect(map.get(TEST_DASHBOARD_KEY_COMPETITOR)).toBe("org_competitor")
  })

  test("multiple keys for one org is allowed — covers rotation", () => {
    const k1 = "epk_dash_acme_primary_key_0000000000"
    const k2 = "epk_dash_acme_backup_key_00000000000"
    const map = parseDashboardKeys(
      JSON.stringify({ [k1]: "org_acme", [k2]: "org_acme" }),
    )
    expect(map.get(k1)).toBe("org_acme")
    expect(map.get(k2)).toBe("org_acme")
  })

  test("malformed JSON throws a typed boot-time error", () => {
    expect(() => parseDashboardKeys("{not valid")).toThrow(DashboardKeysConfigError)
  })

  test("array at top level is rejected", () => {
    expect(() =>
      parseDashboardKeys(JSON.stringify([["epk_dash_x_00000000000000000", "org_x"]])),
    ).toThrow(DashboardKeysConfigError)
  })

  test("key without epk_dash_ prefix is rejected", () => {
    expect(() =>
      parseDashboardKeys(JSON.stringify({ nope_00000000000000000000000: "org_acme" })),
    ).toThrow(DashboardKeysConfigError)
  })

  test("key that is too short is rejected", () => {
    expect(() =>
      parseDashboardKeys(JSON.stringify({ epk_dash_: "org_acme" })),
    ).toThrow(DashboardKeysConfigError)
  })

  test("non-string value is rejected", () => {
    expect(() =>
      parseDashboardKeys(JSON.stringify({ [TEST_DASHBOARD_KEY_ACME]: 42 })),
    ).toThrow(DashboardKeysConfigError)

    expect(() =>
      parseDashboardKeys(JSON.stringify({ [TEST_DASHBOARD_KEY_ACME]: "" })),
    ).toThrow(DashboardKeysConfigError)
  })
})

describe("/app/* auth wiring", () => {
  test("missing Authorization header → 401, never 404 (no existence probe)", async () => {
    const app = createApp(makeMemoryDeps(SECRET))
    const res = await app.request("/app/trace/trace_anything_at_all")
    expect(res.status).toBe(401)
  })

  test("non-Bearer scheme → 401", async () => {
    const app = createApp(makeMemoryDeps(SECRET))
    const res = await app.request("/app/trace/x", {
      headers: { Authorization: "Basic abc123" },
    })
    expect(res.status).toBe(401)
  })

  test("Bearer with wrong prefix (epk_pub_, not epk_dash_) → 401", async () => {
    // The ingest key must not double as a dashboard key. Distinct prefixes
    // make this a compile-time-ish check — you'd have to actively paste the
    // wrong one across environments to get burned.
    const app = createApp(makeMemoryDeps(SECRET))
    const res = await app.request("/app/trace/x", {
      headers: { Authorization: "Bearer epk_pub_not_a_dashboard_key_xxxx" },
    })
    expect(res.status).toBe(401)
  })

  test("Bearer with correct prefix but unknown key → 401", async () => {
    const app = createApp(makeMemoryDeps(SECRET))
    const res = await app.request("/app/trace/x", {
      headers: { Authorization: "Bearer epk_dash_never_configured_xxxxxxxx" },
    })
    expect(res.status).toBe(401)
  })

  test("Bearer with known key → request proceeds (404 for missing trace, not 401)", async () => {
    const app = createApp(makeMemoryDeps(SECRET))
    const res = await app.request("/app/trace/trace_definitely_missing", {
      headers: { Authorization: `Bearer ${TEST_DASHBOARD_KEY_ACME}` },
    })
    expect(res.status).toBe(404)
  })

  test("empty dashboardKeys map → all /app/* requests 401 (no backdoor)", async () => {
    // Even a syntactically valid key is unauthorized if the table is empty.
    // Protects against a misconfigured prod where DASHBOARD_KEYS parsed
    // but came back empty for some reason.
    const app = createApp(makeMemoryDeps(SECRET, new Map()))
    const res = await app.request("/app/trace/x", {
      headers: { Authorization: `Bearer ${TEST_DASHBOARD_KEY_ACME}` },
    })
    expect(res.status).toBe(401)
  })

  test("X-Org-Id header is no longer honored (regression guard)", async () => {
    // The old trust-on-first-sight header must not ever be accepted again,
    // even if someone sends both. The bearer is the one and only identity.
    const app = createApp(makeMemoryDeps(SECRET))
    const res = await app.request("/app/trace/x", {
      headers: { "X-Org-Id": "org_acme" },
    })
    expect(res.status).toBe(401)
  })
})
