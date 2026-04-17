/**
 * Relative-time formatter for list-row dashboards.
 *
 * We keep it terse and mono-friendly:
 *   <1m   →  "just now"
 *   <1h   →  "12m ago"
 *   <1d   →  "3h ago"
 *   <7d   →  "4d ago"
 *   else  →  "2026-04-10" (ISO date, no time)
 *
 * Never says "a few seconds ago" / "yesterday" / "last week" — those are
 * marketing phrasing. EdgeProbe's voice is numbers over adjectives
 * (DESIGN.md §Voice).
 *
 * `now` is injectable so tests can pin a reference time without freezing
 * Date.now globally.
 */
export function formatRelativeTime(
  iso: string,
  now: number = Date.now(),
): string {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return iso // malformed → show as-is, harmless
  const delta = now - then
  // Future timestamps — don't say negative things, just render the date.
  if (delta < 0) return iso.slice(0, 10)
  const s = Math.floor(delta / 1000)
  if (s < 60) return "just now"
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return iso.slice(0, 10)
}
