import Foundation
import MLX
import MLXLLM
import MLXLMCommon

/// On-device LLM inference via MLX-Swift-Examples.
///
/// Model: `mlx-community/Llama-3.2-1B-Instruct-4bit` (~700 MB). On first
/// launch the model weights are fetched from HuggingFace by `Hub` (a
/// dependency of MLX-Swift-Examples) and cached inside the app container.
/// Every subsequent launch is instant.
///
/// Why this model:
///   • 1B params at Q4 fits in memory on an iPhone 15 Pro with room to spare.
///   • Instruct-tuned → follows a one-sentence system prompt cleanly, which
///     makes the demo reply like a voice assistant without prompt engineering.
///   • MLX-Swift serves it fast enough that `EdgeProbe.trace(.llm)` will
///     show a real, respectable duration (~500-1000ms per reply on A17 Pro).
///
/// Public API kept lean so a single `generate(_ prompt:)` call slots
/// cleanly into `turn.span(.llm)`.
@MainActor
final class LLMService: ObservableObject {

    enum LLMError: Error, LocalizedError {
        case modelNotLoaded
        case inferenceFailed(String)

        var errorDescription: String? {
            switch self {
            case .modelNotLoaded:
                return "Llama isn't loaded. Tap \"Load model\" and wait for the first-launch download (~700 MB)."
            case .inferenceFailed(let m):
                return "Inference failed: \(m)"
            }
        }
    }

    /// `0...1` while fetching weights from HuggingFace on first launch,
    /// then `1` once `container` is live. Bound to the UI so the user
    /// sees a real progress bar — a 700 MB silent download is a bad UX.
    @Published private(set) var loadProgress: Double = 0

    @Published private(set) var isLoaded: Bool = false

    /// Written into the trace's span attributes so `gen_ai.request.model`
    /// shows up verbatim in the dashboard. On simulator we swap in a stub
    /// model name so nobody reads a trace and thinks they were looking at
    /// real Llama output when they weren't.
    #if targetEnvironment(simulator)
    @Published private(set) var modelName: String = "stub-on-simulator"
    #else
    @Published private(set) var modelName: String = "Llama-3.2-1B-Instruct-4bit"
    #endif

    /// MLX-Swift's container holds the weights + tokenizer + processor and
    /// is `Sendable`-safe for `perform { context in ... }` calls.
    private var container: ModelContainer?

    /// Fetch + load the model. Idempotent: subsequent calls are no-ops.
    ///
    /// Simulator note: MLX's Metal allocator `abort()`s on iOS simulator
    /// because Metal-for-compute isn't plumbed through. Instead of
    /// crashing (SIGABRT in `mlx::core::metal::Device::Device`), we fake
    /// a load so the rest of the voice-turn pipeline — ASR, span
    /// instrumentation, TTS, share — still runs and exercises the
    /// EdgeProbe dashboard end-to-end. Real-device builds use MLX for
    /// real. See generate() below for the matching stub responder.
    func load() async throws {
        if isLoaded { return }

        #if targetEnvironment(simulator)
        // Fake a quick "download" so the UI progress bar shows something
        // believable and the "Ready" state flips naturally.
        for step in stride(from: 0.0, to: 1.0, by: 0.1) {
            self.loadProgress = step
            try? await Task.sleep(nanoseconds: 40_000_000) // 40 ms
        }
        self.loadProgress = 1.0
        self.isLoaded = true
        return
        #else
        // Tight memory budget for a 1B model on iPhone; MLX examples default
        // is fine but making it explicit is good discipline on device.
        MLX.GPU.set(cacheLimit: 128 * 1024 * 1024)

        // Reference the model by its HuggingFace id rather than the
        // `LLMRegistry.*` convenience constant. This keeps the code
        // resilient across mlx-swift-examples API iterations — the
        // registry names have drifted a few times; the HF id hasn't.
        let config = ModelConfiguration(
            id: "mlx-community/Llama-3.2-1B-Instruct-4bit",
            overrideTokenizer: nil,
            defaultPrompt: "You are a concise voice assistant. Reply in one or two short sentences."
        )

        // `@Sendable` so the progress callback isn't inferred @MainActor
        // from this enclosing class — MLX calls it on its own loader
        // thread, same MainActor-vs-background crash class as the audio
        // tap in ASRService. The body already hops to MainActor before
        // mutating @Published state.
        self.container = try await LLMModelFactory.shared.loadContainer(
            configuration: config
        ) { @Sendable [weak self] progress in
            Task { @MainActor [weak self] in
                self?.loadProgress = progress.fractionCompleted
            }
        }
        self.isLoaded = true
        self.loadProgress = 1.0
        #endif
    }

    /// Generate a reply to `prompt`. Greedy-ish sampling, capped at 128 tokens,
    /// which keeps replies voice-friendly. Returns the full decoded string;
    /// streaming partials to UI could come later but isn't the demo's job.
    ///
    /// Simulator: returns a canned sentence with a small artificial delay
    /// so the LLM span in the trace has a visible, non-zero duration that
    /// the dashboard waterfall can draw. Honest stand-in — matches
    /// `modelName = "stub-on-simulator"` above.
    func generate(_ prompt: String) async throws -> String {
        #if targetEnvironment(simulator)
        guard isLoaded else { throw LLMError.modelNotLoaded }
        // ~600 ms: similar order of magnitude to what 1B Llama takes on an
        // A17 Pro, so the LLM tile in the dashboard shows a realistic slice.
        try? await Task.sleep(nanoseconds: 600_000_000)
        let preview = prompt.prefix(80)
        return "(simulator stub) You said: \"\(preview)\". On a real device this reply comes from on-device Llama."
        #else
        guard let container else {
            throw LLMError.modelNotLoaded
        }

        do {
            let reply: String = try await container.perform { context in
                let userInput = UserInput(
                    messages: [
                        [
                            "role": "system",
                            "content": "You are a concise voice assistant. Reply in one or two short sentences."
                        ],
                        [
                            "role": "user",
                            "content": prompt
                        ]
                    ]
                )
                let lmInput = try await context.processor.prepare(input: userInput)
                let params = GenerateParameters(
                    maxTokens: 128,
                    temperature: 0.6,
                    topP: 0.9
                )

                var accumulated = ""
                _ = try MLXLMCommon.generate(
                    input: lmInput,
                    parameters: params,
                    context: context
                ) { tokens in
                    // Decode the running token buffer each step so `accumulated`
                    // tracks the final string when `.stop` fires.
                    let text = context.tokenizer.decode(tokens: tokens)
                    accumulated = text
                    return .more
                }
                return accumulated
            }
            return reply.trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            throw LLMError.inferenceFailed(error.localizedDescription)
        }
        #endif
    }
}
