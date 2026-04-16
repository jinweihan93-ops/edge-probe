/** @jsxImportSource hono/jsx */

import type { WaterfallRow } from "../lib/metrics.ts"
import { formatMs } from "../lib/metrics.ts"

interface WaterfallProps {
  rows: WaterfallRow[]
  ticks: number[]
  totalMs: number
  /**
   * If true, rows that would carry content on the private view are rendered
   * as redacted placeholders on the public view. For P0 public shares we
   * render no text from content.* attributes (backend already strips them),
   * so this flag just controls whether a small lock-icon row is appended
   * for included-but-not-shared turns.
   *
   * Defaults to false because backend filtering is the truth; the redacted
   * row is a UX affordance, not a security measure.
   */
  renderRedactedSlot?: boolean
}

/**
 * Gantt-style waterfall per DESIGN.md §Gantt waterfall span row.
 * No content text leaves this component — it only receives durations, names,
 * kinds, and pre-computed geometry. Passing a PublicSpan[] here is safe by
 * construction: the type does not carry promptText / completionText.
 */
export function Waterfall({ rows, ticks, totalMs, renderRedactedSlot = false }: WaterfallProps) {
  return (
    <div class="waterfall" role="region" aria-label="Span timeline">
      <div class="waterfall__axis" aria-hidden="true">
        {ticks.map((t) => (
          <span>{formatMs(t)}</span>
        ))}
      </div>

      {rows.map((r, idx) => (
        <div class="waterfall__row">
          <div
            class="waterfall__name"
            style={`padding-left: ${r.depth * 20}px`}
            title={r.name}
          >
            {r.name}
          </div>
          <div class="waterfall__track" aria-hidden="true">
            <span
              class={`waterfall__bar${r.status === "error" ? " waterfall__bar--error" : ""}`}
              style={`left:${r.offsetPct.toFixed(2)}%; width:${r.widthPct.toFixed(2)}%; --bar-index:${idx}`}
            />
          </div>
          <div class="waterfall__dur">{formatMs(r.durationMs)}</div>
        </div>
      ))}

      {renderRedactedSlot && (
        <div class="waterfall__row" aria-label="Content not shared for this turn">
          <div class="waterfall__name" style="color: var(--fg-muted)">
            —
          </div>
          <div class="waterfall__redacted">
            <span class="waterfall__redacted-glyph" aria-hidden="true">🔒</span>
            Content not shared
          </div>
          <div class="waterfall__dur"></div>
        </div>
      )}

      {/* Screen-reader fallback: a real table with the same data. */}
      <table class="sr-only" aria-label="Spans (accessible table view)">
        <thead>
          <tr>
            <th>Name</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr>
              <td>{r.name}</td>
              <td>{formatMs(r.durationMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {totalMs === 0 && (
        <div class="waterfall__redacted">No spans yet.</div>
      )}
    </div>
  )
}
