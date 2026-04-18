// swift-tools-version: 5.9
//
// LlamaRuntime — a thin Swift wrapper around the upstream llama.cpp
// XCFramework so VoiceProbe (and later, harness) can drive a real GGUF
// language model from Swift without dealing with the raw C API at call
// sites.
//
// Why a separate package (not folded into the EdgeProbe SDK):
//   • 169 MB xcframework download on first SPM resolve — we don't want
//     every EdgeProbe consumer (including the backend CI job that
//     imports nothing from this layer) paying that cost.
//   • The SDK stays pure Swift. Opt-in anything linking against native
//     code.
//   • Cleanly separates "trace the SDK call" from "run the LLM under
//     the trace" — one is the product, the other is a demo-app
//     convenience.
//
// Why a URL-pinned binaryTarget (not a local XCFramework):
//   • Upstream ggml-org/llama.cpp publishes a prebuilt, dual-slice
//     xcframework on every `bNNNN` release tag — same artifact they
//     ship to their own iOS sample apps. Zero build-pipeline work on
//     our side.
//   • Pinning by SHA-256 means an upstream re-tag can't silently
//     change what we link against.
//   • First-time fetch is ~169 MB; subsequent resolves hit SwiftPM's
//     per-machine cache (~/Library/Caches/org.swift.swiftpm).
//
// Tag selection rationale:
//   b8833 (April 2026) was current-HEAD when this slice landed. If
//   upstream ships a tag that breaks our wrapper (happens — the
//   sampler / batch APIs move occasionally), bump the tag and the
//   checksum together. Compute the new checksum via:
//       swift package compute-checksum <downloaded-zip>
//   and update both values in lockstep.
import PackageDescription

let package = Package(
    name: "LlamaRuntime",
    platforms: [
        // Matches VoiceProbe's deployment target so SwiftPM accepts the
        // dependency without a platform-version complaint on resolve.
        // llama.cpp itself supports back to iOS 16.4 in this xcframework.
        .iOS(.v16),
        .macOS(.v13),
    ],
    products: [
        .library(name: "LlamaRuntime", targets: ["LlamaRuntime"]),
    ],
    targets: [
        // Prebuilt llama.cpp xcframework from upstream. The Swift module
        // this exposes is `llama` (per the framework's module.modulemap),
        // so Swift code imports `llama` for the raw C API.
        //
        // The wrapper target below depends on it and is what app code
        // should prefer importing (`import LlamaRuntime`).
        .binaryTarget(
            name: "llama",
            url: "https://github.com/ggml-org/llama.cpp/releases/download/b8833/llama-b8833-xcframework.zip",
            checksum: "cf79e433e21c62f0648b7dd7e5905c58e109cacd3fbfe3ceac1faf62cfdc49f9"
        ),
        .target(
            name: "LlamaRuntime",
            dependencies: ["llama"],
            // No Metal link needed here — the framework's own modulemap
            // already declares `link framework "Metal"` etc. for
            // simulator runtime fallback.
            swiftSettings: [
                // SE-0337 strict concurrency — matches the rest of the
                // repo's Swift 6 stance. Our wrapper is written with this
                // in mind (all stored pointer state is private and
                // deliberately non-Sendable; callers must keep a
                // `LlamaModel` / `LlamaSession` on one isolation domain).
                .enableExperimentalFeature("StrictConcurrency"),
            ]
        ),
        .testTarget(
            name: "LlamaRuntimeTests",
            dependencies: ["LlamaRuntime"]
        ),
    ]
)
