/**
 * Parse the dev-side `ORG_BEARERS` env var into an `orgId → dashboardKey` map.
 *
 * Shape matches the backend's `DASHBOARD_KEYS` inverted:
 *   ORG_BEARERS = '{"org_acme":"epk_dash_acme_...","org_competitor":"epk_dash_comp_..."}'
 *
 * In prod the web dashboard would populate this from the user's session —
 * typically one entry, for the signed-in org. The env-driven form keeps
 * multi-org dev (and the e2e script) working without a login shell.
 *
 * Returns an empty map on missing/empty input; the `/app/*` handler
 * collapses "no bearer for the requested org" to not-found.
 */
export function parseOrgBearerMap(raw: string | undefined): Map<string, string> {
  if (!raw || raw.trim() === "") return new Map()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`ORG_BEARERS is not valid JSON`)
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`ORG_BEARERS must be a JSON object of { "org_...": "epk_dash_..." }`)
  }
  const out = new Map<string, string>()
  for (const [org, bearer] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof bearer !== "string" || bearer.length === 0) {
      throw new Error(`ORG_BEARERS: value for "${org}" must be a non-empty dashboard key`)
    }
    out.set(org, bearer)
  }
  return out
}
