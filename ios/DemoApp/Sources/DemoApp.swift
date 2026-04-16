import SwiftUI
import EdgeProbe

/// VoiceProbe — the reference demo that proves EdgeProbe instruments a
/// real on-device voice turn (ASR → LLM → TTS) and surfaces the trace
/// in the dashboard.
///
/// Flow:
///   1. Tap the mic, talk.
///   2. SFSpeechRecognizer transcribes on-device.
///   3. MLX-Swift runs Llama-3.2-1B-Instruct-4bit locally and generates a reply.
///   4. AVSpeechSynthesizer speaks the reply.
///   5. EdgeProbe.beginTrace() wraps all three stages in one trace;
///      end() fires one POST /ingest to the local backend.
///   6. A "share" button mints a public URL so you can drop the trace
///      into a DM and watch the unfurl render the waterfall.
///
/// This is the first time all the pieces of the product sit together in
/// one place. When the dashboard renders your turn with ASR=320ms,
/// LLM=980ms, TTS=210ms — that's the pitch.
@main
struct VoiceProbeApp: App {
    init() {
        // The SDK is idempotent; safe even if SwiftUI re-inits the App.
        // Pointing at the local backend by default (see Config.swift).
        EdgeProbe.start(
            apiKey: Config.apiKey,
            endpoint: Config.backendURL.appendingPathComponent("ingest"),
            orgId: Config.orgId,
            projectId: Config.projectId
        )
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .preferredColorScheme(.dark)
        }
    }
}
