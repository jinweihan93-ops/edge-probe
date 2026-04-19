import type { CommentInput } from "./types.ts"

/**
 * Render a PR comment in the exact shape pinned by `docs/DESIGN.md`:
 *
 *   ### EdgeProbe · regression detected on <project>
 *
 *   **<metric> <current> ms → <baseline> ms (<delta>)** on `<label>`.
 *
 *   Baseline: `<ref> @ <sha>` · This PR: `<ref> @ <sha>`
 *
 *   <details>
 *   <summary>Per-turn diff …</summary>
 *
 *   | Turn | whisper | prefill | decode | total | delta |
 *   | ...
 *
 *   </details>
 *
 *   **View full trace →** <share url>
 *
 *   <sub>EdgeProbe <version> · threshold: <N>% · [configure](url)</sub>
 *
 * Three variants:
 *   - regression  → the full block above, red framing, `<details>` collapsed
 *                   by default but present.
 *   - pass        → one-line `✓ No regression detected on <project>. …`
 *   - first-run   → informational, baseline absent.
 *
 * Every output is stable: no timestamps, no emoji beyond `✓` and `▲` (the
 * wordmark arrow used in the header), no Markdown tokens that render as
 * emoji on GitHub. Stability is the contract for the golden test.
 */
export function renderComment(input: CommentInput): string {
  if (input.baseline === null || input.verdict.delta === null) {
    return renderFirstRun(input)
  }
  if (!input.verdict.regression) {
    return renderPass(input)
  }
  return renderRegression(input)
}

// --- variants ---

function renderRegression(input: CommentInput): string {
  const { current, baseline, verdict } = input
  if (!baseline) throw new Error("renderRegression called without baseline")

  const delta = verdict.delta ?? 0
  const headline = `**${current.headlineMetric} ${fmtMs(baseline.headlineMs)} → ${fmtMs(current.headlineMs)} (${fmtDelta(delta)})** on \`${current.label}\`.`

  const gitLine = renderGitLine(input)
  const table = renderTurnTable(input)
  const trace = renderTraceLink(input)
  const footer = renderFooter(input)

  const pieces = [
    `### EdgeProbe · regression detected on ${current.project}`,
    "",
    headline,
    ...(gitLine ? ["", gitLine] : []),
    "",
    table,
    "",
    trace,
    "",
    footer,
  ]
  return pieces.join("\n") + "\n"
}

function renderPass(input: CommentInput): string {
  const { current, verdict } = input
  const delta = verdict.delta ?? 0
  const deltaText = delta === 0 ? "baseline" : `baseline ${fmtDelta(delta)}`
  const trace = input.shareUrl ? ` · [view trace](${input.shareUrl})` : ""
  const line = `${PASS_GLYPH} No regression detected on ${current.project}. ${current.headlineMetric} ${fmtMs(current.headlineMs)} (${deltaText})${trace}`
  return `${line}\n\n${renderFooter(input)}\n`
}

function renderFirstRun(input: CommentInput): string {
  const { current } = input
  const gitLine = renderGitLine(input)
  const table = current.turns.length > 0 ? renderTurnTable(input) : null
  const trace = renderTraceLink(input)
  const headline = `**${current.headlineMetric} ${fmtMs(current.headlineMs)}** on \`${current.label}\`. No baseline to compare against yet.`

  const pieces = [
    `### EdgeProbe · first trace on ${current.project}`,
    "",
    headline,
    ...(gitLine ? ["", gitLine] : []),
    ...(table ? ["", table] : []),
    "",
    trace,
    "",
    renderFooter(input),
  ]
  return pieces.join("\n") + "\n"
}

// --- pieces ---

function renderGitLine(input: CommentInput): string | null {
  const g = input.current.git
  if (!g) return null
  const base = g.baselineRef || g.baselineSha
    ? `Baseline: \`${fmtRef(g.baselineRef, g.baselineSha)}\``
    : null
  const cur = g.thisRef || g.thisSha
    ? `This PR: \`${fmtRef(g.thisRef, g.thisSha)}\``
    : null
  if (!base && !cur) return null
  if (base && cur) return `${base} · ${cur}`
  return base ?? cur ?? null
}

