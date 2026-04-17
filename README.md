# EdgeProbe

On-device AI observability for iOS. OpenTelemetry-compatible SDK, trace viewer, CI regression detector.

**Status:** Year 2 P0 — initial scaffolding. Plan is CONDITIONAL pending gating (see `docs/PLAN.md`).

## Layout

```
ios/       Swift Package — EdgeProbe SDK (iOS 16+)
backend/   Bun + Postgres — /ingest, /r/{token}, /app/trace/{id}
web/       Dashboard — /app
harness/   Benchmark CLI — `harness run` / `harness diff` (Y1 OSS tool)
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

## Benchmark harness (`harness/`)

Separate SwiftPM package with a `harness` executable + `harness run` / `harness
diff` subcommands. Purpose per `docs/PLAN.md`: source-of-truth for the monthly
benchmark posts (Y1 content) AND a reusable integration smoke for the SDK
(Y2 SDK). Each iteration wraps its work in `EdgeProbe.beginTrace()` in
dry-run mode, so the harness doubles as a span-pipeline exerciser.

```bash
cd harness

# Run N iterations against a prompt fixture. Model IDs that don't match a
# real model loader fall through to a deterministic synthetic path —
# xorshift32 seeded by SHA(prompt) ⊕ modelId ⊕ iter — so goldens are
# reproducible across machines and CI runs.
swift run harness run \
  --model mock-v1 \
  --prompt Tests/harnessTests/Fixtures/prompts/cap.txt \
  --iters 2

# Compare two runs — PR-comment-shaped Markdown diff.
swift run harness diff baseline.json this.json --threshold 0.15

# Test suite (golden fixtures, error-path coverage, EdgeProbe smoke):
swift test
```

The output JSON schema (`TimingBlob`) is versioned. Schema changes MUST
bump `schema: 1` in `Sources/harness/TimingBlob.swift` so downstream
consumers — the GitHub Action's diff comment, external benchmark
dashboards — detect format drift before they render bad numbers.

## XCFramework builds (llama.cpp / whisper.cpp)

The SDK's `Package.swift` will pin llama.cpp and whisper.cpp as
`binaryTarget()` entries pointing at prebuilt XCFrameworks. Hand-building
those across the `{ios, ios-simulator, macos} × {arm64, x86_64}` matrix
every time upstream ships a tag is eng toil we want to pay down once.

`.github/workflows/xcframework.yml` fans the matrix out on macOS runners,
strips + lipos + zips the slices, and attaches them to a GitHub release
named `xcframeworks-<llama-tag>-<whisper-tag>`. Two entrypoints:

**Manual (founder testing a new upstream tag):**

```bash
# Dry-run first — prints the build plan for each matrix cell without compiling.
gh workflow run xcframework.yml \
  -f llama_cpp_tag=b4321 \
  -f whisper_cpp_tag=v1.7.2 \
  -f dry_run=true

# When ready, flip dry_run=false. Same invocation, compile + assemble + draft release.
gh workflow run xcframework.yml \
  -f llama_cpp_tag=b4321 \
  -f whisper_cpp_tag=v1.7.2 \
  -f dry_run=false
```

**Automated (watcher on upstream releases):**

```bash
# A cron or external watcher fires a repository_dispatch event. The workflow
# builds real (not dry-run) on this path — unattended bumps land as draft
# releases for review, never auto-published.
gh api -X POST repos/:owner/:repo/dispatches \
  -f event_type=llama-cpp-release \
  -f client_payload[tag]=b4321
```

**Local sanity check:**

```bash
# The workflow delegates all real work to scripts/build-xcframework.sh.
# Running it locally with no --real prints the exact command list the
# workflow would execute for that matrix cell.
scripts/build-xcframework.sh --target ios --arch arm64 \
  --llama-tag b4321 --whisper-tag v1.7.2

scripts/build-xcframework.sh --assemble \
  --llama-tag b4321 --whisper-tag v1.7.2
