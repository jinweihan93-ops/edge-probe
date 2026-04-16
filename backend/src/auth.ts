/**
 * Dashboard-key auth for the `/app/*` routes.
 *
 * Day-1 model: the caller sends `Authorization: Bearer epk_dash_<random>`. The
 * server maps that bearer to an orgId via a boot-time table. The orgId is
 * derived from the key, NEVER from a client-supplied header. This is the
 * whole point — the previous `X-Org-Id` header was trust-on-first-sight.
 *
 * The bearer represents a dashboard session (in prod, minted by the login
 * flow; in dev, pre-configured in `DASHBOARD_KEYS` env var). A device SDK
 * should NOT carry this key — it gets its own scoped ingest key
 * (`epk_pub_`). The DemoApp currently doubles up for demo convenience,
 * but the signatures here would let us separate device-mint-share keys
 * from dashboard-read keys without another migration.
 *
 * Boot-time shape:
 *
 *   DASHBOARD_KEYS = '{"epk_dash_acme_abc":"org_acme","epk_dash_comp_xyz":"org_competitor"}'
 *
 * Why JSON and not a list of `KEY=VAL`: keys are random 32-char strings, orgs
 * are kebab-cased — both play nicely inside JSON. Fly/Render/Vercel all
 * accept multiline env vars without fuss. Rotating a key is editing JSON and
 * bouncing the server.
 */

import type { Context } from "hono"

/** Minimum length for a dashboard key. Matches the `epk_dash_` prefix + 16 hex. */
const MIN_DASHBOARD_KEY_LENGTH = "epk_dash_".length + 16

export const DASHBOARD_KEY_PREFIX = "epk_dash_"

/** Thrown when the env var is malformed. Boot-time fatal; we don't tolerate silent skew. */
export class DashboardKeysConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DashboardKeysConfigError"
  }
}

/**
 * Parse the `DASHBOARD_KEYS` env var into a `key → orgId` map.
 *
 * Rejects malformed JSON, non-object shapes, non-string values, keys that
 * don't carry the `epk_dash_` prefix, and keys shorter than the minimum.
 * Duplicate orgIds are allowed (two keys for one org is valid — the
 * dashboard may rotate without downtime).
 */
export function parseDashboardKeys(raw: string | undefined): Map<string, string> {
  const result = new Map<string, string>()
  if (!raw || raw.trim() === "") return result

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new DashboardKeysConfigError(
      `DASHBOARD_KEYS is not valid JSON: ${(err as Error).message}`,
    )
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DashboardKeysConfigError(
      `DASHBOARD_KEYS must be a JSON object of { "epk_dash_...": "org_..." } pairs`,
    )
  }

  for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof val !== "string" || val.length === 0) {
      throw new DashboardKeysConfigError(
        `DASHBOARD_KEYS: value for key "${key}" must be a non-empty orgId string`,
      )
    }
    if (!key.startsWith(DASHBOARD_KEY_PREFIX)) {
      throw new DashboardKeysConfigError(
        `DASHBOARD_KEYS: key "${key}" must start with "${DASHBOARD_KEY_PREFIX}"`,
      )
    }
    if (key.length < MIN_DASHBOARD_KEY_LENGTH) {
      throw new DashboardKeysConfigError(
        `DASHBOARD_KEYS: key "${key}" is shorter than ${MIN_DASHBOARD_KEY_LENGTH} chars`,
      )
    }
    result.set(key, val)
  }
  return result
}

/**
 * Pull the `Authorization: Bearer <key>` header out of a Hono context and
 * map it to an orgId using the boot-time table. Returns `null` if missing,
 * malformed, or unrecognized. Callers return 401 for `null`.
 *
 * Deliberately does not distinguish "missing header" from "unknown key":
 * the response to the client is the same 401, and timing-distinguishable
 * behavior only helps an attacker probe the key table.
 */
export function getAuthenticatedOrg(
  c: Context,
  dashboardKeys: Map<string, string>,
): string | null {
  const auth = c.req.header("Authorization")
  if (!auth) return null
  if (!auth.startsWith("Bearer ")) return null
  const key = auth.slice("Bearer ".length).trim()
  if (!key.startsWith(DASHBOARD_KEY_PREFIX)) return null
  const orgId = dashboardKeys.get(key)
  return orgId ?? null
}

/**
 * Default test mapping used by `makeMemoryDeps`. Tests that want to
 * exercise "no valid key" can pass an empty Map instead.
 *
 * Two keys for two orgs lets us express cross-org scans in tests:
 *   - `epk_dash_acme_test_0000000000000000` → org_acme
 *   - `epk_dash_comp_test_0000000000000000` → org_competitor
 */
export const TEST_DASHBOARD_KEY_ACME = "epk_dash_acme_test_0000000000000000"
export const TEST_DASHBOARD_KEY_COMPETITOR = "epk_dash_comp_test_0000000000000000"

export function testDashboardKeys(): Map<string, string> {
  return new Map([
    [TEST_DASHBOARD_KEY_ACME, "org_acme"],
    [TEST_DASHBOARD_KEY_COMPETITOR, "org_competitor"],
  ])
}
