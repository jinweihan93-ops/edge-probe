// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "EdgeProbe",
    platforms: [
        .iOS(.v16),
        .macOS(.v13) // so we can unit test on the mac without a simulator
    ],
    products: [
        .library(
            name: "EdgeProbe",
            targets: ["EdgeProbe"]
        )
    ],
    dependencies: [
        // TODO(month-13): add opentelemetry-swift once we wire BatchSpanProcessor
        // .package(url: "https://github.com/open-telemetry/opentelemetry-swift", from: "1.14.0")
    ],
    targets: [
        .target(
            name: "EdgeProbe",
            path: "Sources/EdgeProbe"
        ),
        .testTarget(
            name: "EdgeProbeTests",
            dependencies: ["EdgeProbe"],
            path: "Tests/EdgeProbeTests"
        )
    ]
)
