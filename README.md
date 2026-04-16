# EdgeProbe

On-device AI observability for iOS. OpenTelemetry-compatible SDK, trace viewer, CI regression detector.

**Status:** Year 2 P0 — initial scaffolding. Plan is CONDITIONAL pending gating (see `docs/PLAN.md`).

## Layout

```
ios/       Swift Package — EdgeProbe SDK (iOS 16+)
backend/   Bun + Postgres — /ingest, /r/{token}, /app/trace/{id}
web/       Dashboard — /app
docs/      Plan, design system, architecture notes
scripts/   Dev + CI helpers
.github/   Workflows (XCFramework builds on llama.cpp tags, CI matrix)
```

## Quick start

```bash
# iOS SDK
cd ios && swift test

# Backend
cd backend && bun install && bun test

# Web
cd web && bun install && bun test
```

## The three-line install (what we are building toward)

```swift
import EdgeProbe

EdgeProbe.start(apiKey: "epk_pub_...")

try EdgeProbe.trace(.llm) {
    try model.generate(prompt)
}
```

That is the whole pitch. The SDK captures the span, exports it to the backend, and the dashboard shows a waterfall trace. Public share URLs carry timings but never prompt/completion text.

## Reference docs

- **Plan:** `docs/PLAN.md` — Year 2 P0 strategy, architecture decisions, review reports
- **Design system:** `docs/DESIGN.md` — color tokens, typography, components, forbidden patterns
- **Critical regression paths:** see "Critical Paths" in `docs/TEST-PLAN.md` — six tests that gate ship

## Critical invariants (never regress)

1. Public share `/r/{token}` never renders prompt/completion text
2. Cross-org trace ID scan returns 403, not 404
3. Per-call `includeContent: true` does not escalate to public visibility
4. Main thread never blocked by SDK
5. SDK drops oldest on buffer overflow, counter emitted as metric
6. `EdgeProbe.start()` is idempotent