function fmtRef(ref: string | undefined, sha: string | undefined): string {
  const r = ref ?? ""
  const s = sha ? shortSha(sha) : ""
  if (r && s) return `${r} @ ${s}`
  return r || s
}

function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

function renderTurnTable(input: CommentInput): string {
  const rows = input.verdict.turns
  if (rows.length === 0) return ""

  const summary = summariseTurnCount(rows)
  const header = `<details>\n<summary>Per-turn diff (${summary})</summary>\n`
  // TODO(#column-flex): hardcoded to the voice-loop stage vocabulary
  // (whisper | prefill | decode). Benchmarks with other stage names
  // (e.g. a pure-TTS pipeline) currently see their stage cells drop out.
  // Should be derived from the union of stage keys present in the trace,
  // with a stable order hinted by the trace itself. Safe to defer until
  // the second non-voice-loop benchmark lands — see bin/synthesize.ts in
  // jinweihan-ai/edgeprobe-whisper-demo for the workaround pattern.
  const columns = ["Turn", "whisper", "prefill", "decode", "total", "delta"]
  const currentByTurn = new Map(input.current.turns.map((t) => [t.turn, t]))

  const body: string[] = []
  body.push("| " + columns.join(" | ") + " |")
  body.push("|" + columns.map(() => "------").join("|") + "|")
  for (const r of rows) {
    const t = currentByTurn.get(r.turn)
    const w = fmtStage(t?.stages.whisper)
    const p = fmtStage(t?.stages.prefill)
    const d = fmtStage(t?.stages.decode)
    const total = fmtMs(r.currentMs)
    const delta = r.delta === null ? "—" : fmtDelta(r.delta)
    body.push(`| ${r.turn} | ${w} | ${p} | ${d} | ${total} | ${delta} |`)
  }

  return `${header}\n${body.join("\n")}\n\n</details>`
}

function summariseTurnCount(
  rows: Array<{ delta: number | null }>,
): string {
  const total = rows.length
  const faster = rows.filter((r) => r.delta !== null && r.delta < 0).length
  const slower = rows.filter((r) => r.delta !== null && r.delta > 0).length
  if (faster === 0 && slower === 0) return `${total} turn${total === 1 ? "" : "s"}`
  return `${slower} turn${slower === 1 ? "" : "s"} slower, ${faster} turn${faster === 1 ? "" : "s"} faster`
}

function renderTraceLink(input: CommentInput): string {
  if (!input.shareUrl) return "_No share URL — backend did not return one._"
  return `**View full trace ${ARROW_GLYPH}** ${input.shareUrl}`
}

function renderFooter(input: CommentInput): string {
  const thresholdPct = Math.round(input.threshold * 100)
  const cfg = input.configureUrl ? ` · [configure](${input.configureUrl})` : ""
  return `<sub>EdgeProbe ${input.version} · threshold: ${thresholdPct}%${cfg}</sub>`
}

// --- formatting primitives ---

/** Allowed glyphs from `DESIGN.md`. Copy preserved because we assert on exact bytes in the golden. */
const PASS_GLYPH = "\u2713" // ✓
const ARROW_GLYPH = "\u2192" // →
const MINUS_GLYPH = "\u2212" // − (minus sign, not hyphen-minus)

export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return "—"
  if (ms < 1000) return `${Math.round(ms).toLocaleString("en-US")} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

/**
 * `+34%`, `-2%`. Uses a real minus sign, not a hyphen-minus, to match the
 * design doc. Values smaller than 0.5% round to `±0%`.
 */
export function fmtDelta(proportion: number): string {
  const pct = Math.round(proportion * 100)
  if (pct === 0) return "±0%"
  if (pct > 0) return `+${pct}%`
  return `${MINUS_GLYPH}${Math.abs(pct)}%`
}

function fmtStage(ms: number | undefined): string {
  if (ms === undefined) return "—"
  return fmtMs(ms)
}
