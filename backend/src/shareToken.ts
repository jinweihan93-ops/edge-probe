/**
 * Share-token signer for public `/r/{token}` URLs.
 *
 * Before this module existed, `/r/{traceId}` treated the path as the trace id,
 * which meant anyone who guessed a trace id could read the public view of it.
 * That is share-by-obscurity, not actual sharing. The product promise is:
 * the user explicitly opts into sharing a specific trace, the backend mints
 * a signed URL, and only that URL works. Anyone else guessing the trace id
 * gets a 404.
 *
 * Format:   <base64url(payload)>.<base64url(hmac-sha256(payload, secret))>
 *
 * - `payload` is `{ traceId, orgId, expiresAt }` JSON.
 * - `expiresAt` is Unix seconds.
 * - Default TTL is 7 days, cap is 30 days. Longer and we should rotate secrets.
 *
 * Why HMAC not JWT:
 * - JWT libraries have a long history of bugs (alg=none, key confusion). A
 *   15-line HMAC scheme has a smaller surface and is easier to audit.
 * - We don't need any JWT feature (claims, issuer, nested keys, JWKs).
 *
 * Why sign client-side-visible data at all:
 * - The token must be forgery-proof. A user who knows their own trace id must
 *   not be able to mint a token for someone else's trace id. HMAC over the
 *   payload achieves that with a single server-side secret.
 *
 * Why store `orgId` in the payload (not just `traceId`):
 * - Defense in depth. If someone re-owns a trace id (rowid collision, DB
 *   restore, whatever) the share link is still pinned to the original org.
 *   `/r/{token}` re-checks `trace.orgId === payload.orgId` after decode.
 */

import { createHmac, timingSafeEqual } from "node:crypto"

export interface ShareTokenPayload {
  traceId: string
  orgId: string
  /** Unix seconds. */
  expiresAt: number
}

export interface ShareTokenSigner {
  sign(payload: ShareTokenPayload): string
  /** Throws on any failure. Callers should translate to 404. */
  verify(token: string, now?: number): ShareTokenPayload
}

/** Thrown from `verify()` on tampering, expiry, or malformed input. */
export class InvalidShareTokenError extends Error {
  constructor(reason: string) {
    super(`invalid share token: ${reason}`)
    this.name = "InvalidShareTokenError"
  }
}

/** Minimum secret length. Short secrets are brute-forceable. */
const MIN_SECRET_LEN = 32
/** 7 days. */
export const DEFAULT_SHARE_TTL_SECONDS = 60 * 60 * 24 * 7
/** 30 days. */
export const MAX_SHARE_TTL_SECONDS = 60 * 60 * 24 * 30

export class HmacShareTokenSigner implements ShareTokenSigner {
  constructor(private readonly secret: string) {
    if (!secret || secret.length < MIN_SECRET_LEN) {
      throw new Error(
        `SHARE_TOKEN_SECRET must be at least ${MIN_SECRET_LEN} characters (got ${secret?.length ?? 0})`,
      )
    }
  }

  sign(payload: ShareTokenPayload): string {
    if (!payload.traceId || !payload.orgId || typeof payload.expiresAt !== "number") {
      throw new Error("sign(): payload must have traceId, orgId, expiresAt")
    }
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
    const sig = createHmac("sha256", this.secret).update(body).digest().toString("base64url")
    return `${body}.${sig}`
  }

  verify(token: string, now: number = Math.floor(Date.now() / 1000)): ShareTokenPayload {
    if (typeof token !== "string" || token.length === 0) {
      throw new InvalidShareTokenError("empty")
    }
    const parts = token.split(".")
    if (parts.length !== 2) {
      throw new InvalidShareTokenError("malformed: expected <body>.<sig>")
    }
    const [body, sigB64] = parts
    if (!body || !sigB64) {
      throw new InvalidShareTokenError("malformed: empty body or signature")
    }

    // Constant-time signature check to avoid timing oracle.
    const expected = createHmac("sha256", this.secret).update(body).digest()
    let actual: Buffer
    try {
      actual = Buffer.from(sigB64, "base64url")
    } catch {
      throw new InvalidShareTokenError("malformed signature encoding")
    }
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new InvalidShareTokenError("bad signature")
    }

    let payload: unknown
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"))
    } catch {
      throw new InvalidShareTokenError("malformed payload")
    }
    if (!isShareTokenPayload(payload)) {
      throw new InvalidShareTokenError("payload missing required fields")
    }
    if (payload.expiresAt < now) {
      throw new InvalidShareTokenError("expired")
    }
    return payload
  }
}

function isShareTokenPayload(v: unknown): v is ShareTokenPayload {
  if (!v || typeof v !== "object") return false
  const o = v as Record<string, unknown>
  return (
    typeof o.traceId === "string" &&
    typeof o.orgId === "string" &&
    typeof o.expiresAt === "number" &&
    Number.isFinite(o.expiresAt)
  )
}
