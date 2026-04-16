import Foundation
import os

/// EdgeProbe — on-device AI observability.
///
/// Three-line install:
/// ```swift
/// import EdgeProbe
/// EdgeProbe.start(apiKey: "epk_pub_...")
/// try EdgeProbe.trace(.llm) { try model.generate(prompt) }
/// ```
///
/// This is the P0 public API skeleton. Network export, ring buffer, and
/// OpenTelemetry wiring land in subsequent commits.
public enum EdgeProbe {

    // MARK: - Types

    /// What kind of on-device AI operation this span represents.
    /// Mapped to `gen_ai.system` / custom attributes on export.
    public enum TraceKind: Sendable {
        case llm
        case asr   // automatic speech recognition (Whisper)
        case tts   // text-to-speech
        case custom(String)

        var name: String {
            switch self {
            case .llm: return "llm"
            case .asr: return "asr"
            case .tts: return "tts"
            case .custom(let s): return s
            }
        }
    }

    // MARK: - State

    /// Internal runtime state. Access via the `startLock` serial queue only.
    /// `start()` must be idempotent (Critical Path #6 from the plan).
    private static let startLock = DispatchQueue(label: "dev.edgeprobe.sdk.start", qos: .userInitiated)
    nonisolated(unsafe) private static var _isStarted = false
    nonisolated(unsafe) private static var _apiKey: String?

    /// Number of times `start()` has been called. Useful for asserting idempotency in tests.
    /// Access on `startLock`.
    nonisolated(unsafe) private static var _startCallCount = 0

    internal static let log = Logger(subsystem: "dev.edgeprobe.sdk", category: "core")

    // MARK: - Public API

    /// Initialize the SDK. Idempotent — safe to call more than once; subsequent calls are no-ops.
    ///
    /// - Parameter apiKey: Your public ingest key (starts with `epk_pub_`).
    ///   Safe to ship in the app binary — it is rate-limited and rotatable server-side.
    public static func start(apiKey: String) {
        startLock.sync {
            _startCallCount += 1
            guard !_isStarted else {
                log.debug("EdgeProbe.start called again; ignoring (already initialized)")
                return
            }
            _apiKey = apiKey
            _isStarted = true
            log.info("EdgeProbe initialized")
            // TODO(month-13): wire opentelemetry-swift BatchSpanProcessor on background queue.
            // TODO(month-13): create ring buffer with drop-oldest policy.
            // TODO(month-13): start background exporter.
        }
    }

    /// Trace a block of on-device AI work. The span's duration, success/failure, and
    /// any opted-in content get captured and eventually exported to the backend.
    ///
    /// - Parameters:
    ///   - kind: What this span represents (`.llm`, `.asr`, `.tts`, `.custom`).
    ///   - includeContent: When `true`, prompt/completion/audio-transcript text
    ///     is uploaded to the backend and visible in the authenticated dashboard.
    ///     Default is `false`. Opting in does NOT make the span visible on public
    ///     share URLs (Critical Path #3).
    ///   - block: The work to measure.
    /// - Returns: Whatever `block` returns.
    @discardableResult
    public static func trace<T>(
        _ kind: TraceKind,
        includeContent: Bool = false,
        _ block: () throws -> T
    ) rethrows -> T {
        let started = ContinuousClock.now
        defer {
            let elapsed = started.duration(to: ContinuousClock.now)
            // TODO(month-13): create OTel span with gen_ai.* attributes, push to ring buffer.
            log.debug("trace(\(kind.name)) completed in \(elapsed.components.attoseconds / 1_000_000_000, privacy: .public)ms (includeContent=\(includeContent, privacy: .public))")
        }
        return try block()
    }

    // MARK: - Internal test hooks
    // These are `internal` and only used by the test target via @testable import.

    internal static var isStarted: Bool {
        startLock.sync { _isStarted }
    }

    internal static var startCallCount: Int {
        startLock.sync { _startCallCount }
    }

    /// For tests only — resets the singleton state so the idempotency test can
    /// exercise `start()` from a clean slate. Never expose publicly.
    internal static func __resetForTesting() {
        startLock.sync {
            _isStarted = false
            _apiKey = nil
            _startCallCount = 0
        }
    }
}
