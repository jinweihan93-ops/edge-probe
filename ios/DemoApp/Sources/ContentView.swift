import SwiftUI
import OSLog

private let uiLog = Logger(subsystem: "dev.edgeprobe.demo.VoiceProbe", category: "ContentView")

/// The whole app UI. One screen:
///   • Model status chip ("Load model" → progress → "Ready")
///   • Big mic button (hold to talk)
///   • Live partial transcript while recording
///   • After the turn: transcript + reply + timing chips for each stage
///   • Share button → opens /r/<token> in Safari
///
/// Design-parity note: this deliberately mirrors the dashboard's visual
/// vocabulary (same signal colors, same chip pattern) so the demo feels
/// like one product from phone to web.
struct ContentView: View {

    @StateObject private var asr = ASRService()
    @StateObject private var llm = LLMService()
    @StateObject private var tts = TTSService()
    @StateObject private var controller: VoiceTurnController

    @State private var isHolding: Bool = false
    @State private var holdContinuation: CheckedContinuation<Void, Never>?
    @State private var permissionGranted: Bool = false
    @State private var shareURL: URL?

    init() {
        let asr = ASRService()
        let llm = LLMService()
        let tts = TTSService()
        _asr = StateObject(wrappedValue: asr)
        _llm = StateObject(wrappedValue: llm)
        _tts = StateObject(wrappedValue: tts)
        _controller = StateObject(wrappedValue: VoiceTurnController(asr: asr, llm: llm, tts: tts))
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            VStack(spacing: 32) {
                header
                Spacer()
                turnOutput
                Spacer()
                micButton
                    .disabled(!llm.isLoaded || !permissionGranted)
                    .opacity(llm.isLoaded && permissionGranted ? 1 : 0.4)
                footer
            }
            .padding(24)
            .foregroundStyle(.white)
        }
        .task {
            // Dev ergonomic: `-EDGEPROBE_AUTOLOAD 1` on the launch arg list
            // kicks off load() immediately, in parallel with the
            // permissions prompt. We use this for:
            //   • Simulator smoke tests (Claude/CI doesn't have a reliable
            //     way to post synthetic taps into the Simulator window —
            //     CGEventPost without Input Monitoring entitlement gets
            //     filtered, so the model-load path is otherwise
            //     unreachable without a launch-arg hook).
            //   • Faster dev loop when you're iterating on the model.
            // Fires *before* the await on permissions so it can run
            // concurrently with the mic/speech dialogs — we don't need
            // either permission to download weights or load a CoreML
            // model. Not a user-facing feature. Leave the button path
            // intact so normal users still see a "start when ready"
            // affordance.
            let args = ProcessInfo.processInfo.arguments
            uiLog.info("launch args: \(args.joined(separator: " "), privacy: .public)")
            if args.contains("-EDGEPROBE_AUTOLOAD") {
                uiLog.info("auto-load flag set, firing llm.load()")
                Task {
                    do {
                        try await llm.load()

                        // Dev-only: `-EDGEPROBE_AUTOGENERATE "<prompt>"`
                        // runs one synthetic turn through the LLM after
                        // load completes, so we can CI-verify generation
                        // without needing to tap-and-hold the mic (which
                        // is blocked on macOS Input Monitoring TCC in
                        // sim). Prints the generated text + elapsed ms
                        // to stdout so `xcrun simctl launch --console-pty`
                        // can assert on it — OSLog isn't visible through
                        // the pty capture, so `print` is load-bearing
                        // here, not debug residue.
                        if let idx = args.firstIndex(of: "-EDGEPROBE_AUTOGENERATE"),
                           idx + 1 < args.count {
                            let prompt = args[idx + 1]
                            print("[VP] AUTOGENERATE prompt=\(prompt.debugDescription)")
                            let t0 = Date()
                            do {
                                let reply = try await llm.generate(prompt)
                                let ms = Int(Date().timeIntervalSince(t0) * 1000)
                                print("[VP] AUTOGENERATE reply (\(ms)ms): \(reply.debugDescription)")
                            } catch {
                                print("[VP] AUTOGENERATE threw: \(error)")
                            }
                        }
                    } catch {
                        print("[VP] AUTOLOAD llm.load() threw: \(error)")
                    }
                }
            }
            permissionGranted = await ASRService.requestPermissions()
            uiLog.info("permissions granted: \(permissionGranted, privacy: .public)")
        }
    }

    // MARK: - sections

    private var header: some View {
        VStack(spacing: 8) {
            Text("VoiceProbe")
                .font(.system(size: 34, weight: .semibold))
            Text("EdgeProbe reference demo · on-device Llama")
                .font(.footnote)
                .foregroundStyle(.white.opacity(0.6))
            modelChip
        }
    }

    private var modelChip: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(llm.isLoaded ? Color.green : Color.orange)
                .frame(width: 8, height: 8)
            if llm.isLoaded {
                Text(llm.modelName).font(.caption).monospaced()
            } else if llm.loadProgress > 0 {
                // Different verb per path — the sim stub's "load" is a
                // 600ms UI animation with no bytes on the wire, so calling
                // it "Downloading" would be a lie. Device MLX and sim
                // CoreML (opt-in) both hit HuggingFace for real weights.
                //
                // `modelName` is the simplest signal we have for "which
                // path is this?" — it's pre-seeded in LLMService before
                // load() runs, so it's correct from t=0. Keep this mapping
                // in sync with `LLMService.modelName` defaults.
                Text(loadProgressLabel)
                    .font(.caption).monospaced()
            } else {
                Button("Load model") {
                    Task { try? await llm.load() }
                }
                .font(.caption.bold())
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Capsule().fill(Color.white.opacity(0.08)))
    }

    /// Chip label during load. Honest per-path wording so the user can't
    /// mistake the 600ms sim-stub animation for a real download, and so
    /// the llama.cpp sim path makes clear that a real ~428 MB model is
    /// coming down rather than a CoreML snapshot.
    ///
    /// Strings must match `LLMService.modelName` assignments exactly:
    ///   • `stub-sim-llm`                          → sim stub
    ///   • `qwen2.5-0.5b-instruct-q4-llamacpp`     → sim llama.cpp (Slice 11)
    ///   • `llama-3.2-1b-instruct-4bit-mlx`        → device MLX
    ///   • (CoreML path doesn't rename — keeps the MLX default on sim)
    private var loadProgressLabel: String {
        let pct = Int(llm.loadProgress * 100)
        switch llm.modelName {
        case "stub-sim-llm":
            return "Warming stub \(pct)%"
        case "qwen2.5-0.5b-instruct-q4-llamacpp":
            // Qwen q4_0 GGUF is ~428 MB on first launch, cached after.
            // Loading is mostly network until ~95% then a short mmap
            // + vocab decode; fine to keep one shared label for both.
            return "Downloading Qwen GGUF \(pct)%"
        default:
            return "Downloading \(pct)%"
        }
    }

    private var turnOutput: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let err = controller.error {
                Text(err)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .padding()
                    .background(RoundedRectangle(cornerRadius: 10).fill(.red.opacity(0.1)))
            } else if asr.isRecording {
                VStack(alignment: .leading, spacing: 6) {
                    Text("LISTENING").font(.caption2).foregroundStyle(.white.opacity(0.6))
                    Text(asr.partialTranscript.isEmpty ? "…" : asr.partialTranscript)
                        .font(.title3)
                }
            } else if let turn = controller.lastTurn {
                VStack(alignment: .leading, spacing: 12) {
                    labelled("YOU", turn.transcript)
                    labelled("ASSISTANT", turn.reply)
                    timingRow(turn: turn)
                    if let url = shareURL {
                        ShareLink(item: url) {
                            Label("Share this trace", systemImage: "link")
                        }
                        .font(.callout)
                    } else {
                        Button {
                            Task { shareURL = await controller.shareLastTurn() }
                        } label: {
                            Label("Create share link", systemImage: "link")
                        }
                        .font(.callout)
                    }
                }
            } else {
                Text("Tap and hold to talk.")
                    .font(.callout)
                    .foregroundStyle(.white.opacity(0.5))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func labelled(_ label: String, _ body: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption2).foregroundStyle(.white.opacity(0.6))
            Text(body).font(.title3)
        }
    }

    private func timingRow(turn: VoiceTurnController.TurnResult) -> some View {
        HStack(spacing: 8) {
            timingChip("ASR", turn.asrMs)
            timingChip("LLM", turn.llmMs)
            timingChip("TTS", turn.ttsMs)
            Spacer()
            Text("\(turn.totalMs) ms").font(.caption.monospaced()).foregroundStyle(.white.opacity(0.6))
        }
    }

    private func timingChip(_ label: String, _ ms: Int) -> some View {
        HStack(spacing: 4) {
            Text(label).font(.caption2.bold())
            Text("\(ms)ms").font(.caption.monospaced())
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(Capsule().fill(Color.white.opacity(0.08)))
    }

    private var micButton: some View {
        Circle()
            .fill(asr.isRecording ? Color.red : Color.blue)
            .frame(width: 120, height: 120)
            .overlay(
                Image(systemName: asr.isRecording ? "waveform" : "mic.fill")
                    .font(.system(size: 44, weight: .semibold))
                    .foregroundStyle(.white)
            )
            .scaleEffect(isHolding ? 1.08 : 1.0)
            .animation(.spring(response: 0.2, dampingFraction: 0.6), value: isHolding)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        guard !isHolding else { return }
                        isHolding = true
                        shareURL = nil
                        Task { @MainActor in
                            await controller.runTurn { await self.waitForRelease() }
                        }
                    }
                    .onEnded { _ in
                        isHolding = false
                        holdContinuation?.resume()
                        holdContinuation = nil
                    }
            )
    }

    private func waitForRelease() async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            self.holdContinuation = c
        }
    }

    private var footer: some View {
        VStack(spacing: 4) {
            if !permissionGranted {
                Text("Microphone + Speech Recognition permissions required.")
                    .font(.caption2)
                    .foregroundStyle(.orange)
            }
            Text("Spans → \(Config.backendURL.absoluteString)")
                .font(.caption2.monospaced())
                .foregroundStyle(.white.opacity(0.4))
        }
    }
}

#Preview {
    ContentView()
        .preferredColorScheme(.dark)
}
