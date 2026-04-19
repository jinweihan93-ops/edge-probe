import type { TraceSummary } from "./types.ts"

/**
 * Thin HTTP client for the EdgeProbe backend.
 *
 * This is *not* the SDK — the SDK runs on-device and captures spans. This
 * client is what the Action uses in CI to:
 *
 *   1. POST /ingest (so the trace lives in the backend even if the test
 *      harness produced it locally), and
 *   2. POST /app/trace/:id/share to mint a `/r/:token` URL we can drop
 *      into the PR comment.
 *
 * The Action never reads content back from the backend — its job is
 * summarize-and-link, not render-the-trace. So there's no `fetchPublic`
 * here like `web/src/lib/backend.ts`.
 */
/**
 * Callable-only fetch signature. Deliberately NOT `typeof fetch` — Bun's
 * global `fetch` carries extra properties (e.g. `.preconnect`) that we
 * don't need, and requiring them would make tests contort to re-create
 * those on a stub. Accept a plain call-signature and let Bun's fetch
 * satisfy it structurally.
 */
export type FetchImpl = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export interface ActionClientConfig {
  /** Base URL of the EdgeProbe backend (e.g. `https://edgeprobe.dev`). */
  baseUrl: string
  /**
   * Optional base URL of the EdgeProbe dashboard (e.g. `https://edgeprobe.app`).
   *
   * When set, share links in the PR comment point at `<dashboardUrl>/r/<token>`
   * so clicking the link renders the HTML trace viewer (web/) instead of the
   * raw JSON served directly by the backend.
   *
   * Omit for backward compat with v0.1.0: share URLs then compose off
   * `baseUrl` as before.
   */
  dashboardUrl?: string
  /** Ingest key (`epk_pub_…`). */
  ingestKey: string
  /** Dashboard key (`epk_dash_…`). Used to mint the share URL. */
  dashboardKey: string
  /** fetch impl (injected for tests). */
  fetchImpl?: FetchImpl
}

export interface IngestResult {
  traceId: string
  shareUrl: string
}

/**
 * Translate a `TraceSummary` into the wire shape `POST /ingest` expects
 * today (trace header + one aggregate span per turn). Matches the schema
 * asserted by `backend/src/views.ts`.
 *
 * This is a summary-level projection; it deliberately does not carry
 * prompt/completion text. The Action never handles content.
 */
export function summaryToIngestPayload(summary: TraceSummary, opts: {
  orgId: string
  projectId: string
  now?: Date
}) {
  const start = opts.now ?? new Date()
  const startIso = start.toISOString()
  const totalMs = summary.totalMs
  const endIso = new Date(start.getTime() + Math.max(1, totalMs)).toISOString()
  const traceId = `trace_ci_${start.getTime().toString(36)}_${randomHex(4)}`

  // Turns play back-to-back: turn N starts where turn N-1 ended. Resetting
  // the cursor per-turn makes same-kind spans across turns share startedAt
  // (or cross — whichever turn's previous stage was slower ends up later),
  // which scrambles the waterfall in web/ where spans are sorted by startedAt.
  let cursor = start.getTime()
  const spans = summary.turns.flatMap((t) => {
    const turnSpans = buildTurnSpans(traceId, t, cursor)
    cursor += sumStageDurations(t.stages)
    return turnSpans
  })

  return {
    trace: {
      id: traceId,
      orgId: opts.orgId,
      projectId: opts.projectId,
      sessionId: null,
      startedAt: startIso,
      endedAt: endIso,
      device: { label: summary.label },
      attributes: {
        "gen_ai.request.model": summary.label,
        "edgeprobe.ci": true,
      },
      sensitive: false,
    },
    spans,
  }
}

function buildTurnSpans(
  traceId: string,
  t: TraceSummary["turns"][number],
  turnStartMs: number,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  let cursor = turnStartMs
  for (const [kind, durationMs] of Object.entries(t.stages)) {
    if (durationMs === undefined) continue
    const started = cursor
    const ended = cursor + durationMs
    cursor = ended
    out.push({
      id: `span_${traceId.slice(-6)}_t${t.turn}_${kind}`,
      traceId,
      parentSpanId: null,
      name: kind,
      kind: kindOfStage(kind),
      startedAt: new Date(started).toISOString(),
      endedAt: new Date(ended).toISOString(),
      durationMs,
      status: "ok",
      attributes: { turn: t.turn, stage: kind },
      includeContent: false,
      promptText: null,
      completionText: null,
      transcriptText: null,
    })
  }
  return out
}

function sumStageDurations(stages: TraceSummary["turns"][number]["stages"]): number {
  let s = 0
  for (const v of Object.values(stages)) if (v !== undefined) s += v
  return s
}

function kindOfStage(stage: string): "llm" | "asr" | "tts" | string {
  if (stage === "whisper") return "asr"
  if (stage === "prefill" || stage === "decode") return "llm"
  if (stage === "tts") return "tts"
  return stage
}

function randomHex(n: number): string {
  const chars = "0123456789abcdef"
  let s = ""
  for (let i = 0; i < n * 2; i++) s += chars[Math.floor(Math.random() * 16)]
  return s
}

export class ActionClient {
  private readonly baseUrl: string
  private readonly dashboardUrl: string
  private readonly fetchImpl: FetchImpl

  constructor(private readonly cfg: ActionClientConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/$/, "")
    // Fall back to the backend URL when no dashboard is configured — keeps
    // v0.1.0 consumers' share URLs unchanged (they get raw JSON, same as
    // before), while new consumers that opt into `dashboard-url` get the
    // HTML trace viewer.
    this.dashboardUrl = (cfg.dashboardUrl ?? cfg.baseUrl).replace(/\/$/, "")
    this.fetchImpl = cfg.fetchImpl ?? fetch
  }

  async ingestAndShare(
    summary: TraceSummary,
    opts: { orgId: string; projectId: string },
  ): Promise<IngestResult> {
    const payload = summaryToIngestPayload(summary, opts)
    const ingestRes = await this.fetchImpl(`${this.baseUrl}/ingest`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.cfg.ingestKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    })
    if (!ingestRes.ok) {
      throw new Error(`ingest failed: ${ingestRes.status} ${await safeBody(ingestRes)}`)
    }

    const shareRes = await this.fetchImpl(
      `${this.baseUrl}/app/trace/${encodeURIComponent(payload.trace.id)}/share`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.cfg.dashboardKey}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    )
    if (!shareRes.ok) {
      throw new Error(`share failed: ${shareRes.status} ${await safeBody(shareRes)}`)
    }
    const shareBody = (await shareRes.json()) as { url: string }
    // `shareBody.url` is path-relative (`/r/:token`). Compose the absolute URL
    // so the PR comment carries a link reviewers can click.
    //
    // The URL is anchored to `dashboardUrl` (which falls back to `baseUrl`
    // when unset, preserving v0.1.0 behavior). The split exists because
    // backend/ and web/ are separate services: `/r/:token` on the backend
    // returns JSON (for machine consumers), the same path on web/ returns
    // the HTML trace viewer (for humans opening from a PR).
    const shareUrl = `${this.dashboardUrl}${shareBody.url}`
    return { traceId: payload.trace.id, shareUrl }
  }
}

async function safeBody(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return "<unreadable body>"
  }
}
