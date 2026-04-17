/**
 * Content-hash + minute-bucket helpers for /ingest dedup.
 *
 * Strategy: hash the raw body bytes (no canonicalization). The SDK emits
 * stable JSON for a given run, and the whole point of dedup is to catch
 * exact retries — a client that mutates the payload (even whitespace) gets
 * through, which is fine because it's no longer "the same ingest".
 *
 * The bucket is one minute wide: (orgId, contentHash, minuteBucket) UNIQUE.
 * A determined attacker who wants to blow through the dedup still has to
 * wait a minute between identical payloads. Real retry storms finish in
 * seconds, so 60s of coverage is plenty.
 */

/**
 * SHA-256 hex of the raw bytes. Bun ships CryptoHasher — no crypto import.
 */
export function contentHash(bytes: Uint8Array): string {
  const h = new Bun.CryptoHasher("sha256")
  h.update(bytes)
  return h.digest("hex")
}

/**
 * ISO-8601 string floored to the minute, in UTC.
 * e.g. `2026-04-17T12:34:56.789Z` → `2026-04-17T12:34:00.000Z`
 *
 * We use the UTC minute start as the canonical bucket so replicas on
 * different TZs land on the same key. ISO for readability; dedupe keys
 * turn up in error logs and dashboards.
 */
export function minuteBucket(now: Date = new Date()): string {
  const d = new Date(now.getTime())
  d.setUTCSeconds(0, 0)
  return d.toISOString()
}
