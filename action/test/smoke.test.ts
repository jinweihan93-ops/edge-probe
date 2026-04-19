import { describe, test, expect } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createApp, makeMemoryDeps } from "../../backend/src/server.ts"
import { TEST_DASHBOARD_KEY_ACME } from "../../backend/src/auth.ts"
import { runAction, parseArgs } from "../src/entry.ts"
import { ActionClient, summaryToIngestPayload } from "../src/client.ts"
import type { FetchImpl } from "../src/client.ts"
import type { EntryOptions } from "../src/entry.ts"
import type { TraceSummary } from "../src/types.ts"

/**
 * smoke.test.ts — end-to-end sanity: wire the Action against a
 * real (in-memory) backend built from `createApp(makeMemoryDeps(...))`,
 * exercise /ingest + /app/trace/:id/share, and confirm the rendered
 * comment carries the minted share URL.
 *
 * This is the test that catches cross-package drift. If
 * `summaryToIngestPayload` stops matching the backend's expected wire
 * shape, this test fires immediately.
 */

const SHARE_SECRET = "smoke-secret-".padEnd(48, "x")

/**
 * Mint a fresh pub ingest key on the in-memory apiKeyStore. We can't
 * hard-code a token the way we do for dashboard keys (`TEST_DASHBOARD_KEY_ACME`)
 * because Slice 5's `/ingest` verifies the token via `apiKeyStore.verify`,
 * which argon2-hashes and looks up by id — only minted or bootstrapped
 * tokens pass. This mirrors `pubKeyFor` in
 * `backend/test/ingestHardening.test.ts`.
 */
async function mintIngestKey(
  deps: ReturnType<typeof makeMemoryDeps>,
  orgId = "org_acme",
): Promise<string> {
  const { rawToken } = await deps.apiKeyStore.mint(orgId, "pub", "smoke")
  return rawToken
}

/** Placeholder used by tests that never hit the real backend (dry-run, sabotage). */
const DUMMY_INGEST_KEY = "epk_pub_unused_000000000000000000"

function honoFetch(app: ReturnType<typeof createApp>): FetchImpl {
  // Route `fetch(url, init)` straight into the Hono app. The URL host
  // is ignored — only the path matters — so tests can use any
  // `http://test.invalid` origin.
  return async (input, init) => {
    const url = typeof input === "string" || input instanceof URL
      ? String(input)
      : input.url
    return app.fetch(new Request(url, init))
  }
}

function sampleSummary(): TraceSummary {
  return {
    project: "voiceprobe-demo",
    label: "iPhone 15 Pro · iOS 18.2 · Whisper-tiny + llama-3B Q4_K_M",
    headlineMetric: "TTFT",
    headlineMs: 1280,
    totalMs: 1280,
    turns: [
      { turn: 1, stages: { whisper: 240, prefill: 420, decode: 620 }, totalMs: 1280 },
    ],
  }
}

async function writeTempJson(body: unknown): Promise<string> {
  const path = join(tmpdir(), `edgeprobe-smoke-${Math.random().toString(36).slice(2)}.json`)
  await Bun.write(path, JSON.stringify(body))
  return path
}

