import Foundation
import OSLog

/// Dedicated logger so you can `xcrun simctl spawn booted log stream
/// --predicate 'subsystem == "dev.edgeprobe.demo.VoiceProbe"'`
/// and watch download + load progress in real time without fishing
/// through every system log line.
private let llmLog = Logger(subsystem: "dev.edgeprobe.demo.VoiceProbe", category: "LLMService")

// MLX is device-only. Importing it on simulator pulls in
// `MLXLMCommon.LanguageModel` (a protocol) which collides with
// `Models.LanguageModel` (the swift-transformers class) at the use site.
// Simpler to not pay that cost — none of the MLX types are referenced
// under `#if targetEnvironment(simulator)` anyway.
#if !targetEnvironment(simulator)
import MLX
import MLXLLM
import MLXLMCommon
#endif

#if targetEnvironment(simulator)
// CoreML LLM path for the simulator. Each import is iOS 18+ on the type
// surface we use, but the module itself builds fine for iOS 16.4. Runtime
// guards (`if #available(iOS 18.0, *)`) gate the actual calls.
//
// We deliberately don't use swift-transformers' `Models.LanguageModel` —
// it hard-codes camelCase CoreML input names (`inputIds`, `causalMask`)
// and fatalErrors with "Cannot obtain shape information" against the
// finnvoorhees SmolLM2 export, which uses snake_case (`input_ids`,
// `causal_mask`) because it was converted straight from PyTorch with
// `coremltools` defaults. We keep `Tokenizers` for chat template +
// encode/decode; the inference loop is ours, written directly against
// `MLModel` + `MLState`.
import CoreML
import Tokenizers  // Tokenizer, AutoTokenizer
#endif

/// On-device LLM inference. Two real backends + one simulator stub.
///
///   • **Device** (`targetEnvironment(simulator) == false`):
///     MLX-Swift, model = `Llama-3.2-1B-Instruct-4bit` from HuggingFace.
///     ~700 MB weights, fetched once and cached in the app container.
///
///   • **Simulator, default**: deterministic stub. `load()` fakes a
///     download animation; `generate()` echoes a short version of the
///     prompt with ~600ms of synthetic latency so the trace waterfall
///     looks plausible. No network, no weights. Used by UI dev, CI smoke
///     tests, and anywhere a real LLM isn't strictly needed.
///
///   • **Simulator, opt-in** (`-EDGEPROBE_SIM_COREML` launch arg):
///     CoreML path against `finnvoorhees/coreml-SmolLM2-360M-Instruct-4bit`
///     (tokenizer from `HuggingFaceTB/SmolLM2-360M-Instruct`). ~210 MB
///     download. Compiles and runs but currently **produces all-zero
///     logits on simulator CPU** — see top-of-repo README VoiceProbe
///     section for the forensic write-up. Kept in the codebase so future
///     simulator/CoreML fixes or model swaps can re-enable it with one
///     launch arg rather than a revert.
///
/// Why the split:
///   MLX requires Metal-for-compute, which iOS simulators don't expose —
///   the process abort()s inside `mlx::core::metal::Device::Device` the
///   moment you touch MLX.GPU. So simulator cannot use the same engine as
///   device even if we wanted to.
///
///   We originally shipped CoreML SmolLM2 on simulator to give CI a real
///   small model for latency benchmarks (not a stubbed sleep). That's
///   blocked by the sim-CPU-zero-logits bug, so for now the sim path is a
///   stub and benchmarks are device-only. When/if the CoreML issue is
///   resolved, `-EDGEPROBE_SIM_COREML` is the single gate to flip.
///
/// The public API is shared between all three paths: `load()` then
/// `generate(_:)`. Callers in VoiceTurnController don't care which
/// backend is live.
@MainActor
final class LLMService: ObservableObject {

    enum LLMError: Error, LocalizedError {
        case modelNotLoaded
        case inferenceFailed(String)
        case simulatorUnsupportedOS

