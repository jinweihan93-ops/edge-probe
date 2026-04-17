import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test"
import { createSQL, type Sql } from "../src/db.ts"
import { runMigrations } from "../src/migrate.ts"
import { PgApiKeyStore } from "../src/pgApiKeyStore.ts"
import { generateRawToken, parseToken } from "../src/apiKeys.ts"

/**
 * Roundtrip tests for the Pg-backed ApiKeyStore. Gated on TEST_DATABASE_URL
 * for the same reason as pgSpanStore.test.ts — default `bun test` on a
 * machine without Postgres must stay green. CI with compose brings this in.
 *
 * We prove three things here that the in-memory store can't:
 *   1. Cross-replica atomicity: two concurrent mints produce two rows.
 *   2. revoked_at round-trips as ISO8601 — timestamptz doesn't lose precision
 *      across TS ↔ Pg.
 *   3. verify() correctly re-reads the row each time, so revoke on replica A
 *      is seen by replica B (as long as both hit the same DB — and they do).
 */

const TEST_DB_URL = process.env.TEST_DATABASE_URL
const describePg = TEST_DB_URL ? describe : describe.skip

describePg("PgApiKeyStore roundtrip (TEST_DATABASE_URL)", () => {
  let sql: Sql
  let store: PgApiKeyStore

  beforeAll(async () => {
    sql = createSQL(TEST_DB_URL!)
    await runMigrations(sql)
    store = new PgApiKeyStore(sql)
  })

  afterAll(async () => {
    await sql.end()
  })

  beforeEach(async () => {
    // Clean up api_keys + orgs so each test starts deterministic. `_migrations`
    // stays intact. FK cascade means deleting orgs clears api_keys too, but
    // we order explicitly for clarity.
    await sql`TRUNCATE TABLE api_keys, orgs RESTART IDENTITY CASCADE`
  })

  test("mint → verify → list round-trips through Pg", async () => {
    const { rawToken, row } = await store.mint("org_acme", "pub", "demo")
    expect(row.orgId).toBe("org_acme")
    expect(row.keyType).toBe("pub")
    expect(row.revokedAt).toBeNull()

    // Shape check on the token.
    const parsed = parseToken(rawToken)
    expect(parsed).not.toBeNull()
    expect(parsed!.keyType).toBe("pub")

    // verify() returns the same row.
    const verified = await store.verify(rawToken)
    expect(verified).not.toBeUndefined()
    expect(verified!.id).toBe(row.id)
    expect(verified!.orgId).toBe("org_acme")

    // list() is scoped to the org, newest first.
    const second = await store.mint("org_acme", "priv", "second")
    const rows = await store.list("org_acme")
    expect(rows.length).toBe(2)
    expect(rows[0]!.id).toBe(second.row.id) // newest first
    expect(rows[1]!.id).toBe(row.id)

    // Other orgs are isolated.
    await store.mint("org_other", "pub", "other")
    const acme = await store.list("org_acme")
    expect(acme.length).toBe(2)
    const other = await store.list("org_other")
    expect(other.length).toBe(1)
  })

  test("revoke sets revoked_at; subsequent verify returns undefined", async () => {
    const { rawToken, row } = await store.mint("org_acme", "pub", "demo")
    expect(await store.verify(rawToken)).not.toBeUndefined()
    expect(await store.revoke(row.id)).toBe(true)
    expect(await store.verify(rawToken)).toBeUndefined()
    // Second revoke is a no-op (the WHERE revoked_at IS NULL guard).
    expect(await store.revoke(row.id)).toBe(false)

    // But the row still shows up in list() with revokedAt populated.
    const rows = await store.list("org_acme")
    expect(rows.length).toBe(1)
    expect(rows[0]!.revokedAt).not.toBeNull()
    // And the ISO shape round-trips cleanly.
    expect(rows[0]!.revokedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  test("seed is idempotent against a pre-existing id", async () => {
    const { rawToken } = generateRawToken("priv")
    const first = await store.seed(rawToken, "org_acme", "priv", "bootstrap")
    const second = await store.seed(rawToken, "org_acme", "priv", "different-name")
    expect(second.id).toBe(first.id)
    // Second call must not overwrite metadata.
    expect(second.name).toBe("bootstrap")
    // List confirms exactly one row.
    expect((await store.list("org_acme")).length).toBe(1)
  })

  test("verify rejects wrong-prefix tokens (pub/priv mismatch)", async () => {
    const { rawToken } = await store.mint("org_acme", "pub", "demo")
    const wrong = rawToken.replace(/^epk_pub_/, "epk_priv_")
    expect(await store.verify(wrong)).toBeUndefined()
  })

  test("verify rejects tampered-secret tokens even with a valid id", async () => {
    const { rawToken } = await store.mint("org_acme", "pub", "demo")
    // Replace last char of secret.
    const flipped = rawToken.slice(0, -1) + (rawToken.endsWith("a") ? "b" : "a")
    expect(await store.verify(flipped)).toBeUndefined()
  })
})
