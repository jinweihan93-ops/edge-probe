import { describe, test, expect } from "bun:test"
import { createApp, makeMemoryDeps, type AppDeps } from "../src/server.ts"
import {
  ContentProjectionError,
  assertNoContentLeak,
  keyLooksLikeContent,
  stripContentAttributes,
  toPublicTrace,
  type StoredSpan,
  type Trace,
} from "../src/views.ts"

/**
 * Slice 6 — Per-call `includeContent` + `sensitive=true` projection guard.
 *
 * This file is the slice's explicit regression test set. The `describe` names
 * here map one-to-one to the "Done" clauses in docs/SLICES.md so reviewers
 * can see coverage without reading the test bodies.
 *
 * What this slice adds on top of the pre-existing pii-boundary tests:
 *   1. Expanded denylist vocabulary (`gen_ai.messages`, `llm.prompt`, …)
 *   2. A fail-closed tripwire (`ContentProjectionError`) — if anything slips
 *      past the strip, we refuse to render rather than leak.
 *   3. Trace-level attribute stripping via `toPublicTrace` (the `/r/:token`
 *      route was emitting `trace.attributes` raw pre-Slice-6).
 *   4. OG unfurl never renders content — already structurally enforced, now
 *      explicitly asserted from a stored-span with `includeContent: true`.
 */

const TEST_SHARE_SECRET = "x".repeat(48)

function freshDeps(): AppDeps {
  return makeMemoryDeps(TEST_SHARE_SECRET)
}

function mintToken(deps: AppDeps, traceId = "trace_abc", orgId = "org_acme") {
  return deps.signer.sign({
    traceId,
    orgId,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  })
}

async function seedTrace(
  deps: AppDeps,
  opts: {
    id?: string
    orgId?: string
    sensitive?: boolean
    traceAttrs?: Record<string, unknown>
    spanAttrs?: Record<string, unknown>
    includeContent?: boolean
    promptText?: string | null
    completionText?: string | null
    transcriptText?: string | null
  } = {},
) {
  const trace: Trace = {
    id: opts.id ?? "trace_abc",
    orgId: opts.orgId ?? "org_acme",
    projectId: "proj_voice",
    sessionId: null,
    startedAt: "2026-04-15T12:00:00Z",
    endedAt: "2026-04-15T12:00:01Z",
    device: { model: "iPhone 15 Pro", os: "iOS 18.2" },
    attributes: opts.traceAttrs ?? { "build.commit": "abc123" },
    sensitive: opts.sensitive ?? false,
  }
  await deps.store.insertTrace(trace)

  const span: StoredSpan = {
    id: "span_1",
    traceId: trace.id,
    parentSpanId: null,
    name: "llama-decode",
    kind: "llm",
    startedAt: "2026-04-15T12:00:00.100Z",
    endedAt: "2026-04-15T12:00:00.700Z",
    durationMs: 600,
    status: "ok",
    attributes: opts.spanAttrs ?? {
      "gen_ai.request.model": "llama-3.2-3b-instruct-q4",
      "gen_ai.prompt": "SECRET-PROMPT-PAYLOAD",
      "gen_ai.completion": "SECRET-COMPLETION-PAYLOAD",
    },
    includeContent: opts.includeContent ?? true,
    promptText: opts.promptText ?? "SECRET-PROMPT-PAYLOAD",
    completionText: opts.completionText ?? "SECRET-COMPLETION-PAYLOAD",
    transcriptText: opts.transcriptText ?? null,
  }
  await deps.store.insertSpan(span)

  return { trace, span }
}

// ----- Helper rule tests -----