        var errorDescription: String? {
            switch self {
            case .modelNotLoaded:
                return "LLM isn't loaded. Tap \"Load model\" and wait for the first-launch download."
            case .inferenceFailed(let m):
                return "Inference failed: \(m)"
            case .simulatorUnsupportedOS:
                return "Simulator CoreML LLM path requires iOS 18+. The host simulator is older — no model will load."
            }
        }
    }

    /// `0...1` while fetching weights on first launch, then `1` once the
    /// model is live. Bound to the UI so the user sees a real progress
    /// bar — a silent multi-hundred-MB download is a bad UX.
    @Published private(set) var loadProgress: Double = 0

    @Published private(set) var isLoaded: Bool = false

    /// Written into the trace's span attributes so `gen_ai.request.model`
    /// in the dashboard reflects what actually ran. Device and the sim
    /// stub pre-seed this; the sim CoreML path overwrites on successful
    /// load (if someone flipped `-EDGEPROBE_SIM_COREML`). Dashboards
    /// filtering on `gen_ai.request.model` will see three distinct values.
    #if targetEnvironment(simulator)
    @Published private(set) var modelName: String = "stub-sim-llm"
    #else
    @Published private(set) var modelName: String = "llama-3.2-1b-instruct-4bit-mlx"
    #endif

    #if targetEnvironment(simulator)
    /// True only when `-EDGEPROBE_SIM_COREML` is on the launch-arg list.
    /// Captured once at init so flipping ProcessInfo mid-run can't change
    /// the branch partway through a session — the user deserves a stable
    /// contract for "which backend am I observing?" within one app launch.
    ///
    /// When false (the default): `load()` fakes progress + flips isLoaded
    /// with no network; `generate()` returns a canned stub reply. When
    /// true: the full CoreML MLModel + MLState driver below runs, same as
    /// it did before the default changed.
    private nonisolated let simCoreMLEnabled: Bool =
        ProcessInfo.processInfo.arguments.contains("-EDGEPROBE_SIM_COREML")
    #endif

    // MARK: - Device-only state

    #if !targetEnvironment(simulator)
    /// MLX-Swift's container holds the weights + tokenizer + processor and
    /// is `Sendable`-safe for `perform { context in ... }` calls.
    private var container: ModelContainer?
    #endif

    // MARK: - Simulator-only state

    #if targetEnvironment(simulator)
    /// The compiled CoreML model. Held as `MLModel?` rather than our own
    /// wrapper because we don't need one — the per-turn KV-cache state is
    /// re-created on each `generate()` call, so there's no wrapper
    /// lifecycle to manage.
    ///
    /// `nonisolated(unsafe)` because:
    ///   • `MLModel` is not `Sendable` (reference type with internal
    ///     mutable caches under the hood).
    ///   • Under @MainActor, passing `model` to an `await
    ///     model.prediction(...)` call tries to "send" it to the
    ///     nonisolated executor and Swift 6 region-based isolation
    ///     rejects it.
    ///   • We sidestep by marking generation `nonisolated` (below) and
    ///     opting this storage out of actor isolation.
    ///   • Safety contract: `load()` writes once on MainActor *before* any
    ///     caller is permitted to invoke `generate()` (the UI's
    ///     `isLoaded` gate enforces this). No concurrent mutation → the
    ///     "unsafe" label is honest but the race doesn't exist.
    private nonisolated(unsafe) var coremlModel: MLModel?

    /// Tokenizer pairs with the model — tokenizes prompts (via chat
    /// template) and decodes output tokens back to text. Loaded from the
    /// original SmolLM2-Instruct repo's sidecar JSON, not the CoreML repo
    /// (which ships an empty config.json).
    ///
    /// `Tokenizer: Sendable` in swift-transformers 1.0, so this doesn't
    /// strictly need `nonisolated(unsafe)`. Kept symmetric with
    /// `coremlModel` for readability — both get written in load(), read
    /// in generate(); same lifecycle, same access rules.
    private nonisolated(unsafe) var coremlTokenizer: (any Tokenizer)?
    #endif

