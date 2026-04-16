/** @jsxImportSource hono/jsx */

/**
 * Top nav bar, per DESIGN.md §Nav.
 *
 * At P0 there is no Projects/Sessions/Settings content to link to — the
 * dashboard index is a follow-up. The bar renders with just the wordmark
 * and a placeholder org identifier on the right so the chrome is there
 * and the layout doesn't jump when we add the tabs.
 */
export function Nav({ orgId }: { orgId?: string }) {
  return (
    <nav class="nav" aria-label="Primary">
      <div class="nav__brand">
        EdgeProbe<span class="nav__brand-glyph" aria-hidden="true">▲</span>
      </div>
      <div class="nav__right">
        {orgId ? <span>{orgId}</span> : <span>no session</span>}
      </div>
    </nav>
  )
}
