# VoiceProbe — EdgeProbe reference demo

A one-screen SwiftUI app that runs a real voice turn on-device and
instruments every stage with EdgeProbe. Hold the mic. Talk. The model
answers. Open the dashboard. Watch the waterfall.

```
mic ──► SFSpeechRecognizer ──► <LLM backend> ──► AVSpeech ──► your ears
        │                      │                 │
        └── EdgeProbe.trace(.asr) ─ .trace(.llm) ─ .trace(.tts) ──┘
                         one traceId across all three
```

## The three LLM paths

VoiceProbe picks an LLM backend at startup based on the environment and
launch args. All three produce the same trace shape — ASR + LLM + TTS
spans sharing one traceId — so the dashboard and SDK pipeline look
identical regardless of which backend is live.

| Environment                          | Backend       | `modelName` (in `gen_ai.request.model`)    | Size    | First-launch I/O              |
|--------------------------------------|---------------|--------------------------------------------|---------|-------------------------------|
| Device (iPhone)                      | MLX-Swift     | `llama-3.2-1b-instruct-4bit-mlx`           | ~700 MB | HuggingFace Hub download      |
| Simulator, **default**               | Deterministic stub | `stub-sim-llm`                        | 0       | None — pure in-process        |
| Simulator, `-EDGEPROBE_SIM_COREML`   | CoreML        | `coreml-smollm2-360m-instruct-4bit`        | ~210 MB | HuggingFace Hub download      |

The dashboard can filter on `gen_ai.request.model`, so a mixed bench run
produces three distinct rows — no accidental apples-to-oranges.

### Why the split

MLX-Swift needs Metal-for-compute. The iOS simulator doesn't expose it —
touch `MLX.GPU` and the process abort()s inside
`mlx::core::metal::Device::Device`. So simulator cannot use the same
engine as device, period.

The default simulator path is a deterministic stub: `load()` fakes a
~600 ms progress animation, `generate()` echoes a 60-char preview of the
prompt wrapped in a stable template (`SimulatorStubReply.swift`). Zero
network, zero weights, plausible LLM span latency (~600 ms) on the
dashboard. Good for UI dev, recorded demos, and CI smoke.

The opt-in simulator path (`-EDGEPROBE_SIM_COREML`) drives a real CoreML
SmolLM2-360M-Instruct against `MLModel` + `MLState` directly. It
currently surfaces an all-zero-logits bug on simulator CPU (see the
top-level `README.md` forensic write-up) and throws
`LLMError.inferenceFailed` on the first `generate()`. Kept in the tree
so a future Apple fix is one launch-arg away, not a revert.

## What you need

