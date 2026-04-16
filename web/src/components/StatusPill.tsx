/** @jsxImportSource hono/jsx */

/**
 * Status pill, per DESIGN.md §Component patterns. Two variants only:
 * `ok` (green) and `bad` (red). No yellow, no neutral — binary status
 * reads faster on public URLs.
 */
export function StatusPill({
  kind,
  children,
}: {
  kind: "ok" | "bad"
  children: string
}) {
  return (
    <span class={`pill pill--${kind}`} role="status">
      <span class="pill__dot" aria-hidden="true" />
      {children}
    </span>
  )
}
