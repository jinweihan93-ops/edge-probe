#if targetEnvironment(simulator)
import Foundation
import Hub

/// First-launch model download + local cache for the simulator LLM paths.
///
/// Why this file only exists in simulator builds:
///   MLX is the device backend (see LLMService.swift) — it bundles its own
///   tokenizer + weights fetching via `LLMModelFactory`, no HubApi needed.
///   On simulator, MLX's Metal-for-compute path abort()s (see LLMService's
///   load()), so we have two fallback simulator LLM paths, each with its
///   own HF download:
///
///   1. **CoreML** (opt-in `-EDGEPROBE_SIM_COREML`) — via
///      `ensureAvailable(progress:)`. Files from two repos:
///         • `finnvoorhees/coreml-SmolLM2-360M-Instruct-4bit` — the
///           compiled .mlmodelc (207 MB). Supplies the CoreML model only.
///         • `HuggingFaceTB/SmolLM2-360M-Instruct` — the tokenizer.json +
///           tokenizer_config.json + chat_template.jinja + config.json.
///           Needed because finnvoorhees' repo ships an empty `{}`
///           config.json, so swift-transformers can't infer the tokenizer
///           class from it.
///      Total: ~210 MB. Currently hits the sim-CPU zero-logit bug — see
///      LLMService class docs.
///
///   2. **llama.cpp** (opt-in `-EDGEPROBE_SIM_LLAMACPP`, Slice 11) — via
///      `ensureLlamaCppGGUF(progress:)`. Single file:
///         • `Qwen/Qwen2.5-0.5B-Instruct-GGUF` →
///           `qwen2.5-0.5b-instruct-q4_0.gguf` (~428 MB).
///      GGUF files embed the tokenizer + chat template, so there's no
///      sidecar-repo dance. Runs CPU-only under llama.cpp, which dodges
///      the sim-CPU CoreML bug entirely by not using CoreML.
///
/// Subsequent launches hit the local cache (HubApi stamps metadata
/// per-file and skips re-downloads). We deliberately don't bundle either
/// model in the app IPA:
///   • hundreds-of-MB bloat on device installs where these never run.
///   • Requires a CI step to pre-fetch and lipo, which drifts.
///   • The models are on HF Hub anyway; the network dep is acceptable for
///     a demo app the first time you open it. The progress bar makes it
///     observable rather than a mysterious spinner.
///
/// The CoreML path's caller (LLMService.loadSimulatorCoreML) is
/// `@available(iOS 18.0, *)` because `MLModel.makeState()` /
/// `MLTensor` / SmolLM2's stateful ops need iOS 18. The llama.cpp path
/// has no such gate — llama.cpp is pure Metal + CPU, works on iOS 16.4+.
/// So only `ensureAvailable` carries an `@available` attribute below;
/// `ensureLlamaCppGGUF` is ungated.
enum ModelHub {

    /// Repo IDs we pull from. Centralized here so a future model swap is
    /// one constant change plus the filename constants below.
    enum Repo {
        static let coremlModel = "finnvoorhees/coreml-SmolLM2-360M-Instruct-4bit"
        static let tokenizerSource = "HuggingFaceTB/SmolLM2-360M-Instruct"

        /// Qwen's official GGUF release repo. Ships multiple quantization
        /// levels — we want q4_0 (the smallest mainstream choice;
        /// q4_k_m would be higher quality at +~30% size, q8_0 is
        /// lossless-ish at ~2× the bytes).
        ///
        /// Why Qwen2.5-0.5B and not a different small model:
        ///   • It's genuinely instruction-tuned; small Llamas of this
        ///     size are weaker at two-turn chat.
        ///   • The GGUF ships with an embedded chat template
        ///     (`tokenizer.chat_template` metadata), so LlamaRuntime's
        ///     `renderChat` can use it without a sidecar .jinja file.
        ///   • Apache-2.0 licensed — no distribution surprises for an
        ///     OSS demo app.
        static let llamaCppGGUF = "Qwen/Qwen2.5-0.5B-Instruct-GGUF"
    }

    /// Exact filename inside `coremlModel` repo. If finnvoorhees renames the
    /// mlmodelc, update this. `LanguageModel.loadCompiled` wants the URL of
    /// the `.mlmodelc` *directory* (CoreML compiled artifacts are
    /// directories, not files).
    static let mlmodelcName = "SmolLM2-360M-Instruct-4bit.mlmodelc"

    /// Exact filename inside `Repo.llamaCppGGUF`. Qwen's repo ships
    /// multiple `.gguf` variants (q2_k / q3_k_m / q4_0 / q4_k_m / q5_k_m
    /// / q6_k / q8_0 / fp16). We glob-match just this one file so
    /// HubApi doesn't drag in ~3 GB of quantizations we won't use.
    ///
    /// If Qwen republishes with a different naming convention
    /// (happens — they experimented with `.Q4_0.gguf` vs
    /// `-q4_0.gguf`), update this string to match.
    static let llamaCppGGUFName = "qwen2.5-0.5b-instruct-q4_0.gguf"

