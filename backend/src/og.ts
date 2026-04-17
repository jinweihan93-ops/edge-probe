/**
 * OG image generator — `GET /og/:token.png`.
 *
 * Renders a 1200×630 PNG card summarizing a trace, suitable for
 * Slack/Twitter/Telegram/iMessage unfurls. Plain-text unfurls are dead on
 * arrival for a design-heavy tool, and many of those consumers don't
 * render inline SVG — so we rasterize here, cache hard, and let Slack
 * fetch the bytes.
 *
 * The boundary rules:
 *   - This route accepts a share token. Token is the auth — same model
 *     as /r/:token. No Authorization header, no orgId headers.
 *   - Every failure mode (invalid / expired / sensitive / unknown trace)
 *     renders the SAME branded fallback card with HTTP 404. We never
 *     return a provider default "image not available" placeholder,
 *     and we never leak the failure reason to the scraper. Same
 *     stance as /r/:token.
 *   - We never render prompt / completion / transcript text on the card.
 *     Inputs are derived from trace + span *timings* only.
 *
 * Font policy:
 *   - The vendored Inter + IBM Plex Mono files live at web/public/fonts
 *     (see that README). When they exist, we'd pass them via
 *     `Resvg.fontFiles`; until then, resvg falls back to the system
 *     default font (DejaVu Sans on Linux, Helvetica on macOS). Works
 *     fine for shippable unfurls — upgrading to the brand faces is a
 *     cosmetic follow-up, not a correctness issue.
 */

import { Resvg } from "@resvg/resvg-js"
import type { Trace, PublicSpan } from "./views.ts"

export interface OgCardInput {
  trace: Trace
  spans: PublicSpan[]
}

export interface OgCardMetrics {
  totalMs: number
  spanCount: number
  status: "ok" | "error"
  deviceModel: string
  modelName: string
}

/**
 * Minimal subset of `web/src/lib/metrics.ts#computeMetrics` — the OG card
 * only needs totalMs + device + model + status, so we compute them here
 * rather than take a cross-package dependency. The web metrics module is
 * the canonical computation; if that changes, mirror the change here.
 */
export function deriveCardMetrics(input: OgCardInput): OgCardMetrics {
  const { trace, spans } = input
  const startMs = Date.parse(trace.startedAt)
  const endMs = trace.endedAt
    ? Date.parse(trace.endedAt)
    : spans.reduce((m, s) => Math.max(m, Date.parse(s.endedAt)), startMs)
  const totalMs = Math.max(0, endMs - startMs)

  let status: "ok" | "error" = "ok"
  let modelName: string | null = null
  for (const s of spans) {
    if (s.status === "error") status = "error"
    if (!modelName && s.kind === "llm") {
      const m = s.attributes["gen_ai.request.model"]
      if (typeof m === "string") modelName = m
    }
  }

  const deviceModel = typeof trace.device["model"] === "string"
    ? (trace.device["model"] as string)
    : "unknown device"

  return {
    totalMs,
    spanCount: spans.length,
    status,
    deviceModel,
    modelName: modelName ?? "unknown model",
  }
}

/** Dark canvas + accent bar shared between hero and fallback. */
const CANVAS = `
  <rect width="1200" height="630" fill="#0a0a0b"/>
  <rect x="0" y="0" width="1200" height="6" fill="#4cc9f0"/>
`.trim()

const FONT_SANS = "Inter, 'DejaVu Sans', Helvetica, Arial, sans-serif"
const FONT_MONO = "'IBM Plex Mono', 'DejaVu Sans Mono', Menlo, monospace"

export function renderOgPng(input: OgCardInput): Uint8Array {
  const m = deriveCardMetrics(input)
  const totalLabel = formatMsBig(m.totalMs)
  // Status pill colors mirror tokens.css — cyan accent is NOT a status color.
  const statusColor = m.status === "ok" ? "#22c55e" : "#ef4444"
  const statusText = m.status === "ok" ? "OK" : "ERROR"

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  ${CANVAS}

  <!-- wordmark (top-left) -->
  <text x="80" y="90"  font-family="${FONT_SANS}" font-weight="600" font-size="36" fill="#f5f5f7">EdgeProbe ▲</text>
  <text x="80" y="126" font-family="${FONT_SANS}" font-weight="400" font-size="20" fill="#9a9aa1">on-device trace · public · no prompt text</text>

  <!-- hero: model name + total -->
  <text x="80" y="290" font-family="${FONT_SANS}" font-weight="600" font-size="56" fill="#f5f5f7">${escapeXml(m.modelName)}</text>
  <text x="80" y="400" font-family="${FONT_MONO}" font-weight="500" font-size="108" fill="#4cc9f0">${escapeXml(totalLabel)}</text>

  <!-- device + span count -->
  <text x="80" y="470" font-family="${FONT_SANS}" font-weight="500" font-size="32" fill="#f5f5f7">on ${escapeXml(m.deviceModel)}</text>
  <text x="80" y="506" font-family="${FONT_SANS}" font-weight="400" font-size="22" fill="#9a9aa1">${m.spanCount} span${m.spanCount === 1 ? "" : "s"}</text>

  <!-- bottom row -->
  <text x="80"  y="580" font-family="${FONT_MONO}" font-weight="400" font-size="20" fill="#71717a">${escapeXml(input.trace.id)}</text>
  <rect x="1020" y="558" width="100" height="32" rx="16" fill="#131316" stroke="${statusColor}" stroke-width="1"/>
  <text x="1070" y="580" text-anchor="middle" font-family="${FONT_SANS}" font-weight="500" font-size="14" fill="${statusColor}" letter-spacing="1.2">${statusText}</text>
</svg>`

  return rasterize(svg)
}

/**
 * Branded fallback for invalid tokens, expired tokens, missing traces,
 * or any other "we won't say why" failure. This renders the same card
 * chrome the happy path uses, so a stranger cannot tell (from the image
 * bytes) whether the failure was a bad token, an expired share, or a
 * legitimately nonexistent trace. Matches the /r/:token stance.
 */
export function renderFallbackPng(): Uint8Array {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  ${CANVAS}

  <text x="80" y="90"  font-family="${FONT_SANS}" font-weight="600" font-size="36" fill="#f5f5f7">EdgeProbe ▲</text>
  <text x="80" y="126" font-family="${FONT_SANS}" font-weight="400" font-size="20" fill="#9a9aa1">on-device trace · public</text>

  <text x="80" y="330" font-family="${FONT_SANS}" font-weight="600" font-size="56" fill="#f5f5f7">Trace not available</text>
  <text x="80" y="390" font-family="${FONT_SANS}" font-weight="400" font-size="28" fill="#9a9aa1">This link may have expired or been revoked.</text>

  <text x="80" y="580" font-family="${FONT_MONO}" font-weight="400" font-size="20" fill="#71717a">edgeprobe.dev</text>
</svg>`
  return rasterize(svg)
}

function rasterize(svg: string): Uint8Array {
  // `fitTo: { mode: 'width', value: 1200 }` locks the output to 1200×630
  // regardless of what `width=...` hints the SVG carries. Defense in depth
  // against a future SVG template drift.
  const r = new Resvg(svg, {
    fitTo: { mode: "width", value: 1200 },
    background: "#0a0a0b",
  })
  return r.render().asPng()
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

/**
 * OG-card sized formatter. Bigger canvas than the in-page HeroMetrics, so
 * the threshold for the sub-second path moves — we only drop to "ms" for
 * < 1 s, otherwise show seconds with 2 decimals.
 */
export function formatMsBig(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—"
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}
