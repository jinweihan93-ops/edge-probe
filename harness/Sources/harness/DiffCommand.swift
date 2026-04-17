import Foundation

/// Implements `harness diff <baseline.json> <this.json>`.
///
/// Produces a Markdown string shaped like the EdgeProbe PR-comment template
/// (see action/fixtures/comment.regression.golden.md). The harness is the
/// upstream source of truth for what a "turn timing" looks like; the action
/// consumes this same schema in production CI. Keeping the output format
/// identical here means tomorrow's action-harness wire-up is a straight
/// pipe, no re-parsing.
///
/// Behavior:
///   - Baseline + "this" must share (model, promptHash). If not, that's a
///     hard error — you're comparing apples to oranges and the numbers would
///     lie. Users who genuinely want cross-model diffs need to build their
///     own report; the harness refuses to muddle them.
///   - Per-iteration diff: align by iter index. Emit a table with
///     prefillMs / decodeMs / totalMs / delta % columns.
///   - Aggregate headline: worst-case total Δ across iterations. This is
///     what the action's comment leads with ("TTFT 960ms → 1.28s (+33%)").
///   - Return format is pure Markdown — no ANSI, no CR, LF-only. Goldens
///     are byte-diffable.
func diffCommand(
    baseline: TimingBlob,
    this: TimingBlob,
    threshold pct: Double = 0.15
) throws -> String {
    guard baseline.model == this.model else {
        throw HarnessError.usage(
            "model mismatch: baseline=\(baseline.model) vs this=\(this.model) — refusing to compare across models"
        )
    }
    guard baseline.promptHash == this.promptHash else {
        throw HarnessError.usage(
            "prompt hash mismatch: baseline=\(baseline.promptHash) vs this=\(this.promptHash) — different prompts produce incomparable timings"
        )
    }
    guard baseline.runs.count == this.runs.count else {
        throw HarnessError.usage(
            "iteration count mismatch: baseline=\(baseline.runs.count) vs this=\(this.runs.count)"
        )
    }

    // Compute per-iter deltas and worst total.
    var rows: [Row] = []
    var worstDelta: Double = 0
    var regressionCount = 0
    var improvementCount = 0
    for (b, t) in zip(baseline.runs, this.runs) {
        let delta = b.totalMs == 0 ? 0 : (Double(t.totalMs - b.totalMs) / Double(b.totalMs))
        rows.append(Row(
            iter: b.iter,
            bTotal: b.totalMs,
            tTotal: t.totalMs,
            deltaPct: delta,
            bPrefill: b.prefillMs,
            tPrefill: t.prefillMs,
            bDecode: b.decodeMs,
            tDecode: t.decodeMs
        ))
        if delta > pct { regressionCount += 1 }
        if delta < -pct { improvementCount += 1 }
        if abs(delta) > abs(worstDelta) { worstDelta = delta }
    }

    let verdict: String
    if worstDelta > pct {
        verdict = "regression detected"
    } else if worstDelta < -pct {
        verdict = "improvement detected"
    } else {
        verdict = "no change"
    }

    // Header. Model + promptHash are the identity; they uniquely pin what
    // was compared. Worst-case iter is what we lead with, matching the
    // action's "TTFT 960ms → 1.28s (+33%)" convention.
    var md = ""
    md += "### EdgeProbe harness · \(verdict) on `\(baseline.model)`\n"
    md += "\n"
    md += "Prompt: `\(baseline.promptHash)` · \(baseline.runs.count) iterations · threshold: \(Int(pct * 100))%\n"
    md += "\n"
    md += "**Worst-case total: \(formatMs(worstRow(rows).bTotal)) → \(formatMs(worstRow(rows).tTotal)) (\(formatDelta(worstDelta)))**\n"
    md += "\n"

    let summaryDetails: String
    if regressionCount > 0 && improvementCount > 0 {
        summaryDetails = "\(regressionCount) slower · \(improvementCount) faster"
    } else if regressionCount > 0 {
        summaryDetails = "\(regressionCount) slower"
    } else if improvementCount > 0 {
        summaryDetails = "\(improvementCount) faster"
    } else {
        summaryDetails = "all within ±\(Int(pct * 100))%"
    }

    md += "<details>\n"
    md += "<summary>Per-iteration diff (\(summaryDetails))</summary>\n"
    md += "\n"
    md += "| iter | prefill | decode | total | delta |\n"
    md += "|------|------|------|------|------|\n"
    for row in rows {
        md += "| \(row.iter) | \(formatMs(row.bPrefill)) → \(formatMs(row.tPrefill)) | \(formatMs(row.bDecode)) → \(formatMs(row.tDecode)) | \(formatMs(row.bTotal)) → \(formatMs(row.tTotal)) | \(formatDelta(row.deltaPct)) |\n"
    }
    md += "\n"
    md += "</details>\n"
    md += "\n"
    md += "<sub>EdgeProbe harness · schema v\(baseline.schema)</sub>\n"
    return md
}

private func worstRow(_ rows: [Row]) -> (bTotal: Int, tTotal: Int) {
    guard let w = rows.max(by: { abs($0.deltaPct) < abs($1.deltaPct) }) else {
        return (0, 0)
    }
    return (w.bTotal, w.tTotal)
}

private struct Row {
    let iter: Int
    let bTotal: Int
    let tTotal: Int
    let deltaPct: Double
    let bPrefill: Int
    let tPrefill: Int
    let bDecode: Int
    let tDecode: Int
}

/// Format ms as "1240 ms" for sub-second, "1.24 s" otherwise.
/// Matches action/fixtures/comment.regression.golden.md convention exactly.
func formatMs(_ ms: Int) -> String {
    if ms < 1000 {
        return "\(ms) ms"
    }
    let s = Double(ms) / 1000.0
    // Round to 2 decimals for readability, drop trailing zero-decimal part.
    // "1.00 s" → "1 s" isn't the convention in the existing golden
    // (it keeps 1.28 s form), so always keep 2 decimals.
    return String(format: "%.2f s", s)
}

/// Format a fractional delta (0.33) as "+33%" / "-12%" / "±0%".
func formatDelta(_ frac: Double) -> String {
    let pct = Int((frac * 100).rounded())
    if pct == 0 { return "±0%" }
    if pct > 0 { return "+\(pct)%" }
    return "\(pct)%"  // negative sign already present
}
