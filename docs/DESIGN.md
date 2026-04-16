# EdgeProbe Design System

Canonical. Day 1, sticky. Extracted from the approved `/r/{token}` variant A mockup (2026-04-15) and the locked Design Decisions in the CEO plan.

When you write code for any EdgeProbe surface, use this file. If this file disagrees with what you remember from the plan, this file wins. When in doubt, open the approved mockups:

- `/Users/bytedance/.gstack/projects/edge_probe/designs/public-share-20260415/variant-A.png` (public share `/r/{token}`, source of truth)
- `/Users/bytedance/.gstack/projects/edge_probe/designs/og-image-20260415/og-variant-A.png` (OG 1200×630)
- `/Users/bytedance/.gstack/projects/edge_probe/designs/app-dashboard-20260415/dashboard-home.png` (`/app` home)
- `/Users/bytedance/.gstack/projects/edge_probe/designs/app-trace-detail-20260415/trace-detail.png` (`/app/trace/{id}`)

## Brand voice

Engineer-to-engineer. Numbers over adjectives. Zero hype.

Banned words in UI copy, marketing, PR comments, OG text: `powerful`, `seamless`, `effortless`, `magical`, `revolutionary`, `cutting-edge`, `next-gen`, `unlock`, `supercharge`, `unleash`, `elevate`.

Headlines state the measurement, not the feeling.

Good: `Whisper-tiny on iPhone 15 Pro — 34% slower than baseline`
Bad: `Unlock on-device AI insights`

Copy inspiration: Linear changelog, Fly.io blog, Vercel CLI output.

## Color tokens

CSS custom properties. Dark-default. `prefers-color-scheme: light` is a secondary track, not P0.

```css
:root {
  /* Canvas */
  --bg: #0a0a0b;           /* near-black, NOT pure black */
  --surface: #131316;      /* cards, elevated blocks */
  --surface-inset: #0a0a0b;/* code blocks inside surfaces */
  --border: #26262b;       /* 1px borders, no shadows */

  /* Text */
  --fg: #f5f5f7;           /* primary */
  --fg-muted: #9a9aa1;     /* labels, metadata, secondary */
  --fg-subtle: #71717a;    /* tertiary, timestamps */

  /* Signals */
  --accent: #4cc9f0;       /* links, primary buttons, normal span bars */
  --signal-bad: #ef4444;   /* regressions, errors — ONLY */
  --signal-ok: #22c55e;    /* passing thresholds — ONLY */
  /* No yellow "warning" tier. Binary pass/fail reads faster on public URLs. */

  /* Focus */
  --focus-ring: 2px solid var(--accent);
}
```

Contrast (verified):
- `--fg` on `--bg` = 18.6:1 (WCAG AAA)
- `--fg-muted` on `--bg` = 7.2:1 (WCAG AA large + body)
- `--accent` on `--bg` = 9.1:1 (WCAG AAA for UI components)

Color alone is never the only signal. Regressions always combine: red bar + `▲ 34%` delta arrow + text (`34% slower than baseline`).

## Typography

Two families, both Google Fonts, both free. Self-host the WOFF2.

```css
:root {
  --font-mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  --font-sans: 'Inter', system-ui, -apple-system, sans-serif;
}
```

Rules:
- Numbers, durations, device IDs, code, span names, attributes → `--font-mono`
- Prose, headlines, UI labels, buttons → `--font-sans`
- No default system font stack alone. Ship the custom fonts or don't ship.

Type scale:

| Role | Family | Size | Weight | Leading |
|------|--------|------|--------|---------|
| Verdict H1 (desktop) | Inter | 48px | 600 | 56px |
| Verdict H1 (mobile) | Inter | 32px | 600 | 38px |
| Section heading | Inter | 20px | 600 | 28px |
| Body | Inter | 15px | 400 | 24px |
| Label small | Inter | 12px | 500 | 16px (UPPERCASE, letter-spacing 0.04em) |
| Hero metric number | Plex Mono | 32px | 500 | 40px |
| Inline metric number | Plex Mono | 24px | 500 | 32px |
| Table data | Plex Mono | 14px | 400 | 22px |
| Caption / metadata | Plex Mono | 12px | 400 | 18px |

Max weight anywhere: 600. No black weights, no condensed, no italics.

## Spacing

8px base grid. Scale:

```
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-6: 24px;
--space-8: 32px;
--space-12: 48px;
--space-16: 64px;
```

Section gaps on `/r/{token}` and `/app/trace/{id}`: `--space-8` (32px) between major blocks, `--space-4` (16px) within a block.

## Radii

```
--radius-sm: 2px;   /* span bars, inline chips, dense data */
--radius: 6px;      /* default — buttons, inputs, cards */
--radius-lg: 12px;  /* only on images or full surfaces */
```

No bubbly large radii. No pills for non-status UI.

## Elevation

**No shadows by default.** A premium interface reads premium without decorative shadows.

