import { describe, test, expect, beforeEach } from "bun:test"
import {
  generateRawToken,
  parseToken,
  hashSecret,
  verifySecret,
  parseBootstrapKeys,
  BootstrapKeysConfigError,
} from "../src/apiKeys.ts"
import { InMemoryApiKeyStore } from "../src/inMemoryApiKeyStore.ts"

/**
 * Unit tests for the apiKeys core module and the in-memory store.
 *
 * The token-format tests are the load-bearing half: if `parseToken` gets
 * loose, /ingest will happily authenticate garbage; if `generateRawToken`
 * drifts, shipped SDKs will mint keys the server rejects. Exercise both
 * shapes explicitly.
 */

describe("parseToken", () => {
  test("accepts a well-formed pub token", () => {
    const raw = "epk_pub_0123456789_abcdef0123456789abcdef0123456789"
    const parsed = parseToken(raw)
    expect(parsed).not.toBeNull()
    expect(parsed!.keyType).toBe("pub")
    expect(parsed!.id).toBe("0123456789")
    expect(parsed!.secret).toBe("abcdef0123456789abcdef0123456789")
  })

  test("accepts a well-formed priv token", () => {
    const raw = "epk_priv_deadbeef00_cafebabecafebabecafebabecafebabe"
    const parsed = parseToken(raw)
    expect(parsed).not.toBeNull()
    expect(parsed!.keyType).toBe("priv")
    expect(parsed!.id).toBe("deadbeef00")
    expect(parsed!.secret).toBe("cafebabecafebabecafebabecafebabe")
  })

  test("rejects unknown prefix", () => {
    expect(parseToken("epk_dash_0123456789_abcdef0123456789abcdef0123456789")).toBeNull()
    expect(parseToken("xxx_pub_0123456789_abcdef0123456789abcdef0123456789")).toBeNull()
  })

  test("rejects wrong id length", () => {
    expect(parseToken("epk_pub_01_abcdef0123456789abcdef0123456789")).toBeNull()
    expect(parseToken("epk_pub_0123456789aa_abcdef0123456789abcdef0123456789")).toBeNull()
  })

  test("rejects wrong secret length", () => {
    expect(parseToken("epk_pub_0123456789_abcd")).toBeNull()
    expect(parseToken("epk_pub_0123456789_abcdef0123456789abcdef0123456789aa")).toBeNull()
  })

  test("rejects non-hex chars", () => {
    expect(parseToken("epk_pub_0123456Xyz_abcdef0123456789abcdef0123456789")).toBeNull()
    expect(parseToken("epk_pub_0123456789_ZZZZef0123456789abcdef0123456789")).toBeNull()
  })

  test("rejects capital-letter hex (we standardize on lowercase)", () => {
    expect(parseToken("epk_pub_0123456789_ABCDEF0123456789ABCDEF0123456789")).toBeNull()
  })

  test("rejects empty / whitespace / stray-prefix garbage", () => {
    expect(parseToken("")).toBeNull()
    expect(parseToken("   ")).toBeNull()
    expect(parseToken("epk_pub_")).toBeNull()
    expect(parseToken("Bearer epk_pub_0123456789_abcdef0123456789abcdef0123456789")).toBeNull()
  })
})

describe("generateRawToken", () => {
  test("mints tokens that round-trip through parseToken", () => {
    for (const t of ["pub", "priv"] as const) {
      const { rawToken, id, secret } = generateRawToken(t)
      const parsed = parseToken(rawToken)
      expect(parsed).not.toBeNull()
      expect(parsed!.keyType).toBe(t)
      expect(parsed!.id).toBe(id)
      expect(parsed!.secret).toBe(secret)
      // Id is 10 hex chars, secret 32 hex chars.
      expect(id).toMatch(/^[0-9a-f]{10}$/)
      expect(secret).toMatch(/^[0-9a-f]{32}$/)
    }
  })

  test("mints distinct tokens each time", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const { rawToken } = generateRawToken("pub")
      expect(seen.has(rawToken)).toBe(false)
      seen.add(rawToken)
    }
  })
})

