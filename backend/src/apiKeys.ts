/**
 * API key authentication — the load-bearing half of the two-key model.
 *
 * Token format:
 *
 *     epk_<type>_<id>_<secret>
 *
 * - `<type>` ∈ {`pub`, `priv`}. Determines routing authority, not identity:
 *   a `pub` key authorizes `/ingest`; a `priv` key authorizes `/app/keys`
 *   admin endpoints (mint / list / revoke) and — by policy — everything
 *   `epk_dash_` can do on the dashboard.
 * - `<id>` is 10 hex chars — the public row id in `api_keys`. Lets us do
 *   O(1) lookup without scanning the whole table and bcrypt-verifying every
 *   row. Safe to log and show in metrics.
 * - `<secret>` is 32 hex chars — the material we actually hash and compare.
 *   NEVER stored in the clear; on mint we return it to the caller exactly
 *   once and persist only `Bun.password.hash(secret)` in the `key_hash`
 *   column (argon2id).
 *
 * The split-field shape mirrors Stripe's publishable/secret key design,
 * Vercel's deployment tokens, and every other modern API: a readable
 * identifier plus opaque secret material. The prefix announces scope at
 * a glance when a key leaks into logs ("oh, a public ingest key, not a
 * root admin key"), which matters more than a couple of bytes.
 *
 * Bootstrap: on Day 1, no key exists. `BOOTSTRAP_API_KEYS` env seeds known
 * keys at boot so the operator can hit `/app/keys` to mint real ones.
 * Without bootstrapping, there's a chicken-and-egg: the admin endpoint
 * requires a priv key, but only the admin endpoint mints keys.
 */

/** The two key tiers we mint. */
export type KeyType = "pub" | "priv"

/** Metadata we can safely return — never the raw secret. */
export interface ApiKeyRow {
  /** 10-hex-char short id, visible inside the token. Stable across restarts. */
  id: string
  orgId: string
  keyType: KeyType
  name: string
  createdAt: string
  /** ISO8601 once revoked; null means active. */
  revokedAt: string | null
}

export interface MintedKey {
  row: ApiKeyRow
  /** Raw token. Returned exactly once, at mint time. */
  rawToken: string
}

export interface ApiKeyStore {
  /** Mint a new key. Returns row metadata + raw token (shown once). */
  mint(orgId: string, keyType: KeyType, name: string): Promise<MintedKey>
  /**
   * Seed a key with a caller-supplied raw token. Used by bootstrap and by
   * deterministic tests. Returns the row; the caller already has the raw.
   * No-op if a row with the parsed id already exists.
   */
  seed(rawToken: string, orgId: string, keyType: KeyType, name: string): Promise<ApiKeyRow>
  /** Soft-delete: set revoked_at. Returns true if an active row was revoked. */
  revoke(id: string): Promise<boolean>
  /** List metadata for an org's keys. Newest-first. Never includes raw tokens. */
  list(orgId: string): Promise<ApiKeyRow[]>
  /**
   * Look up a bearer token. Returns the active row on match, undefined on
   * anything else (malformed, unknown id, wrong secret, revoked, deleted).
   *
   * The "undefined on everything else" behavior is deliberate: we never
   * distinguish failure modes to the caller, so the 401 path stays timing-
   * stable and can't be probed.
   */
  verify(rawToken: string): Promise<ApiKeyRow | undefined>
}

// ----- Token format helpers -----

const TOKEN_PATTERN = /^epk_(pub|priv)_([0-9a-f]{10})_([0-9a-f]{32})$/

export interface ParsedToken {
  keyType: KeyType
  id: string
  secret: string
}

/** Parse a raw token string. Returns null for anything that doesn't match shape. */
export function parseToken(raw: string): ParsedToken | null {
  const m = TOKEN_PATTERN.exec(raw)
  if (!m) return null
  return { keyType: m[1] as KeyType, id: m[2]!, secret: m[3]! }
}

/**
 * Generate a fresh raw token + its component parts.
 *
 * Uses `crypto.getRandomValues` for the id + secret bytes. 10 hex chars of
 * id = 40 bits of identifier space (collision prob at 1M keys: ~10⁻⁷,
 * acceptable; we can extend later without breaking the parser). 32 hex
 * chars of secret = 128 bits of hash input entropy.
 */