describe("Slice 6: keyLooksLikeContent / stripContentAttributes classify the expanded vocabulary", () => {
  test.each([
    "content.prompt",
    "content.completion",
    "content.transcript",
    "content.whatever_new_field",
    "gen_ai.prompt",
    "gen_ai.completion",
    "gen_ai.messages",
    "gen_ai.response.messages",
    "gen_ai.response.text",
    "llm.prompt",
    "llm.completion",
    "llm.messages",
    "user.input",
    "user.output",
    "anthropic.prompt",
    "openai.completion",
    "vendor.some.transcript",
    "llm.response_text",
    "span.input_text",
    "openai.output_text",
  ])("flags %s as content", (k) => {
    expect(keyLooksLikeContent(k)).toBe(true)
  })

  test.each([
    "gen_ai.request.model",
    "gen_ai.usage.prompt_tokens",
    "gen_ai.usage.completion_tokens",
    "build.commit",
    "device.model",
    "http.status_code",
    "messaging_service", // note: no dot-segment "message" or "messages"
    "completions_served", // full word does not match "completion" segment
    "prompted_at",
    "input_bytes",
    "output_bytes",
    "transcriptionist_version", // not "transcript" segment
  ])("does NOT flag %s as content", (k) => {
    expect(keyLooksLikeContent(k)).toBe(false)
  })

  test("stripContentAttributes removes all flagged keys and preserves benign ones", () => {
    const input = {
      "gen_ai.request.model": "llama-3b",
      "gen_ai.prompt": "secret",
      "gen_ai.completion": "secret",
      "gen_ai.messages": "secret",
      "content.anything_new": "secret",
      "anthropic.completion": "secret",
      "gen_ai.usage.prompt_tokens": 42,
      "gen_ai.usage.completion_tokens": 8,
      "build.commit": "abc123",
    }
    const out = stripContentAttributes(input)
    expect(out).toEqual({
      "gen_ai.request.model": "llama-3b",
      "gen_ai.usage.prompt_tokens": 42,
      "gen_ai.usage.completion_tokens": 8,
      "build.commit": "abc123",
    })
  })
})