Elevation via borders + surface color only:
- Card / block: `background: var(--surface); border: 1px solid var(--border);`
- Code block inset inside a card: `background: var(--surface-inset); border-left: 3px solid var(--accent);`
- Floating right-side attribute panel on `/app/trace/{id}`: same card style, no drop shadow

## Layout widths

| Surface | Max width | Notes |
|---------|-----------|-------|
| `/r/{token}` | 960px | Wider feels dashboardy. Narrower feels blog. |
| `/app` home | 1280px | Dashboard needs room for row density |
| `/app/trace/{id}` | 1280px | Left rail 240px + content 1000px |
| OG image | 1200×630 (fixed) | 3:2, never cropped |

Gutter: `--space-6` (24px) on all viewports except mobile (`--space-4`).

## Glyphs allowed

Five total. Anything else is forbidden.

| Glyph | Use |
|-------|-----|
| `▲` | Wordmark only (`EdgeProbe ▲`) |
| `→` | CTA arrow (`View full trace →`), directional link affordance |
| `🔒` | Redaction lock on content slots not shared |
| `✓` | Pass / no-regression status |
| `⧉` | Copy-to-clipboard button only |

No emoji in headlines, buttons, toasts, status pills, navigation, section decoration, empty states.

## Component patterns

### Status pill

```
┌───────────────────┐
│ ● Regression       │   background: var(--surface); border: 1px solid var(--signal-bad);
└───────────────────┘   color: var(--signal-bad); padding: 4px 10px; border-radius: 12px;
                        text-transform: uppercase; font-size: 11px; letter-spacing: 0.06em;
```

Variants: `regression` (red), `ok` (green). No other colors.

### Hero metric tile (4-up strip on `/r/{token}`, 4-up on `/app/trace/{id}`)

```
┌─────────────────────┐
│ TTFT                │ ← label: Inter 12px uppercase, --fg-muted, letter-spacing 0.04em
│ 412 ms              │ ← number: Plex Mono 32px --fg
│ ▲ 34%               │ ← delta: Plex Mono 14px --signal-bad (only if regressed)
└─────────────────────┘

220px wide desktop, 50% width (2x2 grid) mobile. 92px tall minimum.
Card: var(--surface) + 1px var(--border), 6px radius.
Padding: 16px 20px.
```

Never show a delta without a baseline. If no baseline is declared, the delta row is absent entirely (not zeroed).

### Gantt waterfall span row

```
whisper-decode  ▮▮▮                          89 ms    ← span name left (Plex Mono 14px)
                                                        bar: --accent at 60% opacity, 2px radius
                                                        bar height: 12px, row height: 32px
```

Regressed span: bar in `--signal-bad`, delta badge in top-right of the row: `+18% vs baseline`.

Nested spans: indent 20px per level, tree-line in `--border` connecting parent to child.

Time axis ticks at 0, 250ms, 500ms, 750ms, etc. in `--fg-subtle`. Tick labels in Plex Mono 10px.

### Redacted content slot on `/r/{token}`

A Gantt row where `includeContent: false` or `sensitive: true`:

```
Turn 3   ▮ whisper 45ms   🔒 Content not shared   ← lock icon + grey text, no bar for hidden spans
```

Lock icon color: `--fg-muted`. Text: Plex Mono 13px `--fg-muted`. Never reveal that content exists elsewhere. `aria-label="Content not shared for this turn"`.

### Expandable content block on `/app/trace/{id}` (auth'd only)

```
┌─ Captured content ─────────────── 🔓 Org members only ─┐
│                                                         │
│ Prompt                                                  │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ What's the weather in San Francisco right now?      │ │  ← inset block
│ │                                                      │ │     --surface-inset background
│ │                                                      │ │     3px --accent left border
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ Completion                                              │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ The current weather in San Francisco is 62°F...     │ │
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

Never appears on `/r/{token}`. Rendered only from `v_private_spans` SQL view.

### Button

```
Primary:   bg --accent, fg #0a0a0b, 6px radius, 10px 16px padding, Inter 14px 500
Secondary: bg transparent, border 1px --border, fg --fg, same padding
Destructive: not used at P0 (no destructive flows)
```

Hover: primary darkens 8%, secondary border becomes `--fg-muted`. Focus: 2px `--accent` outline, 2px offset.

### Nav bar

Top horizontal:
```
EdgeProbe ▲    Projects · Sessions · Settings                 [org ▾] [avatar]
```

Left-aligned wordmark, center-ish tabs (with `·` separator, not pipe), right cluster for org switcher + avatar. 56px tall. Bottom border 1px `--border`. No left sidebar at P0.

Active tab: `--fg` + 2px `--accent` underline. Inactive: `--fg-muted`. Hover: `--fg`.

## Motion

Two motions only. Both earn their pixels.

```css
/* 1. Metric count-up on first paint */
@media (prefers-reduced-motion: no-preference) {
  .metric-number {
    animation: count-up 300ms ease-out;
  }
}

