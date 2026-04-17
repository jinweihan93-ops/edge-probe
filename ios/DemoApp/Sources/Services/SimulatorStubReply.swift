import Foundation

/// Deterministic reply text for the VoiceProbe simulator stub LLM path.
///
/// This is intentionally carved out of `LLMService.swift` as a pure
/// function with **no** platform guards, no dependencies beyond
/// `Foundation`, and no async surface. It's the one piece of LLMService
/// that a smoke test can exercise directly without booting a simulator
/// or linking MLX / swift-transformers.
///
/// The simulator default LLM path (`-EDGEPROBE_SIM_COREML` off) uses
/// `generateSimulatorStub` in LLMService, which composes a 600ms fake
/// latency via `Task.sleep` and then delegates to `text(for:)` below
/// to produce the reply.
///
/// ## Stability contract
///
/// The strings below are a **stable textual output** per `docs/SLICES.md`
/// §Slice 10 "Done" — the CI smoke (`scripts/voiceprobe-stub-smoke.sh`)
/// compiles this exact file against a driver that asserts on the output
/// for `"hello"`. If you change the format you MUST update:
///   1. The golden string in `scripts/voiceprobe-stub-smoke.sh`.
///   2. `ios/DemoApp/README.md` "What to try" notes on the stub path.
///   3. Any dashboard fixtures that mention the stub reply (grep for
///      `Simulator stub —`).
///
/// The preview-truncation rule (60 chars) is load-bearing: the whole
/// reply has to fit on a single voice-output line so `AVSpeechSynthesizer`
/// doesn't pause awkwardly. Lengthening it past ~90 chars total makes
/// the spoken reply feel sluggish in demo recordings.
enum SimulatorStubReply {

    /// Truncate whitespace-trimmed `prompt` at 60 chars (adding `…`),
    /// then wrap in the stub echo template. Empty / whitespace-only
    /// prompts return the bare disclaimer string.
    ///
    /// Deterministic: same input in, same string out, byte-for-byte.
    /// The smoke test relies on that.
    static func text(for prompt: String) -> String {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let preview = trimmed.count > 60
            ? String(trimmed.prefix(60)) + "…"
            : trimmed
        if preview.isEmpty {
            return "Simulator stub — real on-device inference runs on a physical iPhone."
        }
        return "Got it: \"\(preview)\". (Simulator stub — real on-device inference runs on a physical iPhone.)"
    }
}