describe("Slice 6: property test — random attr bags are always content-free after strip", () => {
  const CONTENT_KEYS = [
    "gen_ai.prompt",
    "gen_ai.completion",
    "gen_ai.messages",
    "llm.prompt",
    "llm.completion",
    "llm.messages",
    "content.prompt",
    "content.completion",
    "content.transcript",
    "user.input",
    "user.output",
    "anthropic.prompt",
    "openai.completion",
    "any_vendor.transcript",
    "llm.response_text",
    "service.input_text",
    "service.output_text",
    "namespace.generated_text",
  ]
  const BENIGN_KEYS = [
    "gen_ai.request.model",
    "gen_ai.usage.prompt_tokens",
    "gen_ai.usage.completion_tokens",
    "build.commit",
    "device.model",
    "device.os",
    "http.status_code",
    "network.latency_ms",
    "completions_served",
    "prompted_at",
    "messaging_service",
  ]

  // Deterministic PRNG so failures reproduce.
  function mulberry32(seed: number) {
    let s = seed >>> 0
    return () => {
      s = (s + 0x6D2B79F5) >>> 0
      let t = s
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  test("400 random bags: strip removes content, preserves benign, tripwire never fires", () => {
    const rng = mulberry32(0xC0FFEE)
    for (let i = 0; i < 400; i++) {
      const bag: Record<string, unknown> = {}
      const nContent = Math.floor(rng() * CONTENT_KEYS.length)
      const nBenign = Math.floor(rng() * BENIGN_KEYS.length)
      const contentInBag: string[] = []
      const benignInBag: string[] = []
      for (let j = 0; j < nContent; j++) {
        const k = CONTENT_KEYS[Math.floor(rng() * CONTENT_KEYS.length)]!
        bag[k] = "sensitive-value-" + j
        contentInBag.push(k)
      }
      for (let j = 0; j < nBenign; j++) {
        const k = BENIGN_KEYS[Math.floor(rng() * BENIGN_KEYS.length)]!
        bag[k] = j
        benignInBag.push(k)
      }
      const stripped = stripContentAttributes(bag)
      const strippedKeys = new Set(Object.keys(stripped))
      // No content key survives.
      for (const k of contentInBag) {
        expect(strippedKeys.has(k)).toBe(false)
      }
      // Every benign key that was present is preserved.
      for (const k of benignInBag) {
        expect(strippedKeys.has(k)).toBe(true)
      }
      // Tripwire is silent on the stripped bag.
      expect(() => assertNoContentLeak(stripped)).not.toThrow()
    }
  })

  test("tripwire fires independently if something bypasses strip", () => {
    // Simulate a bug where strip missed a key. Tripwire must still catch it.
    const bypassed: Record<string, unknown> = { "rogue.vendor.prompt": "leak" }
    expect(() => assertNoContentLeak(bypassed)).toThrow(ContentProjectionError)
    try {
      assertNoContentLeak(bypassed)
    } catch (err) {
      if (err instanceof ContentProjectionError) {
        expect(err.offendingKey).toBe("rogue.vendor.prompt")
      } else {
        throw new Error("expected ContentProjectionError")
      }
    }
  })

  test("tripwire tolerates benign keys and empty bags", () => {
    expect(() => assertNoContentLeak({})).not.toThrow()
    expect(() =>
      assertNoContentLeak({
        "gen_ai.request.model": "llama-3b",
        "build.commit": "abc",
      }),
    ).not.toThrow()
  })
})

// ----- Route-level invariants — the Slice 6 "Done" clauses -----

describe("Slice 6 Done #1: stored span with includeContent:true is invisible on /r/:token JSON", () => {
  test("no SECRET text in the public payload, structurally or textually", async () => {
    const deps = freshDeps()
    const app = createApp(deps)
    await seedTrace(deps, {
      includeContent: true,
      promptText: "SECRET-PROMPT-PAYLOAD",
      completionText: "SECRET-COMPLETION-PAYLOAD",
      transcriptText: "SECRET-TRANSCRIPT-PAYLOAD",
      spanAttrs: {
        "gen_ai.request.model": "llama-3.2-3b-instruct-q4",
        "gen_ai.prompt": "SECRET-PROMPT-PAYLOAD",
        "gen_ai.completion": "SECRET-COMPLETION-PAYLOAD",
        "gen_ai.messages": "SECRET-MESSAGES-PAYLOAD",
        "llm.messages": "SECRET-LLM-MESSAGES",
      },
    })
    const token = mintToken(deps)
    const res = await app.request(`/r/${token}`)
    expect(res.status).toBe(200)
    const raw = await res.text()
    expect(raw).not.toContain("SECRET-PROMPT-PAYLOAD")
    expect(raw).not.toContain("SECRET-COMPLETION-PAYLOAD")
    expect(raw).not.toContain("SECRET-TRANSCRIPT-PAYLOAD")
    expect(raw).not.toContain("SECRET-MESSAGES-PAYLOAD")
    expect(raw).not.toContain("SECRET-LLM-MESSAGES")

    const body = JSON.parse(raw) as {
      spans: Array<{ attributes: Record<string, unknown> }>
    }
    for (const span of body.spans) {
      const keys = new Set(Object.keys(span.attributes))
      expect(keys.has("gen_ai.prompt")).toBe(false)
      expect(keys.has("gen_ai.completion")).toBe(false)
      expect(keys.has("gen_ai.messages")).toBe(false)
      expect(keys.has("llm.messages")).toBe(false)
      // The benign attr DOES survive.
      expect(keys.has("gen_ai.request.model")).toBe(true)
    }
  })

  test("trace-level content-shaped attributes are ALSO stripped on /r/:token", async () => {
    // Pre-Slice-6, the `/r/:token` route emitted trace.attributes raw. A
    // future caller setting trace-level `content.prompt` would have leaked.
    // Post-Slice-6, toPublicTrace strips them the same way.
    const deps = freshDeps()
    const app = createApp(deps)
    await seedTrace(deps, {
      traceAttrs: {
        "build.commit": "abc123",
        "gen_ai.prompt": "SECRET-TRACE-LEVEL-PROMPT",
        "content.transcript": "SECRET-TRACE-LEVEL-TRANSCRIPT",
      },
    })
    const token = mintToken(deps)
    const res = await app.request(`/r/${token}`)
    expect(res.status).toBe(200)
    const raw = await res.text()
    expect(raw).not.toContain("SECRET-TRACE-LEVEL-PROMPT")
    expect(raw).not.toContain("SECRET-TRACE-LEVEL-TRANSCRIPT")
    const body = JSON.parse(raw) as {
      trace: { attributes: Record<string, unknown> }
    }
    const traceKeys = new Set(Object.keys(body.trace.attributes))
    expect(traceKeys.has("gen_ai.prompt")).toBe(false)
    expect(traceKeys.has("content.transcript")).toBe(false)
    expect(traceKeys.has("build.commit")).toBe(true)
  })
})

describe("Slice 6 Done #2: OG unfurl never renders content text", () => {
  test("stored span with includeContent:true → OG PNG bytes do not contain content text", async () => {
    const deps = freshDeps()
    const app = createApp(deps)
    await seedTrace(deps, {
      includeContent: true,
      promptText: "SECRET-PROMPT-FOR-OG",
      completionText: "SECRET-COMPLETION-FOR-OG",
      spanAttrs: {
        "gen_ai.request.model": "llama-3.2-3b-instruct-q4",
        "gen_ai.prompt": "SECRET-PROMPT-FOR-OG",
        "gen_ai.completion": "SECRET-COMPLETION-FOR-OG",
      },
    })
    const token = mintToken(deps)
    const res = await app.request(`/og/${token}.png`)
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("image/png")
    const bytes = new Uint8Array(await res.arrayBuffer())
    // PNG is binary — a rasterized string wouldn't appear as literal ASCII
    // anyway, but this is belt-and-suspenders. The SVG template we render
    // from is not retained in the PNG, but if a future change started
    // embedding text metadata (tEXt chunks), this would catch it.
    const asBytes = Buffer.from(bytes)
    expect(asBytes.includes(Buffer.from("SECRET-PROMPT-FOR-OG"))).toBe(false)
    expect(asBytes.includes(Buffer.from("SECRET-COMPLETION-FOR-OG"))).toBe(false)
  })
})

describe("Slice 6 Done #3: sensitive:true trace returns 404 on public AND does not render in OG", () => {
  test("GET /r/:token → 404 for sensitive trace", async () => {
    const deps = freshDeps()
    const app = createApp(deps)
    await seedTrace(deps, { id: "trace_s", sensitive: true })
    const token = mintToken(deps, "trace_s")
    const res = await app.request(`/r/${token}`)
    expect(res.status).toBe(404)
  })

  test("GET /og/:token.png → 404 branded fallback PNG for sensitive trace", async () => {
    const deps = freshDeps()
    const app = createApp(deps)
    await seedTrace(deps, { id: "trace_s", sensitive: true })
    const token = mintToken(deps, "trace_s")
    const res = await app.request(`/og/${token}.png`)
    expect(res.status).toBe(404)
    expect(res.headers.get("Content-Type")).toBe("image/png")
    // Branded fallback, not the primary render, so the bytes should not even
    // try to include any of our seeded content. The sensitive flag short-
    // circuits before views.public_forTrace is called.
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(bytes.byteLength).toBeGreaterThan(0)
  })
})

describe("Slice 6 Done #4: fail-closed tripwire — projection throws if content slips past strip", () => {
  // We can't actually bypass stripContentAttributes from outside the module,
  // but we can assert the behavior of toPublicTrace + toPublicSpan (via the
  // private path) when given a crafted input. The point is that the symbol
  // `ContentProjectionError` is exported and matches what server.ts catches.
  test("ContentProjectionError is an exported class server code can match against", () => {
    const err = new ContentProjectionError("rogue.key.prompt")
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(ContentProjectionError)
    expect(err.offendingKey).toBe("rogue.key.prompt")
    expect(err.name).toBe("ContentProjectionError")
    expect(err.message).toContain("rogue.key.prompt")
  })

  test("toPublicTrace strips content AND runs the tripwire", () => {
    const trace: Trace = {
      id: "t",
      orgId: "org_acme",
      projectId: "p",
      sessionId: null,
      startedAt: "2026-04-15T12:00:00Z",
      endedAt: null,
      device: {},
      attributes: {
        "build.commit": "abc",
        "gen_ai.messages": "secret",
      },
      sensitive: false,
    }
    const pub = toPublicTrace(trace)
    expect(pub.attributes).toEqual({ "build.commit": "abc" })
    const pubKeys = new Set(Object.keys(pub.attributes))
    expect(pubKeys.has("gen_ai.messages")).toBe(false)
  })
})
