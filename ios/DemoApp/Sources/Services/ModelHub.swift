#if targetEnvironment(simulator)
import Foundation
import Hub

/// First-launch model download + local cache for the simulator CoreML LLM path.
///
/// Why this file only exists in simulator builds:
///   MLX is the device backend (see LLMService.swift) — it bundles its own
///   tokenizer + weights fetching via `LLMModelFactory`, no HubApi needed.
///   On simulator, MLX's Metal-for-compute path abort()s (see LLMService's
///   load()), so we fall back to a CoreML language model via swift-transformers.
///   That path needs files from two HuggingFace repos:
///     1. finnvoorhees/coreml-SmolLM2-360M-Instruct-4bit — the compiled
///        .mlmodelc (207 MB). Supplies the CoreML model only.
///     2. HuggingFaceTB/SmolLM2-360M-Instruct — the tokenizer.json +
///        tokenizer_config.json + chat_template.jinja + config.json.
///        Needed because finnvoorhees' repo ships an empty `{}` config.json,
///        so swift-transformers can't infer the tokenizer class from it.
///
/// Total first-launch download: ~210 MB. Subsequent launches hit the local
/// cache (HubApi stamps metadata per-file and skips re-downloads).
///
/// We deliberately don't bundle the model in the app IPA:
///   • 210 MB bloat on device installs (where this path never runs).
///   • Requires a CI step to pre-fetch and lipo, which drifts.
///   • The model is on HF Hub anyway; the network dep is acceptable for a
///     demo app the first time you open it. The progress bar makes it
///     observable rather than a mysterious spinner.
///
/// All methods are annotated `@available(iOS 18.0, *)` because
/// `LanguageModel` and its whole Generation/Tokenizer plumbing are iOS 18+.
/// Deployment target is iOS 16.4 (device needs it for some older iPads in
/// the field), and the simulator we actually ship against is iOS 18+. The
/// runtime guard is on the call site in LLMService.
@available(iOS 18.0, *)
enum ModelHub {

    /// Repo IDs we pull from. Centralized here so a future model swap is
    /// one constant change plus the `.mlmodelc` filename below.
    enum Repo {
        static let coremlModel = "finnvoorhees/coreml-SmolLM2-360M-Instruct-4bit"
        static let tokenizerSource = "HuggingFaceTB/SmolLM2-360M-Instruct"
    }

    /// Exact filename inside `coremlModel` repo. If finnvoorhees renames the
    /// mlmodelc, update this. `LanguageModel.loadCompiled` wants the URL of
    /// the `.mlmodelc` *directory* (CoreML compiled artifacts are
    /// directories, not files).
    static let mlmodelcName = "SmolLM2-360M-Instruct-4bit.mlmodelc"

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
