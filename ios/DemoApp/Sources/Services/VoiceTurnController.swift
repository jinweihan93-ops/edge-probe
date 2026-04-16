import Foundation
import EdgeProbe

/// Orchestrates one voice turn and wraps it in `EdgeProbe.beginTrace()`.
///
/// This is the one place in the app where all three services meet. It's
/// also the only place that knows about spans; ASRService, LLMService,
/// and TTSService are SDK-agnostic. If you want to understand how the
/// product is instrumented in ~30 lines, read `runTurn(audioPrompt:)`.
///
/// Trace shape emitted per turn (spans in order):
///   • asr  — "whisper"       includeContent:true, transcriptText set
///   • llm  — "llama-decode"  includeContent:true, prompt + completion set
///   • tts  — "say"           includeContent:true, transcriptText = reply
///
/// End of turn → one POST /ingest with one trace, three spans. Open
/// /app/trace/:id?org=org_acme in the dashboard and you see the
/// waterfall for the whole turn.
@MainActor
final class VoiceTurnController: ObservableObject {

    struct TurnResult: Equatable {
        let traceId: String
        let transcript: String
        let reply: String
        let asrMs: Int
        let llmMs: Int
        let ttsMs: Int
        var totalMs: Int { asrMs + llmMs + ttsMs }
    }

    @Published private(set) var lastTurn: TurnResult?
    @Published private(set) var error: String?

    private let asr: ASRService
    private let llm: LLMService
    private let tts: TTSService

    init(asr: ASRService, llm: LLMService, tts: TTSService) {
        self.asr = asr
        self.llm = llm
        self.tts = tts
    }

    /// `audioPrompt` is a thunk the caller runs between start-recording and
    /// stop-recording. In the UI it corresponds to "the user holds the mic
    /// button and talks". The ASRService streams partials while it's active;
    /// the thunk decides when to release (tap up, silence timeout, etc).
    ///
    /// `@escaping` because the span closure that wraps the ASR stage is
    /// escaping (Swift 6 needs `@escaping @Sendable` for the `sending`-style
    /// closure into the SDK), and that closure captures `hold`.
    func runTurn(whileRecording hold: @escaping () async -> Void) async {
        error = nil
        let turn = EdgeProbe.beginTrace(
            attributes: ["turn.source": .string("voiceprobe-demo")],
            sensitive: false
        )

        var asrMs = 0, llmMs = 0, ttsMs = 0
        var transcript = ""
        var reply = ""

        do {
            // ASR
            //
            // `@MainActor` on each span closure keeps it isolated to the main
            // actor when it runs back through the SDK. Without this, the
            // closure is sent into a nonisolated executor and `self.asr.start()`
            // (a @MainActor method) won't compile. The SDK's `sending` on the
            // parameter transfers ownership; @MainActor preserves isolation.
            let asrStart = Date()
            transcript = try await turn.span(.asr, name: "whisper", includeContent: true) { @MainActor reporter in
                try self.asr.start()
                await hold()
                let final = try await self.asr.stop()
                reporter.transcriptText = final
                reporter.setAttribute("asr.engine", .string("sf-speech-on-device"))
                return final
            }
            asrMs = Int(Date().timeIntervalSince(asrStart) * 1000)

            // LLM
            let llmStart = Date()
            reply = try await turn.span(.llm, name: "llama-decode", includeContent: true) { @MainActor reporter in
                reporter.promptText = transcript
                reporter.setAttribute("gen_ai.request.model", .string("llama-3.2-1B-Instruct-4bit"))
                let out = try await self.llm.generate(transcript)
                reporter.completionText = out
                return out
            }
            llmMs = Int(Date().timeIntervalSince(llmStart) * 1000)

            // TTS
            let ttsStart = Date()
            await turn.span(.tts, name: "say", includeContent: true) { @MainActor reporter in
                reporter.transcriptText = reply
                reporter.setAttribute("tts.engine", .string("av-speech-synth"))
                await self.tts.speak(reply)
            }
            ttsMs = Int(Date().timeIntervalSince(ttsStart) * 1000)

        } catch {
            // Whatever blew up, the TraceHandle's spans so far are still
            // captured (failed spans included, status=error). end() below
            // flushes what we have. The user gets a message via `self.error`.
            self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            turn.end()
            return
        }

        turn.end()
        lastTurn = TurnResult(
            traceId: turn.id,
            transcript: transcript,
            reply: reply,
            asrMs: asrMs,
            llmMs: llmMs,
            ttsMs: ttsMs
        )
    }

    /// Mint a public share URL for the most recent turn by calling the
    /// backend's /app/trace/:id/share. Auth is a bearer that maps to the
    /// org server-side — the device doesn't self-assert an orgId anymore.
    /// Returns the full `/r/<token>` URL or nil if the call fails — kept
    /// out of the trace path so a dead backend can't block the UI.
    ///
    /// `201 Created` is the success contract from the backend; the previous
    /// code checked for 200, which was never actually returned. Harmless
    /// when paired with the old auth (both branches 401'd or succeeded),
    /// but worth fixing now that the wire is tightening up.
    func shareLastTurn() async -> URL? {
        guard let last = lastTurn else { return nil }
        var req = URLRequest(url: Config.backendURL
            .appendingPathComponent("app")
            .appendingPathComponent("trace")
            .appendingPathComponent(last.traceId)
            .appendingPathComponent("share")
        )
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(Config.dashboardKey)", forHTTPHeaderField: "Authorization")
        req.httpBody = Data("{}".utf8)

        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              let http = resp as? HTTPURLResponse, http.statusCode == 201,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = json["token"] as? String else {
            return nil
        }
        return Config.webURL.appendingPathComponent("r").appendingPathComponent(token)
    }
}
