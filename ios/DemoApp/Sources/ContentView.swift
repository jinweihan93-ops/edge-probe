import SwiftUI

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
            permissionGranted = await ASRService.requestPermissions()
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
                Text("Downloading \(Int(llm.loadProgress * 100))%")
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