export function generateRawToken(keyType: KeyType): { rawToken: string; id: string; secret: string } {
  const idBytes = new Uint8Array(5) // 5 bytes → 10 hex chars
  const secretBytes = new Uint8Array(16) // 16 bytes → 32 hex chars
  crypto.getRandomValues(idBytes)
  crypto.getRandomValues(secretBytes)
  const id = bytesToHex(idBytes)
  const secret = bytesToHex(secretBytes)
  return { rawToken: `epk_${keyType}_${id}_${secret}`, id, secret }
}

function bytesToHex(b: Uint8Array): string {
  let s = ""
  for (let i = 0; i < b.length; i++) {
    s += b[i]!.toString(16).padStart(2, "0")
  }
  return s
}

// ----- Secret hashing -----
//
// Bun's password API picks sensible argon2id defaults. We pin the algorithm
// name explicitly so a Bun minor bump can't silently switch us to bcrypt.

export async function hashSecret(secret: string): Promise<string> {
  return Bun.password.hash(secret, { algorithm: "argon2id" })
}

export async function verifySecret(secret: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(secret, hash)
  } catch {
    // Malformed stored hash — treat as no-match, don't crash the request.
    return false
  }
}

// ----- BOOTSTRAP_API_KEYS env parsing -----
//
// Shape:
//
//   BOOTSTRAP_API_KEYS = '{
//     "epk_priv_abc0123456_deadbeef...": { "orgId": "org_acme", "keyType": "priv", "name": "founder" },
//     "epk_pub_fedcba9876_cafebabe...":  { "orgId": "org_acme", "keyType": "pub",  "name": "demo-app" }
//   }'
//
// At boot each entry is fed to `store.seed(...)`. No-ops if already present.

export class BootstrapKeysConfigError extends Error {
  constructor(m: string) {
    super(m)
    this.name = "BootstrapKeysConfigError"
  }
}

export interface BootstrapEntry {
  rawToken: string
  orgId: string
  keyType: KeyType
  name: string
}

export function parseBootstrapKeys(raw: string | undefined): BootstrapEntry[] {
  if (!raw || raw.trim() === "") return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new BootstrapKeysConfigError(
      `BOOTSTRAP_API_KEYS is not valid JSON: ${(err as Error).message}`,
    )
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BootstrapKeysConfigError(
      "BOOTSTRAP_API_KEYS must be a JSON object of { rawToken: { orgId, keyType, name } }",
    )
  }
  const out: BootstrapEntry[] = []
  for (const [rawToken, val] of Object.entries(parsed as Record<string, unknown>)) {
    const parsedToken = parseToken(rawToken)
    if (!parsedToken) {
      throw new BootstrapKeysConfigError(
        `BOOTSTRAP_API_KEYS: token "${rawToken.slice(0, 16)}..." doesn't match epk_<type>_<id>_<secret> format`,
      )
    }
    if (typeof val !== "object" || val === null || Array.isArray(val)) {
      throw new BootstrapKeysConfigError(
        `BOOTSTRAP_API_KEYS: entry for "${rawToken.slice(0, 16)}..." must be an object`,
      )
    }
    const v = val as Record<string, unknown>
    if (typeof v.orgId !== "string" || !v.orgId) {
      throw new BootstrapKeysConfigError(
        `BOOTSTRAP_API_KEYS: entry needs "orgId": string`,
      )
    }
    if (v.keyType !== "pub" && v.keyType !== "priv") {
      throw new BootstrapKeysConfigError(
        `BOOTSTRAP_API_KEYS: entry needs "keyType": "pub" | "priv"`,
      )
    }
    if (v.keyType !== parsedToken.keyType) {
      throw new BootstrapKeysConfigError(
        `BOOTSTRAP_API_KEYS: keyType "${v.keyType}" disagrees with token prefix "${parsedToken.keyType}"`,
      )
    }
    const name = typeof v.name === "string" && v.name.length > 0 ? v.name : "bootstrap"
    out.push({ rawToken, orgId: v.orgId, keyType: parsedToken.keyType, name })
  }
  return out
}
