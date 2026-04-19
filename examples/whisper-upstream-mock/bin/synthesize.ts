#!/usr/bin/env bun
/**
 * examples/whisper-upstream-mock/bin/synthesize.ts
 *
 * Deterministic "fake whisper" — reads params.json and emits a trace.json
 * the EdgeProbe Action understands. The whole point is:
 *
 *   same params  →  byte-identical trace.json
 *   diff  params  →  materially different trace.json
 *
 * So when a demo PR changes `beam_size: 1 → 5`, the re-runs inside that PR
 * produce stable numbers (no flaky CI), but the delta vs the main baseline
 * is large and visible. A real whisper benchmark has runner-noise dynamics
 * we want NO part of in a demo that's supposed to build trust in the Action.
 *
 * This is not meant to approximate real whisper performance. It's meant
 * to be legible: someone reading synthesize.ts should see the knobs, and
 * someone reading the PR comment should see the knobs' effect.
 *
 * Usage:
 *   bun run bin/synthesize.ts                      # reads ../params.json
 *   bun run bin/synthesize.ts path/to/params.json  # explicit path
 *   (stdout → trace.json)
 */

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))

type ModelSize = "tiny" | "base" | "small" | "medium"

interface Params {
  model_size: ModelSize
  beam_size: number
  n_threads: number
  /**
   * Optional project override for the first-run demo. When set, the trace
   * lands under a different EdgeProbe project so the Action treats it as
   * a brand-new project with no baseline.
   */
  project?: string
}

// Base encode cost by whisper model size. Ballpark from whisper.cpp benchmarks
// on M1 MacBook — not meant to be exact, just ordered correctly so the demo
// feels plausible when someone asks "why is `medium` slower?".
const BASE_ENCODE_MS: Record<ModelSize, number> = {
  tiny: 80,
  base: 200,
  small: 500,
  medium: 1200,
}

/**
 * Thread scaling — sub-linear. `1.5/sqrt(n)` means:
 *   1 thread → 1.50x
 *   2 threads → 1.06x  ← noise zone
 *   4 threads → 0.75x  ← sweet spot we set as default
 *   8 threads → 0.53x
 *  16 threads → 0.38x  ← diminishing returns
 */
function threadFactor(n: number): number {
  return 1.5 / Math.sqrt(Math.max(1, n))
}

/**
 * Beam penalty on decode — near-linear with slight sub-linear tail.
 *   beam=1 → 1.00x
 *   beam=2 → 1.87x
 *   beam=5 → 4.26x  ← the regression-PR trigger
 *   beam=10 → 7.94x
 */
function beamPenalty(beam: number): number {
  return Math.pow(Math.max(1, beam), 0.9)
}

/**
 * Deterministic ±3% noise driven by a SHA of (paramsBlob, index).
 * Same params + same index → same noise. That's what makes re-runs stable.
 */
function deterministicNoise(seed: string, index: number): number {
  const h = createHash("sha256").update(`${seed}:${index}`).digest()
  const u32 = h.readUInt32BE(0)
  return (u32 / 0xffffffff - 0.5) * 0.06 // [-0.03, 0.03]
}

interface TraceTurn {
  turn: number
  stages: Record<string, number>
  totalMs: number
}

interface TraceSummary {
  project: string
  label: string
  headlineMetric: string
  headlineMs: number
  totalMs: number
  turns: TraceTurn[]
}

function synthesize(params: Params): TraceSummary {
  const seed = createHash("sha256")
    .update(JSON.stringify(params))
    .digest("hex")
    .slice(0, 16)

  const baseEncode = BASE_ENCODE_MS[params.model_size] ?? BASE_ENCODE_MS.tiny
  const turns: TraceTurn[] = []

  // Two "turns" = two clips from the benchmark corpus. Even numbers don't
  // mean anything real, they just make for a richer waterfall in the share URL.
  for (let i = 1; i <= 2; i++) {
    const encodeMs = Math.max(
      1,
      Math.round(
        baseEncode
          * threadFactor(params.n_threads)
          * (1 + deterministicNoise(seed, i * 2)),
      ),
    )
    const decodeMs = Math.max(
      1,
      Math.round(
        baseEncode
          * 0.4
          * beamPenalty(params.beam_size)
          * (1 + deterministicNoise(seed, i * 2 + 1)),
      ),
    )
    // Stage keys match the Action's hardcoded column schema
    // (whisper | prefill | decode — see action/src/comment.ts:136).
    // For a whisper-only benchmark the encoder is the `whisper` column
    // and the text decoder is the `decode` column; `prefill` stays empty
    // because there's no LLM prefill phase here. When the Action renderer
    // goes data-driven (#TODO-column-flex), these keys can be renamed.
    turns.push({
      turn: i,
      stages: { whisper: encodeMs, decode: decodeMs },
      totalMs: encodeMs + decodeMs,
    })
  }

  const headlineMs = turns[0]!.totalMs
  const totalMs = turns.reduce((acc, t) => acc + t.totalMs, 0)

  return {
    project: params.project ?? "whisper-upstream-mock",
    label:
      `whisper.cpp synthesized · model=${params.model_size}`
      + ` beam=${params.beam_size} threads=${params.n_threads}`,
    headlineMetric: "transcribe_ms",
    headlineMs,
    totalMs,
    turns,
  }
}

function main(): void {
  const paramsPath = process.argv[2] ?? resolve(__dirname, "..", "params.json")
  const params = JSON.parse(readFileSync(paramsPath, "utf8")) as Params
  const out = synthesize(params)
  process.stdout.write(JSON.stringify(out, null, 2) + "\n")
}

main()