- macOS 14+ with Xcode 16+
- [`xcodegen`](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`)
- The EdgeProbe backend + web dashboard running locally:

  ```bash
  # in two separate terminals from the repo root
  cd backend && \
    SHARE_TOKEN_SECRET=$(openssl rand -hex 32) \
    DASHBOARD_KEYS='{"epk_dash_acme_test_0000000000000000":"org_acme"}' \
    bun run start                                                             # :3000

  cd web && \
    BACKEND_URL=http://127.0.0.1:3000 \
    ORG_BEARERS='{"org_acme":"epk_dash_acme_test_0000000000000000"}' \
    bun run start                                                             # :3001
  ```

  `DASHBOARD_KEYS` and `ORG_BEARERS` are mirror images — the backend
  matches bearer → orgId, the web process flips it to resolve
  `?org=foo` → bearer for the backend call. The default
  `EDGEPROBE_DASHBOARD_KEY` in `project.yml` matches the key above so a
  fresh clone works without extra config.

## Run it

```bash
cd ios/DemoApp
xcodegen generate                       # creates VoiceProbe.xcodeproj
open VoiceProbe.xcodeproj
```

Hit **Run**. What happens next depends on target:

- **Simulator (default):** the chip shows `Warming stub 10%…100%` over
  ~600 ms, then flips to `stub-sim-llm`. No download. Mic works.
  Replies are canned but the trace waterfall is real.
- **Simulator + `-EDGEPROBE_SIM_COREML`:** chip shows `Downloading
  X%` for the ~210 MB SmolLM2 pull, then the CoreML model loads and
  throws on first generate (zero-logit sim bug). Dev tool for
  exercising the CoreML code path or testing Apple fixes.
- **Device (iPhone 15 Pro or later):** chip shows `Downloading X%` for
  the ~700 MB Llama-3.2 pull, then flips to
  `llama-3.2-1b-instruct-4bit-mlx`. Subsequent launches hit the cache.

**Simulator vs device network:** the simulator can hit `127.0.0.1:3000`
directly because it shares the Mac's network namespace. On a real device
on the same Wi-Fi, pass your Mac's LAN IP:

```bash
EDGEPROBE_BACKEND_URL="http://192.168.1.42:3000" \
EDGEPROBE_WEB_URL="http://192.168.1.42:3001" \
  xcodegen generate
```

The `project.yml` already allows cleartext loopback via
`NSAllowsLocalNetworking`. If you want to talk to a LAN IP (not
`127.0.0.1`), widen ATS — see Apple's docs for `NSAppTransportSecurity`.

## What to try

1. Tap **Load model** (or just wait if `-EDGEPROBE_AUTOLOAD` is set).
   Chip transitions through progress → `Ready` (device/sim-CoreML) or
   `Warming stub 10%…100%` → `stub-sim-llm` (sim default).
2. Hold the mic. Ask something short ("what's the weather on Mars").
3. Release. ASR finalizes, the LLM answers (or stub-echoes), the phone
   speaks.
4. Three timing chips appear — `ASR 320ms · LLM 980ms · TTS 210ms` on
   device; `ASR 320ms · LLM 600ms · TTS 210ms` on sim stub.
5. Tap **Create share link**. The app calls
   `POST /app/trace/:id/share` and surfaces the `/r/<token>` URL in the
   system share sheet.
6. Open that URL on your laptop — the waterfall renders with no prompt
   text (public surface), just timings. Drop it into a Slack DM and
   the unfurl shows the OG card.
7. Open `http://127.0.0.1:3001/app/trace/<traceId>?org=org_acme` on
   your laptop — same waterfall **plus** the Captured content block:
   your transcript, the prompt, the completion. That's the authed view.

## Dev ergonomics — launch args

Off by default. All wired in `ContentView.task {}`.

- **`-EDGEPROBE_AUTOLOAD 1`** — fires `llm.load()` on `.task` entry,
  in parallel with the mic/speech permission dialogs. Needed because
  the simulator can't accept synthetic taps without Input Monitoring
  TCC. Faster dev loop too.
- **`-EDGEPROBE_AUTOGENERATE "<prompt>"`** — after autoload succeeds,
  runs one `llm.generate(prompt)` and prints the reply + elapsed ms to
  stdout. Use with `xcrun simctl launch --console-pty` for CI smoke
  and local benchmarking. `print()` not `OSLog` — the console pty
  capture doesn't pick up OSLog output.
- **`-EDGEPROBE_SIM_COREML`** — simulator only. Opts into the real
  CoreML SmolLM2 LLM path instead of the default stub. Currently
  surfaces the zero-logit failure as a thrown error on the first
  generate; useful for verifying Apple-side fixes or swapping in a
  different model (see class doc on `LLMService` for the swap points).

### The stub reply contract

The default sim path's reply text is pinned by
`SimulatorStubReply.text(for:)`. `scripts/voiceprobe-stub-smoke.sh`
compiles that file against a driver that asserts on the canonical
output for `"hello"` — it's checked in CI so the stub text can't
silently drift. If you need to change the format, the smoke script's
golden string has to move with it.

For `"hello"` the reply is exactly:

```
Got it: "hello". (Simulator stub — real on-device inference runs on a physical iPhone.)
```

For empty / whitespace-only input the reply collapses to:

```
Simulator stub — real on-device inference runs on a physical iPhone.
```

## Wire format

Every turn produces one `IngestPayload` with three spans, all sharing
one traceId. The `span.kind` is `asr` / `llm` / `tts` so the
dashboard's hero-metric tiles can sum them correctly (ASR ms / LLM ms
/ Spans). Content (`transcriptText`, `promptText`, `completionText`)
is only included when `span.includeContent = true`, which
`VoiceTurnController` sets on each stage.

