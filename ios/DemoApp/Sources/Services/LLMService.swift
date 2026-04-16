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
    /// shows up verbatim in the dashboard. Matches HuggingFace id.
    @Published private(set) var modelName: String = "Llama-3.2-1B-Instruct-4bit"

    /// MLX-Swift's container holds the weights + tokenizer + processor and
    /// is `Sendable`-safe for `perform { context in ... }` calls.
    private var container: ModelContainer?

    /// Fetch + load the model. Idempotent: subsequent calls are no-ops.
    func load() async throws {
        if isLoaded { return }

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

        self.container = try await LLMModelFactory.shared.loadContainer(
            configuration: config
        ) { [weak self] progress in
            Task { @MainActor [weak self] in
                self?.loadProgress = progress.fractionCompleted
            }
        }
        self.isLoaded = true
        self.loadProgress = 1.0
    }

    /// Generate a reply to `prompt`. Greedy-ish sampling, capped at 128 tokens,
    /// which keeps replies voice-friendly. Returns the full decoded string;
    /// streaming partials to UI could come later but isn't the demo's job.
    func generate(_ prompt: String) async throws -> String {
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
    }
}
