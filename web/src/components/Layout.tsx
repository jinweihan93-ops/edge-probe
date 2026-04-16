/** @jsxImportSource hono/jsx */

import type { Child } from "hono/jsx"
import { Nav } from "./Nav.tsx"

interface LayoutProps {
  title: string
  /** OG card description. Timings only, never prompt text. */
  ogDescription?: string
  /** Optional 1200×630 OG image URL. */
  ogImage?: string
  /** Page-level CSS class hook, used to switch between 960px and 1280px max-widths. */
  pageClass?: string
  children: Child
  /** When true, no nav bar (for the public share — standalone, shareable, no app chrome). */
  publicSurface?: boolean
}

/**
 * Outer shell used by every page. Deliberately dumb:
 *  - Sets the meta tags (OG + Twitter card)
 *  - Loads tokens.css
 *  - Renders <Nav/> unless publicSurface is true
 *
 * The public share surface drops the nav because the design system treats
 * `/r/:token` as a standalone artifact. Dashboard surfaces keep the nav.
 */
export function Layout(props: LayoutProps) {
  const og = props.ogDescription ?? "EdgeProbe trace"
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        <meta name="description" content={og} />
        <meta property="og:title" content={props.title} />
        <meta property="og:description" content={og} />
        <meta property="og:type" content="website" />
        {props.ogImage && <meta property="og:image" content={props.ogImage} />}
        <meta name="twitter:card" content={props.ogImage ? "summary_large_image" : "summary"} />
        <meta name="twitter:title" content={props.title} />
        <meta name="twitter:description" content={og} />
        <link rel="stylesheet" href="/styles/tokens.css" />
        <link rel="icon" href="data:," />
      </head>
      <body>
        <a class="skip-to-content" href="#main">Skip to content</a>
        {!props.publicSurface && <Nav />}
        <main id="main" class={`page ${props.pageClass ?? ""}`.trim()}>
          {props.children}
        </main>
      </body>
    </html>
  )
}