```

**Current gating.** The `--real` code paths in `scripts/build-xcframework.sh`
are stubbed: they log the plan and write placeholder zips so the release
upload step has something to attach. The compile is deferred until
`Package.swift` actually references a `binaryTarget()` pin — shipping
orphan artifacts before then would just rot in Releases. When the pin
flips on, the TODO markers in `do_slice_real` / `do_assemble_real` become
the live command list.

## VoiceProbe reference demo (`ios/DemoApp`)

VoiceProbe is the "does the SDK trace a real on-device turn" demo. It
runs a full **ASR → LLM → TTS** voice loop with EdgeProbe wrapping each
stage. The LLM backend has three paths:

| Environment                          | Backend       | Model                                      | Size    | Loader                       |
|--------------------------------------|---------------|--------------------------------------------|---------|------------------------------|
| Device                               | MLX-Swift     | `mlx-community/Llama-3.2-1B-Instruct-4bit` | ~700 MB | `LLMModelFactory` (HF Hub)   |
| Simulator, default                   | Stub          | deterministic canned reply                 | 0       | in-process, no network       |
| Simulator, `-EDGEPROBE_SIM_COREML`   | CoreML        | `finnvoorhees/coreml-SmolLM2-360M-Instruct-4bit` + tokenizer from `HuggingFaceTB/SmolLM2-360M-Instruct` | ~210 MB | `MLModel` + `MLState` via `ModelHub.swift` |

**Why the split?** MLX requires Metal-for-compute and the iOS simulator
doesn't expose it — `MLX.GPU` abort()s inside `mlx::core::metal::Device`
on load. So simulator cannot use the same engine as device.

We originally shipped a CoreML SmolLM2 path on simulator so CI could
baseline latency against a real small model. It now does not run
because of a simulator/CoreML bug (see "zero-logit failure" below), so
the simulator default is a stub that still exercises the SDK's trace
pipeline with plausible (~600ms) synthetic LLM latency. The real CoreML
code is still in the tree and gated behind `-EDGEPROBE_SIM_COREML` so
future reinvestigation is a launch-arg away, not a revert.

**First launch downloads ~700 MB (device) or ~210 MB (sim with
`-EDGEPROBE_SIM_COREML`) from HuggingFace Hub.** The default sim path
downloads nothing. The progress chip ("Downloading 42%") is bound to
the actual byte stream on the real paths; subsequent launches hit the
on-device cache.

### Simulator CoreML zero-logit failure

Confirmed on Xcode 26 / iOS 26 simulator / `finnvoorhees/coreml-SmolLM2-360M-Instruct-4bit`
(2026-04-17):

1. **`.cpuAndGPU` / `.all` compute units fail to load** with
   `com.apple.CoreML` error `-14` ("Failed to build the model execution
   plan"). The simulator's GPU backend can't codegen iOS-18 stateful
   ops (`Ios18.readState` / `Ios18.writeState` in `model.mil`).
2. **`.cpuOnly` loads fine but produces all-zero logits.** First
   prediction returns a `[1, 38, 49152]` fp16 tensor where every
   element is exactly `0.0` — verified via both `dataPointer`-bound
   `Float16` access and `NSNumber` subscript. Strong signal that the
   simulator's CPU backend silently no-ops the
   `constexpr_blockwise_shift_scale` dequantization for int4 weights,
   so every matmul multiplies by zero and the downstream logits land
   on the zero-initialized output buffer.
3. **Not a read-side bug.** Pointer access and subscript access agree,
   the output shape/strides/dtype are correct (`[1, seqLen, 49152]`,
   fp16, contiguous), and the model description reports exactly one
   output (`logits`) with two inputs (`causal_mask`, `input_ids`).

`generateSimulatorCoreML` now detects all-zero logits on the first
prediction and throws `LLMError.inferenceFailed` with a message
pointing back here — rather than spinning out 128 × token-id-0 until
the budget cap and handing the user an empty string.

The code is left in `LLMService.swift` (also `ModelHub.swift`) so:

- If Apple ships a simulator-CPU fix, flipping
  `-EDGEPROBE_SIM_COREML` is a one-step re-test.
- If someone wants to try a non-int4 or non-stateful CoreML LLM that
  sidesteps both bugs, the swap points are `Repo.coremlModel` /
  `Repo.tokenizerSource` / `mlmodelcName` in `ModelHub.swift`. If the
  replacement uses camelCase input names (matching swift-transformers'
  `LanguageModel` conventions), you can revert to
  `LanguageModel.loadCompiled` and drop the custom `MLModel +
  MLState` driver.

### Simulator CoreML caveats (still true when the path is re-enabled)

- **Compute policy must be `.cpuOnly`.** Non-negotiable on simulator
  until the GPU stateful-op codegen is fixed.
- **The mlmodelc uses snake_case input names** (`input_ids`,
  `causal_mask`) because it was converted straight from PyTorch with
  default `coremltools` naming. swift-transformers' `LanguageModel`
  wrapper hard-codes camelCase (`inputIds`, `causalMask`) and
  fatalErrors on mismatch. The opt-in path therefore drives `MLModel`
  + `MLState` directly and only uses `Tokenizers` for chat template /
  encode / decode.
- **`Float16` mask values: use `-65504` (fp16 min), not `-.infinity`.**
  Some CoreML kernels turn `-inf + finite` into NaN, poisoning the
  downstream softmax. We don't use blocked-mask entries today (mask is
  all-zeros — see `predictNextToken` for why) but if you reintroduce
  upper-triangular causal masking this is the value to reach for.

### Dev ergonomics

Launch args exposed by the demo app, all off by default:

- `-EDGEPROBE_AUTOLOAD 1` — fires `llm.load()` on `.task` entry in
  parallel with the mic/speech permission dialogs. Needed because
  simulator can't accept synthetic taps without Input Monitoring TCC.
- `-EDGEPROBE_AUTOGENERATE "<prompt>"` — after autoload succeeds, runs
  one `llm.generate(prompt)` and prints the reply + elapsed ms to
  stdout. Use with `xcrun simctl launch --console-pty` for CI smoke
  tests and local benchmarking.
- `-EDGEPROBE_SIM_COREML` — simulator only. Opts into the real CoreML
  LLM path instead of the default stub. Currently surfaces the
  zero-logit failure as a thrown error on the first generate; useful
  for verifying Apple-side fixes or swapping in a different model.