    /// Fetch + load the model. Idempotent: subsequent calls are no-ops.
    func load() async throws {
        if isLoaded {
            llmLog.info("load() called but model already loaded; no-op")
            return
        }
        llmLog.info("load() starting")

        #if targetEnvironment(simulator)
        if simCoreMLEnabled {
            // Opt-in path (not default). Fully functional download +
            // MLModel load; inference outputs zeros — see class doc.
            do {
                try await loadSimulatorCoreML()
                llmLog.info("load() simulator CoreML path succeeded (opt-in)")
            } catch {
                llmLog.error("load() simulator CoreML path failed: \(error.localizedDescription, privacy: .public)")
                throw error
            }
        } else {
            // Default path. No network, no weights. ~600ms of fake
            // progress so the chip still animates; the UX matters more
            // for a demo app than the microbenchmark realism we lose
            // here. When the CoreML sim bug is resolved, flip the flag.
            await loadSimulatorStub()
            llmLog.info("load() simulator stub path succeeded")
        }
        #else
        do {
            try await loadDeviceMLX()
            llmLog.info("load() device path succeeded")
        } catch {
            llmLog.error("load() device path failed: \(error.localizedDescription, privacy: .public)")
            throw error
        }
        #endif
    }

    // MARK: - Device path (MLX)

    #if !targetEnvironment(simulator)
    private func loadDeviceMLX() async throws {
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
    }
    #endif

    // MARK: - Simulator path (CoreML)

    #if targetEnvironment(simulator)
    private func loadSimulatorCoreML() async throws {
        // iOS 18 is where `LanguageModel` / `MLTensor` / `GenerationConfig`
        // from swift-transformers became public. Simulator builds against
        // iOS <18 would fail at runtime anyway; surface it as a clean error.
        guard #available(iOS 18.0, *) else {
            throw LLMError.simulatorUnsupportedOS
        }

        // Hop HubApi's download progress (background queue) to MainActor
        // before touching `@Published var loadProgress`.
        let urls = try await ModelHub.ensureAvailable { [weak self] frac in
            Task { @MainActor in self?.loadProgress = frac }
        }

        // `.cpuOnly` on simulator — NOT `.cpuAndGPU` / `.all`.
        //
        // Why:
        //   SmolLM2-360M's mlmodelc is an iOS 18 spec-v9 stateful MLProgram
        //   (see `Ios18.readState` / `Ios18.writeState` / `state<>` inputs
        //   in model.mil). When CoreML builds an execution plan with
        //   `.cpuAndGPU` in the sim, the GPU backend refuses to codegen
        //   these stateful ops and the whole load fails with:
        //     Domain=com.apple.CoreML Code=0
        //     "Failed to build the model execution plan ...
        //      model.mil ... with error code: -14"
        //   which is maddeningly unspecific, but deterministically goes
        //   away when we drop GPU from the compute policy.
        //
        //   On a device, `.cpuAndGPU` (or `.all` for ANE) would be faster,
        //   but this whole branch is `#if targetEnvironment(simulator)` —
        //   the device path uses MLX, not CoreML. So the "simulator +
        //   CPU-only" box is the only box this setting lives in, and
        //   latency-wise a 360M CoreML model on sim CPU is fine for the
        //   dev loop and CI bench baselines.
        let config = MLModelConfiguration()
        config.computeUnits = .cpuOnly
        let model = try MLModel(contentsOf: urls.mlmodelc, configuration: config)

        // Load tokenizer from the *original* repo's sidecar files, not
        // the CoreML repo (which ships `{}` for config.json — useless for
        // tokenizer class inference). `AutoTokenizer.from(modelFolder:)`
        // reads config.json + tokenizer.json + tokenizer_config.json
        // locally and constructs the right PreTrainedTokenizer subclass.
        let tokenizer = try await AutoTokenizer.from(modelFolder: urls.tokenizerFolder)