/* 2. Span bar staggered fill */
@media (prefers-reduced-motion: no-preference) {
  .gantt-bar {
    animation: fill 600ms ease-out;
    animation-delay: calc(var(--bar-index) * 40ms);
  }
}
```

Under `prefers-reduced-motion: reduce`, everything renders immediately with final values. No hover bounces, no parallax, no scroll-linked effects.

## Accessibility baseline

- All text passes WCAG 2.2 AA (body 4.5:1, large 3:1). Verified pairs above.
- Tab order is semantic. Skip-to-content link first.
- Focus ring: 2px `--accent`, 2px offset. Never `outline: none`.
- Touch targets: 44×44px minimum on mobile.
- Gantt timeline has a hidden `<table role="table">` fallback with per-turn data for screen readers.
- Every glyph (`🔒`, `→`, `▲`, `⧉`, `✓`) has an `aria-label` or is wrapped in text that makes it redundant.
- `prefers-reduced-motion: reduce` disables all entrance animations.
- axe runs in CI, PR blocked on new violations.

## Responsive breakpoints

```
/* mobile  */ @media (max-width: 640px)
/* tablet  */ @media (min-width: 641px) and (max-width: 1023px)
/* desktop */ @media (min-width: 1024px)
```

`/r/{token}` is opened inside Slack and Twitter mobile webviews more than on desktop. Mobile is the primary target for the viral surface.

Mobile rules for `/r/{token}`:
- Verdict H1 → 32/38, wrap up to 3 lines
- Hero metric strip → 2×2 grid, each tile ≥ 120px tall
- Gantt → horizontal scroll within bounded container, `Scroll →` affordance at right edge
- No information relies on hover

Mobile rules for `/app` home:
- Top nav collapses to wordmark + hamburger
- Project rows stack, each ≥ 56px tall

## What we forbid

- Generic SaaS card grid as main layout on any surface
- Purple, indigo, violet gradient backgrounds
- 3-column feature grid (icon-in-circle + bold title + 2-line description)
- Centered everything
- Emoji as design elements beyond the 5 allowed glyphs
- Icons in colored circles as section decoration
- Colored left-border on cards (except the 3px accent on code inset blocks)
- "Welcome to EdgeProbe" copy
- Cookie-cutter section rhythm (hero → 3-features → testimonials → pricing → CTA)
- Decorative blobs, wavy SVG dividers, floating circles
- Shadows on cards
- Yellow warning states (binary pass/fail only on public surfaces)

## CSS starter file

Write this as `styles/tokens.css` on day one of implementation.

```css
@font-face { font-family: 'Inter'; src: url('/fonts/inter.woff2') format('woff2'); font-display: swap; }
@font-face { font-family: 'IBM Plex Mono'; src: url('/fonts/plex-mono.woff2') format('woff2'); font-display: swap; }

:root {
  --bg: #0a0a0b;
  --surface: #131316;
  --surface-inset: #0a0a0b;
  --border: #26262b;
  --fg: #f5f5f7;
  --fg-muted: #9a9aa1;
  --fg-subtle: #71717a;
  --accent: #4cc9f0;
  --signal-bad: #ef4444;
  --signal-ok: #22c55e;

  --font-mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  --font-sans: 'Inter', system-ui, -apple-system, sans-serif;

  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
  --space-6: 24px; --space-8: 32px; --space-12: 48px; --space-16: 64px;

  --radius-sm: 2px; --radius: 6px; --radius-lg: 12px;
}

html { background: var(--bg); color: var(--fg); font-family: var(--font-sans); }
body { margin: 0; line-height: 1.5; }
code, kbd, samp, .mono { font-family: var(--font-mono); }

a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 3px; }

:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
```

## Extracted language reference (from approved variant A)

The `$D extract` command produced this JSON from the actual approved mockup:

```json
{
  "colors": [
    {"name":"background","hex":"#1E1E1E","usage":"main background"},
    {"name":"text-primary","hex":"#FFFFFF","usage":"primary text"},
    {"name":"highlight","hex":"#FF3B30","usage":"warnings, errors"},
    {"name":"accent","hex":"#0096FF","usage":"positive status, links"},
    {"name":"neutral","hex":"#B3B3B3","usage":"secondary text, labels"}
  ],
  "mood": "modern and technical with a focus on clarity and functionality"
}
```

Note: the vision extractor sampled approximate values. The canonical tokens above (`#0a0a0b`, `#4cc9f0`, `#ef4444`, `#f5f5f7`) are the Day-1 spec and take precedence over the extractor's approximations. Use the canonical tokens when implementing.

## Change protocol

This file is sticky. Changing a token or adding a forbidden-pattern exception requires a design review pass on all five surfaces. Run `/design-review` before making changes here. Log the diff.

The CSS tokens file `styles/tokens.css` should import from this document's values 1:1. If they drift, this file is wrong, not the code.
