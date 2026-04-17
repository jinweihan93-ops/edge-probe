import type { Sql } from "./db.ts"
import {
  type ApiKeyRow,
  type ApiKeyStore,
  type KeyType,
  type MintedKey,
  generateRawToken,
  hashSecret,
  parseToken,
  verifySecret,
} from "./apiKeys.ts"

/**
 * Postgres-backed ApiKeyStore using the `api_keys` table from migration 001.
 *
 * Schema reminders:
 *   id         TEXT PRIMARY KEY           — the 10-hex short id
 *   org_id     TEXT FK → orgs(id)
 *   key_hash   TEXT                        — argon2id(secret)
 *   key_prefix TEXT                        — 'epk_pub_' or 'epk_priv_'
 *   name       TEXT
 *   created_at TIMESTAMPTZ DEFAULT now()
 *   revoked_at TIMESTAMPTZ
 *
 * Like PgSpanStore, this auto-upserts the org row so we never hit an FK error
 * for a new org on first mint. When a proper org-management surface lands,
 * we tighten this.
 */
export class PgApiKeyStore implements ApiKeyStore {
  constructor(private readonly sql: Sql) {}

  async mint(orgId: string, keyType: KeyType, name: string): Promise<MintedKey> {
    const { rawToken, id, secret } = generateRawToken(keyType)
    const keyHash = await hashSecret(secret)
    await this.upsertOrg(orgId)
    const prefix = `epk_${keyType}_`
    const rows = await this.sql<Array<ApiKeyDbRow>>`
      INSERT INTO api_keys (id, org_id, key_hash, key_prefix, name)
      VALUES (${id}, ${orgId}, ${keyHash}, ${prefix}, ${name})
      RETURNING id, org_id, key_hash, key_prefix, name, created_at, revoked_at
    `
    return { row: toApiKeyRow(rows[0]!), rawToken }
  }

  async seed(
    rawToken: string,
    orgId: string,
    keyType: KeyType,
    name: string,
  ): Promise<ApiKeyRow> {
    const parsed = parseToken(rawToken)
    if (!parsed || parsed.keyType !== keyType) {
      throw new Error(`seed: raw token does not parse as ${keyType} key`)
    }
    // Existing row? No-op-ish return.
    const existing = await this.sql<Array<ApiKeyDbRow>>`
      SELECT id, org_id, key_hash, key_prefix, name, created_at, revoked_at
      FROM api_keys WHERE id = ${parsed.id}
    `
    if (existing.length > 0) return toApiKeyRow(existing[0]!)
    const keyHash = await hashSecret(parsed.secret)
    await this.upsertOrg(orgId)
    const prefix = `epk_${keyType}_`
    const rows = await this.sql<Array<ApiKeyDbRow>>`
      INSERT INTO api_keys (id, org_id, key_hash, key_prefix, name)
      VALUES (${parsed.id}, ${orgId}, ${keyHash}, ${prefix}, ${name})
      RETURNING id, org_id, key_hash, key_prefix, name, created_at, revoked_at
    `
    return toApiKeyRow(rows[0]!)
  }

  async revoke(id: string): Promise<boolean> {
    const rows = await this.sql<Array<{ id: string }>>`
      UPDATE api_keys
      SET revoked_at = now()
      WHERE id = ${id} AND revoked_at IS NULL
      RETURNING id
    `
    return rows.length > 0
  }

  async list(orgId: string): Promise<ApiKeyRow[]> {
    const rows = await this.sql<Array<ApiKeyDbRow>>`
      SELECT id, org_id, key_hash, key_prefix, name, created_at, revoked_at
      FROM api_keys
      WHERE org_id = ${orgId}
      ORDER BY created_at DESC
    `
    return rows.map(toApiKeyRow)
  }

  async verify(rawToken: string): Promise<ApiKeyRow | undefined> {
    const parsed = parseToken(rawToken)
    if (!parsed) return undefined
    const rows = await this.sql<Array<ApiKeyDbRow>>`
      SELECT id, org_id, key_hash, key_prefix, name, created_at, revoked_at
      FROM api_keys
      WHERE id = ${parsed.id}
    `
    if (rows.length === 0) return undefined
    const row = rows[0]!
    if (row.revoked_at) return undefined
    const prefix = `epk_${parsed.keyType}_`
    if (row.key_prefix !== prefix) return undefined
    const ok = await verifySecret(parsed.secret, row.key_hash)
    if (!ok) return undefined
    return toApiKeyRow(row)
  }

  private async upsertOrg(orgId: string): Promise<void> {
    await this.sql`
      INSERT INTO orgs (id, name) VALUES (${orgId}, ${orgId})
      ON CONFLICT (id) DO NOTHING
    `
  }
}

interface ApiKeyDbRow {
  id: string
  org_id: string
  key_hash: string
  key_prefix: string
  name: string
  created_at: Date | string
  revoked_at: Date | string | null
}

function toApiKeyRow(r: ApiKeyDbRow): ApiKeyRow {
  const keyType: KeyType = r.key_prefix === "epk_pub_" ? "pub" : "priv"
  return {
    id: r.id,
    orgId: r.org_id,
    keyType,
    name: r.name,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    revokedAt:
      r.revoked_at === null
        ? null
        : r.revoked_at instanceof Date
          ? r.revoked_at.toISOString()
          : r.revoked_at,
  }
}