That opt-in ships **on the wire** — if `includeContent: false`, the
SDK drops the content before it hits `URLSession`. Flip it off for
one span in `VoiceTurnController.runTurn` and confirm the backend
dashboard's Captured content block disappears for that span while
timings stay.

## Why this particular stack

- **SFSpeechRecognizer on-device**: zero extra dependency, ~15 MB
  model baked into the OS, en-US is solid since iOS 16. Whisper.cpp
  would be a better transcript but more setup and off-topic for the
  EdgeProbe demo.
- **MLX-Swift-Examples `MLXLLM`** (device): the Swift idiom for
  on-device LLMs in 2026. Hooks into HuggingFace via `Hub`, handles
  tokenizer + weights.
- **Llama-3.2-1B-Instruct-4bit** (device): small enough for
  on-device, instruct-tuned so replies stay voice-friendly with a
  one-line system prompt.
- **Simulator stub** (default): no model downloads, deterministic
  reply text, ~600 ms synthetic latency. The demo's whole point isn't
  model quality — it's showing EdgeProbe captures real on-device
  behavior. The stub still exercises the SDK's full span pipeline.
- **SmolLM2-360M-Instruct-4bit** (simulator, CoreML, opt-in): a real
  small model that would be CI-benchmarkable if the simulator CPU
  backend weren't returning all-zero logits. Kept in the tree behind
  a launch arg for the day Apple fixes it.
- **AVSpeechSynthesizer**: the phone can already talk. No reason to
  download a TTS model for a demo.

## When MLX's API drifts

`mlx-swift-examples` ships frequently and the public API for LLM
loading / generation has shifted a few times. If `LLMService.swift`
fails to build after a package update:

1. Open the Swift Package Manager view in Xcode (Packages → mlx-swift-examples).
2. Look at `MLXLLM/ModelFactory.swift` and `MLXLMCommon/Generate.swift`
   for the current `loadContainer` / `generate` call shapes.
3. Two call sites to patch in `LLMService.swift`:
   - `LLMModelFactory.shared.loadContainer(configuration:)` — the
     progress callback signature or the `ModelConfiguration` init may
     have drifted.
   - `MLXLMCommon.generate(input:parameters:context:)` — the closure
     return type (`.more` vs something else) and
     `context.tokenizer.decode` name.

The SDK side (`EdgeProbe.beginTrace` + `turn.span(...)`) doesn't care
about any of that — replace the two MLX calls and the trace will keep
shape.

## What this demo does not prove

- **Ingest key verification** on edge builds: `/ingest` is now
  bearer-verified against the `api_keys` table (Slice 5), but the
  device's embedded `epk_pub_demo_voiceprobe` still assumes the org
  is live on the backend. A fresh backend needs the key minted via
  `POST /app/keys` or the default dev fixture before VoiceProbe's
  spans land.
- **Network resilience**: `HTTPSpanExporter` has no retries yet; a
  dead backend logs an error and drops the span. The RingBuffer +
  BatchSpanProcessor behind the exporter handle drop-oldest, but the
  exporter itself is single-shot. See
  `ios/Sources/EdgeProbe/BatchSpanProcessor.swift`.
- **Multi-turn context**: the demo treats each hold-and-release as an
  independent turn. No conversation memory; the LLM sees only the
  current transcript plus the system prompt.
