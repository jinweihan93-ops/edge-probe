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
 * Process-local ApiKeyStore. Used by the in-memory test suite and by local
 * dev runs without Postgres.
 *
 * Not multi-process-safe. Two replicas sharing an in-memory store would
 * diverge; that's what PgApiKeyStore is for.
 */
export class InMemoryApiKeyStore implements ApiKeyStore {
  private rows = new Map<string, ApiKeyRow & { keyHash: string }>()

  async mint(orgId: string, keyType: KeyType, name: string): Promise<MintedKey> {
    const { rawToken, id, secret } = generateRawToken(keyType)
    const keyHash = await hashSecret(secret)
    const row: ApiKeyRow & { keyHash: string } = {
      id,
      orgId,
      keyType,
      name,
      createdAt: new Date().toISOString(),
      revokedAt: null,
      keyHash,
    }
    this.rows.set(id, row)
    return { row: this.toPublicRow(row), rawToken }
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
    const existing = this.rows.get(parsed.id)
    if (existing) return this.toPublicRow(existing)
    const keyHash = await hashSecret(parsed.secret)
    const row: ApiKeyRow & { keyHash: string } = {
      id: parsed.id,
      orgId,
      keyType,
      name,
      createdAt: new Date().toISOString(),
      revokedAt: null,
      keyHash,
    }
    this.rows.set(parsed.id, row)
    return this.toPublicRow(row)
  }

  async revoke(id: string): Promise<boolean> {
    const row = this.rows.get(id)
    if (!row || row.revokedAt) return false
    row.revokedAt = new Date().toISOString()
    return true
  }

  async list(orgId: string): Promise<ApiKeyRow[]> {
    const rows: ApiKeyRow[] = []
    for (const r of this.rows.values()) {
      if (r.orgId === orgId) rows.push(this.toPublicRow(r))
    }
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return rows
  }

  async verify(rawToken: string): Promise<ApiKeyRow | undefined> {
    const parsed = parseToken(rawToken)
    if (!parsed) return undefined
    const row = this.rows.get(parsed.id)
    if (!row) return undefined
    if (row.revokedAt) return undefined
    if (row.keyType !== parsed.keyType) return undefined
    const ok = await verifySecret(parsed.secret, row.keyHash)
    if (!ok) return undefined
    return this.toPublicRow(row)
  }

  /** For tests that need to clear state between runs. */
  reset(): void {
    this.rows.clear()
  }

  private toPublicRow(row: ApiKeyRow & { keyHash: string }): ApiKeyRow {
    const { keyHash: _keyHash, ...pub } = row
    void _keyHash
    return { ...pub }
  }
}
