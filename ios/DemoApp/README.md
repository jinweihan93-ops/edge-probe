# VoiceProbe — EdgeProbe reference demo

A one-screen SwiftUI app that runs a real voice turn entirely on-device and
instruments every stage with EdgeProbe. Hold the mic. Talk. Llama answers.
Open the dashboard. Watch the waterfall.

```
mic ──► SFSpeechRecognizer ──► Llama-3.2-1B-Instruct-4bit (MLX) ──► AVSpeech ──► your ears
        │                      │                                   │
        └── EdgeProbe.trace(.asr) ─ .trace(.llm) ─ .trace(.tts) ──┘
                         one traceId across all three
```

## What you need

- macOS 14+ with Xcode 16+
- [`xcodegen`](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`)
- The EdgeProbe backend + web dashboard running locally:

  ```bash
  # in two separate terminals from the repo root
  cd backend && SHARE_TOKEN_SECRET=$(openssl rand -hex 32) bun run start      # :3000
  cd web     && BACKEND_URL=http://127.0.0.1:3000 bun run start               # :3001
  ```

## Run it

```bash
cd ios/DemoApp
xcodegen generate                       # creates VoiceProbe.xcodeproj
open VoiceProbe.xcodeproj
```

Hit **Run** on an iPhone 15 Pro (or later) simulator or device. First
launch downloads ~700 MB of Llama weights from HuggingFace into the app
container — watch the "Downloading X%" chip. Subsequent launches are instant.

**Simulator vs device:** the simulator can hit `127.0.0.1:3000` directly
because it shares the Mac's network namespace. On a real device on the same
Wi-Fi, pass your Mac's LAN IP:

```bash
EDGEPROBE_BACKEND_URL="http://192.168.1.42:3000" \
EDGEPROBE_WEB_URL="http://192.168.1.42:3001" \
  xcodegen generate
```

The `project.yml` already allows cleartext loopback via
`NSAllowsLocalNetworking`. If you want to talk to a LAN IP (not `127.0.0.1`),
you'll need to widen ATS — see Apple's docs for `NSAppTransportSecurity`.

## What to try

1. Tap **Load model**. Wait for the download chip to say Ready.
2. Hold the mic. Ask something short ("what's the weather on Mars").
3. Release. ASR finalizes, Llama answers, the phone speaks.
4. You'll see the three timing chips — `ASR 320ms · LLM 980ms · TTS 210ms`.
5. Tap **Create share link**. The app calls `POST /app/trace/:id/share`
   and surfaces the `/r/<token>` URL in the system share sheet.
6. Open that URL on your laptop — the waterfall renders with no prompt
   text (public surface), just timings. Drop it into a Slack DM and the
   unfurl shows the OG card.
7. Open `http://127.0.0.1:3001/app/trace/<traceId>?org=org_acme` on your
   laptop — same waterfall **plus** the Captured content block: your
   transcript, the prompt, the completion. That's the authed view.

## Wire format

Every turn produces one `IngestPayload` with three spans, all sharing one
traceId. The `span.kind` is `asr` / `llm` / `tts` so the dashboard's
hero-metric tiles can sum them correctly (ASR ms / LLM ms / Spans).
Content (`transcriptText`, `promptText`, `completionText`) is only
included when `span.includeContent = true`, which the VoiceTurnController
sets on each stage.

That opt-in ships **on the wire** — if `includeContent: false`, the SDK
drops the content before it hits `URLSession`. Flip it off for one span
in `VoiceTurnController.runTurn` and confirm the backend dashboard's
Captured content block disappears for that span while timings stay.

## Why this particular stack

- **SFSpeechRecognizer on-device**: zero extra dependency, ~15 MB model
  baked into the OS, en-US is solid since iOS 16. Whisper.cpp would be
  a better transcript but more setup and off-topic for the EdgeProbe demo.
- **MLX-Swift-Examples `MLXLLM`**: the Swift idiom for on-device LLMs in
  2026. Hooks into HuggingFace via `Hub`, handles tokenizer + weights.
- **Llama-3.2-1B-Instruct-4bit**: small enough for on-device, instruct-tuned
  so replies stay voice-friendly with a one-line system prompt.
- **AVSpeechSynthesizer**: the phone can already talk. No reason to
  download a TTS model for a demo.

## When MLX's API drifts

`mlx-swift-examples` ships frequently and the public API for LLM loading /
generation has shifted a few times. If `LLMService.swift` fails to build
after a package update:

1. Open the Swift Package Manager view in Xcode (Packages → mlx-swift-examples).
2. Look at `MLXLLM/ModelFactory.swift` and `MLXLMCommon/Generate.swift` for
   the current `loadContainer` / `generate` call shapes.
3. Two call sites to patch in `LLMService.swift`:
   - `LLMModelFactory.shared.loadContainer(configuration:)` — the progress
     callback signature or the `ModelConfiguration` init may have drifted.
   - `MLXLMCommon.generate(input:parameters:context:)` — the closure return
     type (`.more` vs something else) and `context.tokenizer.decode` name.

The SDK side (`EdgeProbe.beginTrace` + `turn.span(...)`) doesn't care about
any of that — replace the two MLX calls and the trace will keep shape.

## What this demo does not prove

- **API key auth**: the backend still accepts any `epk_pub_*` string.
  The next slice on `main` closes that hole.
- **Network resilience**: `HTTPSpanExporter` has no retries yet; a dead
  backend logs an error and drops the span. The RingBuffer + BatchSpanProcessor
  behind the exporter handle drop-oldest, but the exporter itself is
  single-shot. See `ios/Sources/EdgeProbe/BatchSpanProcessor.swift`.
- **Multi-turn context**: the demo treats each hold-and-release as an
  independent turn. No conversation memory; the LLM sees only the current
  transcript plus the system prompt.
