// swift-tools-version:6.0
//
// harness — EdgeProbe benchmark harness CLI.
//
// WHY this is a SEPARATE PACKAGE (not a product inside ios/Package.swift):
//   docs/SLICES.md §Slice 9 requires the harness "ships as a distinct SwiftPM
//   product so the SDK package doesn't bloat." Host apps integrating EdgeProbe
//   via `.package(url:)` must NOT pull harness-only code, test fixtures, or any
//   benchmarking deps we might add later (MLX, swift-argument-parser, etc).
//   Keeping the harness in its own package with a local path dep on ../ios
//   makes that hard boundary a compile-time fact, not a convention.
//
// Dependencies: zero third-party. The SDK itself has zero third-party deps
// (see ios/Package.swift comment), and the harness mirrors that for Y1 so
// a user cloning and running `swift run harness` doesn't wait on package
// resolution before seeing output.
import PackageDescription

let package = Package(
    name: "harness",
    platforms: [
        // macOS only — the harness runs on a laptop or CI runner, not on
        // a phone. iOS is not a supported platform.
        .macOS(.v13)
    ],
    products: [
        .executable(name: "harness", targets: ["harness"])
    ],
    dependencies: [
        // Local path dep so `swift run harness` works from a fresh clone
        // without network. EdgeProbe is the library under test — per-iteration
        // `beginTrace()` exercises the full span pipeline, so the harness
        // doubles as an integration smoke for the SDK.
        .package(path: "../ios")
    ],
    targets: [
        .executableTarget(
            name: "harness",
            dependencies: [
                .product(name: "EdgeProbe", package: "ios")
            ],
            path: "Sources/harness"
        ),
        .testTarget(
            name: "harnessTests",
            dependencies: ["harness"],
            path: "Tests/harnessTests",
            resources: [
                // Test-local copies of prompt + golden fixtures. Accessed via
                // Bundle.module. Kept under the test target (not the exe
                // target) so `swift run harness` at user sites doesn't ship
                // a bundle of internal goldens.
                //
                // `.copy` (vs `.process`) preserves the `prompts/` and `golden/`
                // subdirectory layout inside the test bundle — the fixtures
                // have natural paths (`prompts/cap.txt`, `golden/*.json`) that
                // make more sense than flattened names.
                .copy("Fixtures")
            ]
        )
    ]
)