describe("Action smoke — in-process backend", () => {
  test("first-run: ingests, mints share URL, embeds it in the comment, exit 0", async () => {
    const deps = makeMemoryDeps(SHARE_SECRET)
    const app = createApp(deps)
    const ingestKey = await mintIngestKey(deps)
    const client = new ActionClient({
      baseUrl: "http://test.invalid",
      ingestKey,
      dashboardKey: TEST_DASHBOARD_KEY_ACME,
      fetchImpl: honoFetch(app),
    })

    const tracePath = await writeTempJson(sampleSummary())

    const opts: EntryOptions = {
      tracePath,
      threshold: 0.15,
      failOnRegression: true,
      backendUrl: "http://test.invalid",
      ingestKey,
      dashboardKey: TEST_DASHBOARD_KEY_ACME,
      orgId: "org_acme",
      projectId: "proj_demo",
      dryRun: false,
      version: "0.0.1",
      deps: {
        readFile: (p) => Bun.file(p).text(),
        writeOutput: async () => {},
        client,
      },
    }

    const result = await runAction(opts)

    expect(result.exitCode).toBe(0)           // first-run
    expect(result.delta).toBeNull()           // no baseline
    expect(result.shareUrl).not.toBeNull()
    expect(result.shareUrl!).toMatch(/^http:\/\/test\.invalid\/r\//)
    expect(result.body).toContain(result.shareUrl!)
    expect(result.body).toContain("first trace on voiceprobe-demo")
  })

  test("regression: shareUrl still minted, exit 1 because delta exceeds threshold", async () => {
    const deps = makeMemoryDeps(SHARE_SECRET)
    const app = createApp(deps)
    const ingestKey = await mintIngestKey(deps)
    const client = new ActionClient({
      baseUrl: "http://test.invalid",
      ingestKey,
      dashboardKey: TEST_DASHBOARD_KEY_ACME,
      fetchImpl: honoFetch(app),
    })

    const current = sampleSummary()
    const baseline: TraceSummary = { ...current, headlineMs: 960, totalMs: 960 }

    const tracePath = await writeTempJson(current)
    const baselinePath = await writeTempJson(baseline)

    const result = await runAction({
      tracePath,
      baselinePath,
      threshold: 0.15,
      failOnRegression: true,
      backendUrl: "http://test.invalid",
      ingestKey,
      dashboardKey: TEST_DASHBOARD_KEY_ACME,
      orgId: "org_acme",
      projectId: "proj_demo",
      dryRun: false,
      version: "0.0.1",
      deps: {
        readFile: (p) => Bun.file(p).text(),
        writeOutput: async () => {},
        client,
      },
    })

    expect(result.exitCode).toBe(1)
    expect(result.delta).toBeCloseTo(0.3333, 3)
    expect(result.shareUrl).not.toBeNull()
    expect(result.body).toContain("regression detected on voiceprobe-demo")
    expect(result.body).toContain(result.shareUrl!)
  })

  test("fail-on-regression=false: regression detected but exit still 0", async () => {
    const deps = makeMemoryDeps(SHARE_SECRET)
    const app = createApp(deps)
    const ingestKey = await mintIngestKey(deps)
    const client = new ActionClient({
      baseUrl: "http://test.invalid",
      ingestKey,
      dashboardKey: TEST_DASHBOARD_KEY_ACME,
      fetchImpl: honoFetch(app),
    })

    const current = sampleSummary()
    const baseline: TraceSummary = { ...current, headlineMs: 960, totalMs: 960 }

    const result = await runAction({
      tracePath: await writeTempJson(current),
      baselinePath: await writeTempJson(baseline),
      threshold: 0.15,
      failOnRegression: false,
      backendUrl: "http://test.invalid",
      ingestKey,
      dashboardKey: TEST_DASHBOARD_KEY_ACME,
      orgId: "org_acme",
      projectId: "proj_demo",
      dryRun: false,
      version: "0.0.1",
      deps: {
        readFile: (p) => Bun.file(p).text(),
        writeOutput: async () => {},
        client,
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.delta).toBeCloseTo(0.3333, 3)
  })

  test("dry-run: no backend calls, no share URL, but comment still renders", async () => {
    // A deps.client that would THROW if called proves we didn't hit it.
    const poisonClient = {
      ingestAndShare: async () => {
        throw new Error("dry-run must not call the client")
      },
    } as unknown as ActionClient

    const result = await runAction({
      tracePath: await writeTempJson(sampleSummary()),
      threshold: 0.15,
      failOnRegression: true,
      backendUrl: "http://test.invalid",
      ingestKey: DUMMY_INGEST_KEY,
      dashboardKey: TEST_DASHBOARD_KEY_ACME,
      orgId: "org_acme",
      projectId: "proj_demo",
      dryRun: true,
      version: "0.0.1",
      deps: {
        readFile: (p) => Bun.file(p).text(),
        writeOutput: async () => {},
        client: poisonClient,
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.shareUrl).toBeNull()
    expect(result.body).toContain("No share URL")
  })

  test("backend ingest 5xx: comment still renders, Action does not fail", async () => {
    // Backend that always 500s on /ingest — Action should downgrade gracefully,
    // because a flaky backend must never fail the consumer's CI.
    const sabotageClient: Pick<ActionClient, "ingestAndShare"> = {
      ingestAndShare: async () => {
        throw new Error("ingest failed: 500 InternalServerError")
      },
    }

    const result = await runAction({
      tracePath: await writeTempJson(sampleSummary()),
      threshold: 0.15,
      failOnRegression: true,
      backendUrl: "http://test.invalid",
      ingestKey: DUMMY_INGEST_KEY,
      dashboardKey: TEST_DASHBOARD_KEY_ACME,
      orgId: "org_acme",
      projectId: "proj_demo",
      dryRun: false,
      version: "0.0.1",
      deps: {
        readFile: (p) => Bun.file(p).text(),
        writeOutput: async () => {},
        client: sabotageClient as ActionClient,
      },
    })

    expect(result.exitCode).toBe(0)       // first-run
    expect(result.shareUrl).toBeNull()
    expect(result.body).toContain("first trace on voiceprobe-demo")
  })

  test("dashboardUrl (when set) anchors share URL at the dashboard host, not the backend", async () => {
    // Split-service scenario: backend at edgeprobe-staging.fly.dev returns
    // JSON for /r/:token; web at edgeprobe-web-staging.fly.dev returns HTML.
    // The PR comment must link to the web host so humans see the visualization,
    // not raw JSON. Backend is still the ingest + share-mint target.
    const deps = makeMemoryDeps(SHARE_SECRET)
    const app = createApp(deps)
    const ingestKey = await mintIngestKey(deps)
    const client = new ActionClient({
      baseUrl: "http://backend.invalid",
      dashboardUrl: "http://dashboard.invalid",
      ingestKey,
      dashboardKey: TEST_DASHBOARD_KEY_ACME,
      fetchImpl: honoFetch(app),
    })

    const result = await runAction({
      tracePath: await writeTempJson(sampleSummary()),
      threshold: 0.15,
      failOnRegression: true,
      backendUrl: "http://backend.invalid",
      dashboardUrl: "http://dashboard.invalid",
      ingestKey,
      dashboardKey: TEST_DASHBOARD_KEY_ACME,
      orgId: "org_acme",
      projectId: "proj_demo",
      dryRun: false,
      version: "0.0.1",
      deps: {
        readFile: (p) => Bun.file(p).text(),
        writeOutput: async () => {},
        client,
      },
    })

    expect(result.shareUrl).not.toBeNull()
    // The critical assertion: the URL is rooted at the dashboard, not the backend.
    expect(result.shareUrl!).toMatch(/^http:\/\/dashboard\.invalid\/r\//)
    expect(result.shareUrl!).not.toContain("backend.invalid")
    expect(result.body).toContain(result.shareUrl!)
  })

  test("dashboardUrl unset → share URL falls back to backendUrl (v0.1.0 compat)", async () => {
    // v0.1.0 consumers (e.g. the whisper demo pinned at action-v0.1.0) did not
    // pass --dashboard-url. Their share URLs must still compose off backendUrl
    // exactly as before — otherwise pinning an old tag silently changes link
    // destinations.
    const deps = makeMemoryDeps(SHARE_SECRET)
    const app = createApp(deps)
    const ingestKey = await mintIngestKey(deps)
    const client = new ActionClient({
      baseUrl: "http://legacy-backend.invalid",
      // dashboardUrl intentionally omitted
      ingestKey,
      dashboardKey: TEST_DASHBOARD_KEY_ACME,
      fetchImpl: honoFetch(app),
    })

    const result = await runAction({
      tracePath: await writeTempJson(sampleSummary()),
      threshold: 0.15,
      failOnRegression: true,
      backendUrl: "http://legacy-backend.invalid",
      ingestKey,
      dashboardKey: TEST_DASHBOARD_KEY_ACME,
      orgId: "org_acme",
      projectId: "proj_demo",
      dryRun: false,
      version: "0.0.1",
      deps: {
        readFile: (p) => Bun.file(p).text(),
        writeOutput: async () => {},
        client,
      },
    })

    expect(result.shareUrl).not.toBeNull()
    expect(result.shareUrl!).toMatch(/^http:\/\/legacy-backend\.invalid\/r\//)
  })

  test("bad trace JSON → exit 2 with failure body", async () => {
    const badPath = join(tmpdir(), `edgeprobe-bad-${Math.random().toString(36).slice(2)}.json`)
    await Bun.write(badPath, "{ not valid json")

    const result = await runAction({
      tracePath: badPath,
      threshold: 0.15,
      failOnRegression: true,
      orgId: "org_acme",
      projectId: "proj_demo",
      dryRun: true,
      version: "0.0.1",
      deps: {
        readFile: (p) => Bun.file(p).text(),
        writeOutput: async () => {},
      },
    })

    expect(result.exitCode).toBe(2)
    expect(result.body).toContain("action failed")
  })
})

describe("summaryToIngestPayload + parseArgs — wire contract", () => {
  test("ingest payload has a trace block and one span per non-empty stage", () => {
    const payload = summaryToIngestPayload(sampleSummary(), {
      orgId: "org_acme",
      projectId: "proj_demo",
      now: new Date("2026-04-17T00:00:00Z"),
    })
    expect(payload.trace.orgId).toBe("org_acme")
    expect(payload.trace.projectId).toBe("proj_demo")
    expect(payload.trace.sensitive).toBe(false)
    // Turn 1 has whisper + prefill + decode → 3 spans.
    expect(payload.spans.length).toBe(3)
    // No prompt/completion text — the Action handles summaries, not content.
    for (const span of payload.spans) {
      expect(span.promptText).toBeNull()
      expect(span.completionText).toBeNull()
      expect(span.transcriptText).toBeNull()
      expect(span.includeContent).toBe(false)
    }
  })

  test("parseArgs picks up long flags + booleans", () => {
    const parsed = parseArgs([
      "--trace", "/tmp/t.json",
      "--baseline", "/tmp/b.json",
      "--threshold", "0.20",
      "--fail-on-regression", "false",
      "--backend-url", "https://example.test",
      "--dashboard-url", "https://dashboard.example.test",
      "--ingest-key", "epk_pub_xxx",
      "--dashboard-key", "epk_dash_yyy",
      "--org", "org_a",
      "--project", "proj_b",
      "--dry-run",
      "--configure-url", "https://example.test/cfg",
      "--version", "9.9.9",
    ])
    expect(parsed.tracePath).toBe("/tmp/t.json")
    expect(parsed.baselinePath).toBe("/tmp/b.json")
    expect(parsed.threshold).toBe(0.20)
    expect(parsed.failOnRegression).toBe(false)
    expect(parsed.backendUrl).toBe("https://example.test")
    expect(parsed.dashboardUrl).toBe("https://dashboard.example.test")
    expect(parsed.ingestKey).toBe("epk_pub_xxx")
    expect(parsed.dashboardKey).toBe("epk_dash_yyy")
    expect(parsed.orgId).toBe("org_a")
    expect(parsed.projectId).toBe("proj_b")
    expect(parsed.dryRun).toBe(true)
    expect(parsed.configureUrl).toBe("https://example.test/cfg")
    expect(parsed.version).toBe("9.9.9")
  })
})