describe("hashSecret / verifySecret", () => {
  test("verify returns true for the right secret, false otherwise", async () => {
    const secret = "abcdef0123456789abcdef0123456789"
    const hash = await hashSecret(secret)
    expect(hash.startsWith("$argon2id$")).toBe(true)
    expect(await verifySecret(secret, hash)).toBe(true)
    expect(await verifySecret("00000000000000000000000000000000", hash)).toBe(false)
  })

  test("verify returns false — does not throw — on malformed hash", async () => {
    expect(await verifySecret("anything", "not-a-hash")).toBe(false)
    expect(await verifySecret("anything", "")).toBe(false)
  })
})

describe("InMemoryApiKeyStore", () => {
  let store: InMemoryApiKeyStore

  beforeEach(() => {
    store = new InMemoryApiKeyStore()
  })

  test("mint → verify returns the same row", async () => {
    const minted = await store.mint("org_acme", "pub", "demo-app")
    expect(minted.rawToken.startsWith("epk_pub_")).toBe(true)
    expect(minted.row.orgId).toBe("org_acme")
    expect(minted.row.keyType).toBe("pub")
    expect(minted.row.name).toBe("demo-app")
    expect(minted.row.revokedAt).toBeNull()

    const verified = await store.verify(minted.rawToken)
    expect(verified).not.toBeUndefined()
    expect(verified!.id).toBe(minted.row.id)
    expect(verified!.orgId).toBe("org_acme")
  })

  test("verify returns undefined for garbage tokens (never throws)", async () => {
    expect(await store.verify("")).toBeUndefined()
    expect(await store.verify("Bearer foo")).toBeUndefined()
    expect(await store.verify("epk_pub_0000000000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBeUndefined()
  })

  test("verify rejects a token with a valid id but tampered secret", async () => {
    const { rawToken } = await store.mint("org_acme", "pub", "demo")
    // Flip one char in the secret half.
    const parts = rawToken.split("_")
    const secret = parts[3]!
    const tampered = `${parts[0]}_${parts[1]}_${parts[2]}_${(secret.startsWith("a") ? "b" : "a") + secret.slice(1)}`
    expect(await store.verify(tampered)).toBeUndefined()
  })

  test("verify rejects after revoke", async () => {
    const { rawToken, row } = await store.mint("org_acme", "pub", "demo")
    expect(await store.verify(rawToken)).not.toBeUndefined()
    const revoked = await store.revoke(row.id)
    expect(revoked).toBe(true)
    expect(await store.verify(rawToken)).toBeUndefined()
    // Second revoke is a no-op (idempotent).
    expect(await store.revoke(row.id)).toBe(false)
  })

  test("verify rejects a token whose prefix disagrees with the stored row", async () => {
    // If for some reason the client presents epk_priv_<pub-id>_<pub-secret>,
    // reject it — we never let a pub row authorize priv calls by re-labeling.
    const { rawToken } = await store.mint("org_acme", "pub", "demo")
    const mismatched = rawToken.replace(/^epk_pub_/, "epk_priv_")
    expect(await store.verify(mismatched)).toBeUndefined()
  })

  test("list returns metadata (no keyHash), newest-first, scoped to org", async () => {
    const a = await store.mint("org_a", "pub", "first")
    // Small delay so the second row has a strictly later timestamp even on
    // fast clocks — we don't want a flaky "two mints in same ms, equal sort"
    await new Promise((r) => setTimeout(r, 5))
    const b = await store.mint("org_a", "priv", "second")
    await store.mint("org_b", "pub", "other-org")

    const rows = await store.list("org_a")
    expect(rows.length).toBe(2)
    expect(rows[0]!.id).toBe(b.row.id)
    expect(rows[1]!.id).toBe(a.row.id)
    // Metadata only — never keyHash.
    for (const row of rows) {
      expect(row).not.toHaveProperty("keyHash")
    }
    expect(await store.list("org_missing")).toEqual([])
  })

  test("seed is idempotent on same id (second call returns the first row unchanged)", async () => {
    const { rawToken } = generateRawToken("priv")
    const first = await store.seed(rawToken, "org_acme", "priv", "bootstrap")
    const second = await store.seed(rawToken, "org_acme", "priv", "other-name")
    expect(second.id).toBe(first.id)
    expect(second.name).toBe("bootstrap") // not overwritten
  })

  test("seed rejects mismatched raw-token vs keyType", async () => {
    const { rawToken } = generateRawToken("pub")
    await expect(store.seed(rawToken, "org_acme", "priv", "wrong")).rejects.toThrow()
  })
})

describe("parseBootstrapKeys", () => {
  test("empty / unset → []", () => {
    expect(parseBootstrapKeys(undefined)).toEqual([])
    expect(parseBootstrapKeys("")).toEqual([])
    expect(parseBootstrapKeys("   ")).toEqual([])
  })

  test("valid JSON object → entries", () => {
    const { rawToken: privToken } = generateRawToken("priv")
    const { rawToken: pubToken } = generateRawToken("pub")
    const raw = JSON.stringify({
      [privToken]: { orgId: "org_acme", keyType: "priv", name: "founder" },
      [pubToken]: { orgId: "org_acme", keyType: "pub", name: "demo-app" },
    })
    const entries = parseBootstrapKeys(raw)
    expect(entries.length).toBe(2)
    const byType = new Map(entries.map((e) => [e.keyType, e]))
    expect(byType.get("priv")!.orgId).toBe("org_acme")
    expect(byType.get("priv")!.rawToken).toBe(privToken)
    expect(byType.get("pub")!.name).toBe("demo-app")
  })

  test("rejects non-object JSON", () => {
    expect(() => parseBootstrapKeys("[]")).toThrow(BootstrapKeysConfigError)
    expect(() => parseBootstrapKeys("null")).toThrow(BootstrapKeysConfigError)
    expect(() => parseBootstrapKeys('"string"')).toThrow(BootstrapKeysConfigError)
  })

  test("rejects malformed JSON", () => {
    expect(() => parseBootstrapKeys("{")).toThrow(BootstrapKeysConfigError)
  })

  test("rejects token that doesn't match epk_<type>_<id>_<secret> shape", () => {
    expect(() =>
      parseBootstrapKeys(
        JSON.stringify({ "not_a_token": { orgId: "x", keyType: "pub", name: "n" } }),
      ),
    ).toThrow(BootstrapKeysConfigError)
  })

  test("rejects keyType that disagrees with token prefix", () => {
    const { rawToken } = generateRawToken("pub")
    expect(() =>
      parseBootstrapKeys(
        JSON.stringify({ [rawToken]: { orgId: "org_acme", keyType: "priv", name: "x" } }),
      ),
    ).toThrow(BootstrapKeysConfigError)
  })

  test("rejects missing orgId / keyType", () => {
    const { rawToken } = generateRawToken("pub")
    expect(() =>
      parseBootstrapKeys(JSON.stringify({ [rawToken]: { keyType: "pub", name: "x" } })),
    ).toThrow(BootstrapKeysConfigError)
    expect(() =>
      parseBootstrapKeys(JSON.stringify({ [rawToken]: { orgId: "org_acme", name: "x" } })),
    ).toThrow(BootstrapKeysConfigError)
  })

  test("default name 'bootstrap' when name absent", () => {
    const { rawToken } = generateRawToken("pub")
    const entries = parseBootstrapKeys(
      JSON.stringify({ [rawToken]: { orgId: "org_acme", keyType: "pub" } }),
    )
    expect(entries[0]!.name).toBe("bootstrap")
  })
})