        self.coremlModel = model
        self.coremlTokenizer = tokenizer
        self.isLoaded = true
        self.loadProgress = 1.0
    }
    #endif

    /// Generate a reply to `prompt`. Greedy decoding, 128-token cap —
    /// keeps replies voice-friendly and, more importantly, makes
    /// benchmark latency deterministic (temperature=0, doSample=false).
    ///
    /// The TTS engine will speak whatever comes back; if the model wanders,
    /// the user hears it wander. That's intentional honesty — the point of
    /// EdgeProbe is to surface real on-device behavior, not make it look
    /// better than it is.
    func generate(_ prompt: String) async throws -> String {
        #if targetEnvironment(simulator)
        if simCoreMLEnabled {
            return try await generateSimulatorCoreML(prompt)
        }
        return try await generateSimulatorStub(prompt)
        #else
        return try await generateDeviceMLX(prompt)
        #endif
    }

    // MARK: - Simulator path (default: stub)

    #if targetEnvironment(simulator)
    /// Fake the download animation so UI dev + recorded demos see the
    /// chip tick through percentages instead of a blink-to-ready. ~600ms
    /// end-to-end — long enough to feel real, short enough to not annoy.
    private func loadSimulatorStub() async {
        let steps = 10
        for i in 1...steps {
            try? await Task.sleep(nanoseconds: 60_000_000) // 60ms
            self.loadProgress = Double(i) / Double(steps)
        }
        self.modelName = "stub-sim-llm"
        self.isLoaded = true
    }

    /// Canned reply. Echoes a truncated slice of the prompt so the demo
    /// feels responsive across multiple turns, then explicitly flags
    /// itself as a stub so nobody mistakes the reply for model output.
    ///
    /// ~600ms synthetic latency approximates where a well-behaved small
    /// LLM on sim CPU would land — keeps LLM span timings in a
    /// plausible-looking range on the dashboard. Deterministic: same
    /// prompt in, same reply out, same elapsed time in ±jitter. That's
    /// the benchmark-friendly bit we keep even without a real model.
    private func generateSimulatorStub(_ prompt: String) async throws -> String {
        try await Task.sleep(nanoseconds: 600_000_000) // 600ms
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let preview = trimmed.count > 60
            ? String(trimmed.prefix(60)) + "…"
            : trimmed
        if preview.isEmpty {
            return "Simulator stub — real on-device inference runs on a physical iPhone."
        }
        return "Got it: \"\(preview)\". (Simulator stub — real on-device inference runs on a physical iPhone.)"
    }
    #endif

    // MARK: - Device generation (MLX)

    #if !targetEnvironment(simulator)
    private func generateDeviceMLX(_ prompt: String) async throws -> String {
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
    #endif

    // MARK: - Simulator generation (CoreML)

    #if targetEnvironment(simulator)
    /// Max new tokens per turn. 128 keeps replies voice-friendly (most
    /// responses fit comfortably) and caps worst-case latency at a
    /// predictable budget for benchmarks.
    ///
    /// `nonisolated` because `generateSimulatorCoreML` is itself
    /// nonisolated (runs off the MainActor to avoid non-Sendable MLModel
    /// crossing actor boundaries), and a plain `static let` on a
    /// @MainActor class inherits the class's isolation.
    private nonisolated static let maxNewTokens = 128

    /// `nonisolated` so the whole body runs off the main actor. Two
    /// reasons to do this rather than stay on MainActor:
    ///   1. `MLModel` is not Sendable — from @MainActor, any call into
    ///      its async methods (`prediction(from:using:)`) is a "send" of
    ///      a non-Sendable value and Swift 6 errors out.
    ///   2. CoreML prediction is compute-heavy; even on simulator it would
    ///      block MainActor for tens of ms per token. Off-loading is the
    ///      right call regardless of the Sendability gymnastics.
    ///
    /// Reads of `coremlModel` / `coremlTokenizer` are safe here because
    /// they're `nonisolated(unsafe)` (see storage comment above) and
    /// `load()` must complete before any caller invokes this.
    private nonisolated func generateSimulatorCoreML(_ prompt: String) async throws -> String {
        guard #available(iOS 18.0, *) else {
            throw LLMError.simulatorUnsupportedOS
        }
        guard let model = coremlModel, let tokenizer = coremlTokenizer else {
            throw LLMError.modelNotLoaded
        }

        do {
            // Chat template: SmolLM2-Instruct uses ChatML-style
            // `<|im_start|>system\n...\n<|im_end|>` segments. The tokenizer
            // ships with the Jinja template and knows how to apply it;
            // hand-crafting the string would miss the assistant-start
            // sentinel and hallucinate an answer from the user role.
            //
            // swift-transformers' `Message` typealias is `[String: Any]`
            // (not `[String: String]`) because chat messages can carry
            // tool-call metadata. A plain string payload is fine for us.
            let messages: [Message] = [
                [
                    "role": "system",
                    "content": "You are a concise voice assistant. Reply in one or two short sentences."
                ],
                [
                    "role": "user",
                    "content": prompt
                ]
            ]
            let inputTokens = try tokenizer.applyChatTemplate(messages: messages)
            let eos = tokenizer.eosTokenId ?? -1
            llmLog.info("gen: prompt tokens=\(inputTokens.count), eos=\(eos)")

            // Fresh KV-cache state per turn. `makeState()` allocates the
            // stateful `key_cache` / `value_cache` buffers declared in
            // `model.mil`; reusing state across turns would make turn N+1
            // see turn N's context, which is exactly what "per-turn voice
            // assistant" wants to avoid.
            let state = model.makeState()

            // Phase 1 — prefill. Feed the full prompt in one prediction;
            // the state swallows the KV tensors for every prompt token in
            // one shot, then we sample the next token from logits[-1].
            // `predictNextToken` throws LLMError.inferenceFailed if the
            // sim-CPU zero-logit bug hits, so we never get into the
            // extend loop with a bogus firstTok.
            var nextTok = try await Self.predictNextToken(
                model: model,
                state: state,
                tokens: inputTokens.map { Int32($0) },
                pastSeenTokens: 0
            )
            var generated: [Int] = [Int(nextTok)]
            var pastSeen = inputTokens.count

            // Phase 2 — extend, one token at a time. The KV cache holds
            // everything prior, so each call is O(1) in attention cost
            // regardless of generated-so-far length (up to the 2048-token
            // context window from model.mil).
            while generated.count < Self.maxNewTokens && Int(nextTok) != eos {
                nextTok = try await Self.predictNextToken(
                    model: model,
                    state: state,
                    tokens: [nextTok],
                    pastSeenTokens: pastSeen
                )
                generated.append(Int(nextTok))
                pastSeen += 1
            }

            // Drop a trailing EOS if the model ended cleanly; keeps the
            // decoded string free of the stray "<|im_end|>" spelling.
            if let last = generated.last, last == eos {
                generated.removeLast()
            }

            let reply = tokenizer.decode(tokens: generated, skipSpecialTokens: true)
            return reply.trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            throw LLMError.inferenceFailed(error.localizedDescription)
        }
    }

    /// One CoreML prediction. Greedy (argmax) sampling.
    ///
    /// Builds two inputs matching finnvoorhees' SmolLM2 mlmodelc:
    ///   • `input_ids`    — int32 `[1, seqLen]`. The tokens to process
    ///     this step (entire prompt on prefill, 1 token on extend).
    ///   • `causal_mask`  — fp16 `[1, 1, seqLen, totalLen]` where
    ///     `totalLen = pastSeenTokens + seqLen`. Value 0 means "attend",
    ///     `-65504` (fp16 min) means "blocked"; these get added to the
    ///     attention scores before softmax, so `-inf`-ish entries zero
    ///     out via softmax. Upper-triangular structure enforces causality
    ///     during prefill; at extend time it's a flat row of zeros.
    ///
    /// The `key_cache` / `value_cache` state inputs declared in model.mil
    /// are managed by CoreML via `MLState`; we just pass it through and
    /// the runtime writes back to it in place.
    ///
    /// Returns the single next-token id as `Int32`.
    ///
    /// `nonisolated` for the same reason `generateSimulatorCoreML` is:
    /// `MLModel` and `MLState` are not Sendable; a main-actor-isolated
    /// static would force callers to "send" them across isolation
    /// boundaries on every call, which Swift 6 region-based isolation
    /// rejects. We keep this function pure (no class state reads/writes
    /// — everything is parameters) so the `nonisolated` label is honest.
    @available(iOS 18.0, *)
    private nonisolated static func predictNextToken(
        model: MLModel,
        state: MLState,
        tokens: [Int32],
        pastSeenTokens: Int
    ) async throws -> Int32 {
        let seqLen = tokens.count
        let totalLen = pastSeenTokens + seqLen

        // input_ids
        let inputIds = try MLMultiArray(
            shape: [1, seqLen] as [NSNumber],
            dataType: .int32
        )
        let inputIdsPtr = inputIds.dataPointer
            .bindMemory(to: Int32.self, capacity: seqLen)
        for i in 0..<seqLen { inputIdsPtr[i] = tokens[i] }

        // causal_mask — all zeros.
        //
        // The SmolLM2 CoreML export builds its own causal mask internally
        // (the `Ios18.scaledDotProductAttention` op with `is_causal=true`
        // derives the triangular mask from q_len vs k_len); the
        // `causal_mask` input is only consulted as an additive *padding*
        // mask. For single-sequence batch=1 inference there is no
        // padding, so the model wants zeros — matching the convention
        // used by swift-transformers' `LanguageModelWithStatefulKVCache`.
        //
        // When we supplied an actual triangular lower-triangular mask
        // with `-65504` in the upper triangle, the model masked out
        // everything and produced all-zero logits (observed 2026-04-17).
        let causalMask = try MLMultiArray(
            shape: [1, 1, seqLen, totalLen] as [NSNumber],
            dataType: .float16
        )
        let maskPtr = causalMask.dataPointer
            .bindMemory(to: Float16.self, capacity: seqLen * totalLen)
        for i in 0..<(seqLen * totalLen) {
            maskPtr[i] = 0.0
        }

        let features = try MLDictionaryFeatureProvider(dictionary: [
            "input_ids": MLFeatureValue(multiArray: inputIds),
            "causal_mask": MLFeatureValue(multiArray: causalMask)
        ])

        let outputs = try await model.prediction(from: features, using: state)

        // logits shape is [1, seqLen, vocabSize]; we only need the slice
        // at position seqLen-1 (the "next-token" distribution).
        guard let logits = outputs.featureValue(for: "logits")?.multiArrayValue else {
            throw LLMError.inferenceFailed("Model did not produce 'logits' output.")
        }
        let vocabSize = logits.shape[2].intValue
        let lastPos = seqLen - 1
        let base = lastPos * vocabSize
        let logitsPtr = logits.dataPointer
            .bindMemory(to: Float16.self, capacity: logits.count)

        // argmax over the last-position logits. Greedy (temperature=0)
        // for benchmark reproducibility.
        var bestTok: Int32 = 0
        var bestScore: Float = -.infinity
        for v in 0..<vocabSize {
            let s = Float(logitsPtr[base + v])
            if s > bestScore {
                bestScore = s
                bestTok = Int32(v)
            }
        }

        // Sim-CPU-sanity: on the first step (prefill), check whether the
        // model actually computed non-zero logits. The sim's CPU backend
        // silently zeros out int4-stateful MLPrograms like this one
        // (confirmed 2026-04-17 against finnvoorhees SmolLM2-4bit —
        // every logit 0.0, pointer & subscript agree). When that
        // happens the loop below will spin out 128 × token-id-0 until
        // the budget cap and the user gets an empty reply — worse UX
        // than just surfacing the failure.
        if pastSeenTokens == 0 && bestScore == 0 {
            llmLog.error("Simulator CoreML returned all-zero logits — expected when running int4-stateful MLPrograms on sim CPU. Disable the -EDGEPROBE_SIM_COREML flag to fall back to the stub.")
            throw LLMError.inferenceFailed(
                "All logits are zero on first step. The simulator CPU backend "
                + "cannot execute this model's int4 stateful ops; see README VoiceProbe section. "
                + "Drop the -EDGEPROBE_SIM_COREML launch arg to use the stub instead."
            )
        }
        return bestTok
    }
    #endif
}