    /// Download the CoreML model + tokenizer sidecars. Reports progress
    /// across both downloads as a single 0...1 value — CoreML model weighs
    /// ~207 MB so tokenizer files (~5 MB) are folded in at the tail.
    ///
    /// Returns `(mlmodelcURL, tokenizerFolderURL)` where:
    ///   • `mlmodelcURL` is the path to pass to `LanguageModel.loadCompiled`
    ///   • `tokenizerFolderURL` is the root of the tokenizer source repo —
    ///     `AutoTokenizer.from(modelFolder:)` reads config.json +
    ///     tokenizer.json + tokenizer_config.json from there.
    ///
    /// `progress` is called on whatever queue HubApi uses (background); the
    /// caller is responsible for hopping to MainActor before touching UI.
    @available(iOS 18.0, *)
    static func ensureAvailable(
        progress: @escaping @Sendable (Double) -> Void
    ) async throws -> (mlmodelc: URL, tokenizerFolder: URL) {
        let hub = HubApi.shared

        // Phase 1: CoreML model. Glob-scoped so we don't accidentally drag
        // in the README (840 B) — not harmful but keeps the cache tidy.
        //
        // The .mlmodelc is a *directory* in the repo, so HubApi walks the
        // tree and pulls every file inside. `"*.mlmodelc/**"` is the glob
        // that matches everything under any .mlmodelc subdir.
        let modelRepo = Hub.Repo(id: Repo.coremlModel)
        let modelFolder = try await hub.snapshot(
            from: modelRepo,
            matching: ["*.mlmodelc/*", "*.mlmodelc/**/*"]
        ) { p in
            // CoreML download is the bulk of the work — give it 0.0...0.9
            // on the composite progress bar.
            progress(min(0.9, p.fractionCompleted * 0.9))
        }

        // Phase 2: tokenizer sidecars. Tiny files (few MB total) but
        // necessary because the CoreML repo's config.json is empty (`{}`).
        //
        // chat_template.jinja is worth pulling so downstream
        // `tokenizer.applyChatTemplate(messages:)` works without a
        // hand-rolled format string. SmolLM2 uses ChatML-style
        // `<|im_start|>system\n...\n<|im_end|>` — the template ships here.
        let tokenizerRepo = Hub.Repo(id: Repo.tokenizerSource)
        let tokenizerFolder = try await hub.snapshot(
            from: tokenizerRepo,
            matching: [
                "config.json",
                "tokenizer.json",
                "tokenizer_config.json",
                "chat_template.jinja",
                "chat_template.json",
                "generation_config.json"
            ]
        ) { p in
            // Tokenizer is the last 10% of composite progress.
            progress(0.9 + 0.1 * p.fractionCompleted)
        }

        let mlmodelcURL = modelFolder.appendingPathComponent(mlmodelcName)

        // Sanity check — surface a clear error instead of letting
        // LanguageModel.loadCompiled throw a cryptic CoreML error.
        guard FileManager.default.fileExists(atPath: mlmodelcURL.path) else {
            throw ModelHubError.missingModel(
                "Expected \(mlmodelcName) under \(modelFolder.path) after HubApi snapshot, but it's not there. "
                + "Did finnvoorhees rename the file? Check \(Repo.coremlModel) on HF."
            )
        }

        // Final progress nudge so the UI lands on exactly 1.0 regardless
        // of how HubApi rounded during streaming.
        progress(1.0)

        return (mlmodelc: mlmodelcURL, tokenizerFolder: tokenizerFolder)
    }

    /// Download the GGUF file for the llama.cpp simulator path. Reports
    /// progress 0...1 as HubApi streams bytes.
    ///
    /// GGUF is a single self-contained file: weights + tokenizer + chat
    /// template + all metadata in one blob. No sidecar-repo dance
    /// needed, unlike the CoreML path above. This keeps the function
    /// shorter and the error surface smaller.
    ///
    /// The `matching:` glob is precise (exact filename, not `*.gguf`)
    /// so a repo update that adds new quantizations doesn't accidentally
    /// double our disk footprint on next launch.
    ///
    /// Returns the absolute URL of the GGUF file on local disk —
    /// `LlamaModel(path:)` takes a plain string filesystem path, so the
    /// caller does `url.path`.
    ///
    /// Not `@available(iOS 18.0, *)` — llama.cpp doesn't need iOS 18.
    /// The XCFramework's deployment target is iOS 16.4 (matches ours).
    static func ensureLlamaCppGGUF(
        progress: @escaping @Sendable (Double) -> Void
    ) async throws -> URL {
        let hub = HubApi.shared
        let repo = Hub.Repo(id: Repo.llamaCppGGUF)
        let folder = try await hub.snapshot(
            from: repo,
            matching: [llamaCppGGUFName]
        ) { p in
            // Map HubApi's fractionCompleted straight through — single
            // file, no phase-folding needed.
            progress(p.fractionCompleted)
        }

        let ggufURL = folder.appendingPathComponent(llamaCppGGUFName)

        // Sanity check — surface a clear error instead of letting
        // llama_model_load_from_file throw its own opaque "file not
        // found" via LlamaRuntimeError.modelLoadFailed.
        guard FileManager.default.fileExists(atPath: ggufURL.path) else {
            throw ModelHubError.missingModel(
                "Expected \(llamaCppGGUFName) under \(folder.path) after HubApi snapshot, but it's not there. "
                + "Did Qwen rename the file? Check \(Repo.llamaCppGGUF) on HF."
            )
        }

        progress(1.0)
        return ggufURL
    }

    enum ModelHubError: LocalizedError {
        case missingModel(String)

        var errorDescription: String? {
            switch self {
            case .missingModel(let msg): return "Model download succeeded but the expected file is missing: \(msg)"
            }
        }
    }
}
#endif
