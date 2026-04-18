import XCTest
@testable import LlamaRuntime
import llama

/// Tests here are **compile- and link-gates**, not behavior tests.
///
/// Why no "actually run a model" test:
///   Loading a real GGUF costs ~400 MB of disk + ~1 GB of RSS and takes
///   several seconds even on the fastest runner. Baking that into `swift
///   test` would make every PR pay the cost; baking a sentinel tiny
///   model into the repo would bloat git by hundreds of MB.
///
/// What we DO verify:
///   • `import llama` links — the binaryTarget checksum is valid and
///     the xcframework's iOS/macOS slice for the host actually made it
///     onto the linker's search path.
///   • `LlamaRuntimeError` cases reach LocalizedError conformance — a
///     typo in the switch (easy to make) would trip here.
///   • Model-load error path returns a structured error — guards
///     against regressions where a future refactor lets a nil from the
///     C API propagate as a force-unwrap crash.
///
/// End-to-end "generate from real weights" lives in VoiceProbe itself:
/// flip `-EDGEPROBE_SIM_LLAMACPP` on the scheme, hit Run, talk. The
/// voice turn IS the integration test.
final class LlamaRuntimeTests: XCTestCase {

    /// Covers every error case in the switch statement. If someone
    /// adds a new case and forgets `.errorDescription`, this fails to
    /// compile (exhaustive switch) — a compile-fail IS the test here.
    func testErrorDescriptionsExist() {
        let cases: [LlamaRuntimeError] = [
            .backendInitFailed,
            .modelLoadFailed(path: "/dev/null/nope.gguf"),
            .vocabUnavailable,
            .contextInitFailed,
            .samplerInitFailed,
            .tokenizationFailed("x"),
            .chatTemplateFailed("x"),
            .decodeFailed(code: -1, phase: "test"),
            .detokenizationFailed("x"),
        ]
        for err in cases {
            XCTAssertNotNil(err.errorDescription, "\(err) has no errorDescription")
            XCTAssertFalse(
                err.errorDescription!.isEmpty,
                "\(err) has empty errorDescription"
            )
        }
    }

    /// Loading a nonexistent GGUF must throw `.modelLoadFailed`, NOT
    /// trap. This is the user-facing path every first-launch hits
    /// before the download completes.
    func testLoadingMissingFileThrowsModelLoadFailed() {
        XCTAssertThrowsError(try LlamaModel(path: "/tmp/edgeprobe-nonexistent-model-\(UUID().uuidString).gguf")) { err in
            guard case LlamaRuntimeError.modelLoadFailed = err else {
                XCTFail("Expected .modelLoadFailed, got \(err)")
                return
            }
        }
    }

    /// Sanity-check that raw llama C symbols ARE visible if someone
    /// needs to escape to them. Primary value is compile-time: if the
    /// xcframework didn't link or the module map broke, this file
    /// wouldn't build at all.
    ///
    /// The runtime check just verifies the default-params struct has
    /// the shape we expect (the `n_gpu_layers` field, which we override
    /// to 0 inside `LlamaModel.init` for sim-safety). If upstream ever
    /// renames or removes that field, the wrapper's own line
    /// `params.n_gpu_layers = 0` stops compiling — this test is mostly
    /// for the case where the field's SEMANTICS drift (e.g. goes from
    /// int32 to enum) without a Swift-visible build break.
    ///
    /// Note: llama.cpp defaults this to `-1` (= "offload all layers"),
    /// so don't assert non-negativity — just assert the field reads.
    func testRawCSymbolsAreImportable() {
        let defaultParams = llama_model_default_params()
        // Force a read of the field. If the struct layout changed
        // silently (same name, different offset), this line would
        // compile but could crash; but that's a library-ABI-break which
        // we can't really test from Swift anyway.
        let gpuLayers: Int32 = defaultParams.n_gpu_layers
        _ = gpuLayers

        // Also exercise the chain-params path so `llama_sampler_*` is
        // actually referenced at link time for this test binary.
        let sparams = llama_sampler_chain_default_params()
        _ = sparams
    }
}
