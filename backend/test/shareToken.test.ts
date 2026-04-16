import { describe, test, expect } from "bun:test"
import {
  HmacShareTokenSigner,
  InvalidShareTokenError,
  DEFAULT_SHARE_TTL_SECONDS,
  MAX_SHARE_TTL_SECONDS,
} from "../src/shareToken.ts"

/**
 * Signer unit tests. These prove the token format is forgery-proof and
 * expiry-enforcing independently of any HTTP code. If any of these regress,
 * every `/r/{token}` endpoint in every future service built on this module
 * silently breaks.
 */

const TEST_SECRET = "x".repeat(48) // 48 chars, well above the 32-char minimum
const OTHER_SECRET = "y".repeat(48)

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

describe("HmacShareTokenSigner", () => {
  test("rejects short secrets at construction", () => {
    expect(() => new HmacShareTokenSigner("")).toThrow()
    expect(() => new HmacShareTokenSigner("short")).toThrow()
    expect(() => new HmacShareTokenSigner("x".repeat(31))).toThrow()
    // 32 is the floor — should NOT throw.
    expect(() => new HmacShareTokenSigner("x".repeat(32))).not.toThrow()
  })

  test("sign() produces a two-part token separated by a dot", () => {
    const signer = new HmacShareTokenSigner(TEST_SECRET)
    const token = signer.sign({
      traceId: "trace_abc",
      orgId: "org_acme",
      expiresAt: nowSeconds() + 3600,
    })
    const parts = token.split(".")
    expect(parts.length).toBe(2)
    expect(parts[0].length).toBeGreaterThan(0)
    expect(parts[1].length).toBeGreaterThan(0)
  })

  test("sign → verify round-trip preserves payload exactly", () => {
    const signer = new HmacShareTokenSigner(TEST_SECRET)
    const payload = {
      traceId: "trace_abc",
      orgId: "org_acme",
      expiresAt: nowSeconds() + 3600,
    }
    const token = signer.sign(payload)
    const decoded = signer.verify(token)
    expect(decoded).toEqual(payload)
  })

  test("verify() rejects a tampered body with InvalidShareTokenError", () => {
    const signer = new HmacShareTokenSigner(TEST_SECRET)
    const token = signer.sign({
      traceId: "trace_abc",
      orgId: "org_acme",
      expiresAt: nowSeconds() + 3600,
    })
    const [, sig] = token.split(".")
    // Tamper: swap the body for one claiming a different traceId.
    const fakeBody = Buffer.from(
      JSON.stringify({ traceId: "trace_attacker_pick", orgId: "org_acme", expiresAt: nowSeconds() + 3600 }),
    ).toString("base64url")
    const forged = `${fakeBody}.${sig}`
    expect(() => signer.verify(forged)).toThrow(InvalidShareTokenError)
  })

  test("verify() rejects a tampered signature", () => {
    const signer = new HmacShareTokenSigner(TEST_SECRET)
    const token = signer.sign({
      traceId: "trace_abc",
      orgId: "org_acme",
      expiresAt: nowSeconds() + 3600,
    })
    const [body] = token.split(".")
    const fakeSig = Buffer.from("garbage-signature-bytes-here-32b").toString("base64url")
    const forged = `${body}.${fakeSig}`
    expect(() => signer.verify(forged)).toThrow(InvalidShareTokenError)
  })

  test("verify() rejects a token signed with a different secret", () => {
    const signerA = new HmacShareTokenSigner(TEST_SECRET)
    const signerB = new HmacShareTokenSigner(OTHER_SECRET)
    const token = signerA.sign({
      traceId: "trace_abc",
      orgId: "org_acme",
      expiresAt: nowSeconds() + 3600,
    })
    expect(() => signerB.verify(token)).toThrow(InvalidShareTokenError)
  })

  test("verify() rejects an expired token", () => {
    const signer = new HmacShareTokenSigner(TEST_SECRET)
    const expiredPayload = {
      traceId: "trace_abc",
      orgId: "org_acme",
      expiresAt: nowSeconds() - 1, // expired 1 second ago
    }
    const token = signer.sign(expiredPayload)
    expect(() => signer.verify(token)).toThrow(InvalidShareTokenError)
  })

  test("verify() accepts tokens whose `now` is injected (clock-skew friendly)", () => {
    const signer = new HmacShareTokenSigner(TEST_SECRET)
    const payload = {
      traceId: "trace_abc",
      orgId: "org_acme",
      expiresAt: 1_800_000_000, // far future
    }
    const token = signer.sign(payload)
    // Inject a "now" after the expiry — should fail.
    expect(() => signer.verify(token, 1_800_000_001)).toThrow(InvalidShareTokenError)
    // Inject a "now" right before — should pass.
    expect(signer.verify(token, 1_800_000_000)).toEqual(payload)
  })

  test("verify() rejects tokens with no dot, too many dots, or empty parts", () => {
    const signer = new HmacShareTokenSigner(TEST_SECRET)
    expect(() => signer.verify("")).toThrow(InvalidShareTokenError)
    expect(() => signer.verify("no-dot-here")).toThrow(InvalidShareTokenError)
    expect(() => signer.verify("too.many.dots")).toThrow(InvalidShareTokenError)
    expect(() => signer.verify(".sig-only")).toThrow(InvalidShareTokenError)
    expect(() => signer.verify("body-only.")).toThrow(InvalidShareTokenError)
  })

  test("verify() rejects payload missing required fields", () => {
    const signer = new HmacShareTokenSigner(TEST_SECRET)
    // Hand-build a validly-signed token with a malformed payload.
    const badBody = Buffer.from(JSON.stringify({ traceId: "only" })).toString("base64url")
    const crypto = require("node:crypto")
    const sig = crypto
      .createHmac("sha256", TEST_SECRET)
      .update(badBody)
      .digest()
      .toString("base64url")
    const token = `${badBody}.${sig}`
    expect(() => signer.verify(token)).toThrow(InvalidShareTokenError)
  })

  test("sign() refuses payloads missing fields", () => {
    const signer = new HmacShareTokenSigner(TEST_SECRET)
    expect(() => signer.sign({ traceId: "", orgId: "org", expiresAt: 1 })).toThrow()
    expect(() => signer.sign({ traceId: "t", orgId: "", expiresAt: 1 })).toThrow()
    // @ts-expect-error missing field
    expect(() => signer.sign({ traceId: "t", orgId: "o" })).toThrow()
  })

  test("exported constants are sane", () => {
    // 7 days < 30 days < one year. If these ever flip we've screwed up the TTL.
    expect(DEFAULT_SHARE_TTL_SECONDS).toBeLessThan(MAX_SHARE_TTL_SECONDS)
    expect(MAX_SHARE_TTL_SECONDS).toBeLessThan(60 * 60 * 24 * 365)
    expect(DEFAULT_SHARE_TTL_SECONDS).toBeGreaterThan(0)
  })
})
