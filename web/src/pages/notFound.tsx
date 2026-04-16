/** @jsxImportSource hono/jsx */

import { Layout } from "../components/Layout.tsx"

/**
 * Single 404 page for every "we have nothing to show you" branch.
 *
 * The public share has a security requirement to collapse every failure mode
 * to this same page — malformed token, expired token, tampered token, wrong
 * org, sensitive trace all render this exact HTML. An attacker probing /r/
 * cannot distinguish them.
 */
export function NotFoundPage({ reason }: { reason?: string } = {}) {
  return (
    <Layout title="Not found · EdgeProbe" publicSurface>
      <div class="empty">
        <h1 class="empty__title">Not found</h1>
        <p class="empty__body">
          {reason ?? "This trace isn't available. The link may have expired, been revoked, or never existed."}
        </p>
      </div>
    </Layout>
  )
}
