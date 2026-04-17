# EdgeProbe GitHub Action

Post a PR comment summarizing an EdgeProbe trace and flag regressions against a baseline.

## What it does

Given a JSON trace summary from your test harness, the Action:

1. Optionally ingests the trace into the EdgeProbe backend and mints a shareable `/r/<token>` URL.
2. Compares a headline metric (e.g. TTFT) against an optional baseline trace.
3. Renders a stable PR comment in one of three shapes:
   - **regression** — collapsed per-turn diff, deltas, red framing, exit code 1 by default.
   - **pass** — one-line ✓ status with the headline and optional trace link.
   - **first-run** — informational, shown when no baseline is provided.
4. Writes the comment markdown to the `comment` action output and to stdout.

The Action **never carries prompt or completion text**. Its job is summarize-and-link — full traces live in EdgeProbe and open via the share URL.

## Usage

```yaml
- name: Run on-device perf harness
  run: ./scripts/run-harness.sh --out trace.json

- name: EdgeProbe
  id: edgeprobe
  uses: edgeprobe/edgeprobe-ios/action@v0
  with:
    trace-file: trace.json
    baseline-file: main-baseline.json  # optional
    threshold: "0.15"                  # 15%, the default
    backend-url: https://edgeprobe.dev
    ingest-key: ${{ secrets.EDGEPROBE_INGEST_KEY }}
    dashboard-key: ${{ secrets.EDGEPROBE_DASHBOARD_KEY }}
    org-id: org_yourco
    project-id: proj_voice

- name: Post sticky PR comment
  if: github.event_name == 'pull_request'
  uses: marocchino/sticky-pull-request-comment@v2
  with:
    header: edgeprobe
    message: ${{ steps.edgeprobe.outputs.comment }}
```

The Action runs on any Linux, macOS, or Windows runner — it uses Bun via `oven-sh/setup-bun`, not a Docker container.

## Inputs

| input | required | default | notes |
| --- | --- | --- | --- |
| `trace-file` | yes | — | Path to the current run's trace summary JSON. |
| `baseline-file` | no | — | Path to the baseline trace summary. Omit for first-run. |
| `threshold` | no | `0.15` | Regression threshold on headline metric, as proportion. |
| `fail-on-regression` | no | `true` | Exit 1 when a regression is detected. |
| `backend-url` | no | — | EdgeProbe backend base URL. Required for share-link mint. |
| `ingest-key` | no | — | `epk_pub_…`. |
| `dashboard-key` | no | — | `epk_dash_…`. |
| `org-id` | no | `org_unknown` | |
| `project-id` | no | `proj_unknown` | |
| `dry-run` | no | `false` | Render comment without hitting backend. |
| `configure-url` | no | — | Optional link shown in the footer. |
| `version` | no | `0.0.1` | Version string in the footer. |

## Outputs

| output | notes |
| --- | --- |
| `comment` | Rendered markdown. Feed into a sticky-comment action. |

## Trace summary shape

```jsonc
{
  "project": "voiceprobe-demo",
  "label": "iPhone 15 Pro · iOS 18.2 · Whisper-tiny + llama-3B Q4_K_M",
  "headlineMetric": "TTFT",
  "headlineMs": 1280,
  "totalMs": 4500,
  "turns": [
    { "turn": 1, "stages": { "whisper": 240, "prefill": 420, "decode": 620 }, "totalMs": 1280 },
    { "turn": 2, "stages": { "whisper": 260, "prefill": 480, "decode": 700 }, "totalMs": 1440 }
  ],
  // Optional — when unset, the Action fills `thisRef`/`thisSha` from
  // GITHUB_REF_NAME/GITHUB_SHA and `baselineRef` from GITHUB_BASE_REF.
  "git": {
    "baselineRef": "main",
    "baselineSha": "abc1234",
    "thisRef": "perf/voice-probe-slow",
    "thisSha": "def5678"
  }
}
```

See `fixtures/trace.sample.json` and `fixtures/baseline.sample.json` for complete examples.

## Exit codes

| code | meaning |
| --- | --- |
| 0 | No regression, or first-run (no baseline). |
| 1 | Regression detected and `fail-on-regression` is `true` (default). |
| 2 | Internal error — failed to read trace, malformed JSON, etc. The comment still renders with an error notice. |

Backend failures (ingest 5xx, share mint failure) are **not** fatal — the comment renders without a share link and the Action continues. CI jobs should not go red because of a flaky backend.

## Local development

```bash
cd action
bun install
bun test              # unit + smoke tests
bun run typecheck     # tsc --noEmit
bun run start -- \
  --trace fixtures/trace.sample.json \
  --baseline fixtures/baseline.sample.json \
  --dry-run
```

The golden-fixture tests in `test/comment.test.ts` assert the PR comment markdown byte-for-byte. If you intentionally change the template, update the corresponding `fixtures/comment.*.golden.md` file.
