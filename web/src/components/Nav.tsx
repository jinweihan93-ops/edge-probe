/** @jsxImportSource hono/jsx */

/**
 * Top nav bar, per DESIGN.md §Nav.
 *
 * The Projects link is the only non-brand link at this tier — Sessions /
 * Settings land in later slices. When the user has no session at all
 * (orgId missing) the link is omitted so the bar doesn't advertise dead
 * ends to logged-out visitors.
 */
export function Nav({ orgId }: { orgId?: string }) {
  return (
    <nav class="nav" aria-label="Primary">
      <div class="nav__brand">
        EdgeProbe<span class="nav__brand-glyph" aria-hidden="true">▲</span>
      </div>
      {orgId && (
        <div class="nav__links">
          <a href={`/app?org=${encodeURIComponent(orgId)}`}>Projects</a>
        </div>
      )}
      <div class="nav__right">
        {orgId ? <span>{orgId}</span> : <span>no session</span>}
      </div>
    </nav>
  )
}
