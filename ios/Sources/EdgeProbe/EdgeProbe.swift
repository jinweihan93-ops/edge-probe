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
    nonisolated(unsafe) private static var _exporter: SpanExporter?
    nonisolated(unsafe) private static var _lifecycleObserver: LifecycleObserver?
    nonisolated(unsafe) private static var _orgId: String = "org_unknown"
    nonisolated(unsafe) private static var _projectId: String = "proj_unknown"

    /// Number of times `start()` has been called. Useful for asserting idempotency in tests.
    /// Access on `startLock`.
    nonisolated(unsafe) private static var _startCallCount = 0

    internal static let log = Logger(subsystem: "dev.edgeprobe.sdk", category: "core")

    // MARK: - Public API

    /// Initialize the SDK. Idempotent — safe to call more than once; subsequent calls are no-ops.
    ///
    /// - Parameters:
    ///   - apiKey: Your public ingest key (starts with `epk_pub_`).
    ///     Safe to ship in the app binary — rate-limited and rotatable server-side.
    ///   - endpoint: Backend ingest URL. When `nil`, the SDK runs in dry-run
    ///     mode: spans are captured and timed but nothing is sent. Useful in
    ///     unit tests and while the SDK boots before a network is available.
    ///   - orgId / projectId: Day-1 placeholders until the API key exchange
    ///     endpoint lands in month 13. The server uses the key's associated
    ///     org and the client-declared project name.
    public static func start(
        apiKey: String,
        endpoint: URL? = nil,
        orgId: String = "org_unknown",
        projectId: String = "proj_unknown"
    ) {
        startLock.sync {
            _startCallCount += 1
            guard !_isStarted else {
                log.debug("EdgeProbe.start called again; ignoring (already initialized)")
                return
            }
            _apiKey = apiKey
            _orgId = orgId
            _projectId = projectId
            if let endpoint {
                // Production wiring: trace() → BatchSpanProcessor → HTTPSpanExporter.
                // The BSP sits on a ring buffer so `trace()` never blocks on network I/O
                // (Critical Path #4) and drops oldest on overflow with a visible counter
                // so a dead network can't OOM the host app (Critical Path #5).
                let http = HTTPSpanExporter(endpoint: endpoint, apiKey: apiKey)
                let bsp = BatchSpanProcessor(downstream: http)
                _exporter = bsp

                // Subscribe to UIApplication.didEnterBackgroundNotification so we
                // force-flush the buffer before iOS suspends us. Without this, a
                // user who locks their phone loses up to `flushInterval` seconds
                // of telemetry — precisely the final spans an on-call engineer
                // looking at a crash or hang wants most. No-op on non-iOS.
                let observer = LifecycleObserver(processor: bsp)
                observer.start()
                _lifecycleObserver = observer
            }
            _isStarted = true
            log.info("EdgeProbe initialized (exporter=\(endpoint?.absoluteString ?? "dry-run", privacy: .public))")
        }
    }

    /// Inject a custom exporter (used by tests to assert the wire payload).
    /// Must be called after `start()`. Replaces the HTTP exporter.
    internal static func __setExporterForTesting(_ exporter: SpanExporter) {
        startLock.sync {
            _exporter = exporter
        }
    }

    internal static var __currentExporter: SpanExporter? {
        startLock.sync { _exporter }
    }

    /// Trace a block of on-device AI work. The span's duration, success/failure, and
    /// any opted-in content get captured and eventually exported to the backend.
    ///
    /// - Parameters:
    ///   - kind: What this span represents (`.llm`, `.asr`, `.tts`, `.custom`).
    ///   - name: Optional span name (e.g. "llama-decode"). Defaults to `kind.name`.
    ///   - includeContent: When `true`, prompt/completion/audio-transcript text
    ///     is uploaded to the backend and visible in the authenticated dashboard.
    ///     Default is `false`. Opting in does NOT make the span visible on public
    ///     share URLs (Critical Path #3).
    ///   - block: The work to measure.
    /// - Returns: Whatever `block` returns.
    @discardableResult
    public static func trace<T>(
        _ kind: TraceKind,
        name: String? = nil,
        includeContent: Bool = false,
        _ block: () throws -> T
    ) rethrows -> T {
        let startInstant = Date()
        let startClock = ContinuousClock.now
        let spanName = name ?? kind.name
        var threw: Bool = false
        defer {
            let endInstant = Date()
            let elapsedNs = startClock.duration(to: ContinuousClock.now).components.attoseconds / 1_000_000_000
            let durationMs = Int(max(0, elapsedNs / 1_000_000))
            log.debug("trace(\(spanName, privacy: .public)) \(durationMs, privacy: .public)ms")

            let (exporter, orgId, projectId) = startLock.sync { (_exporter, _orgId, _projectId) }
            if let exporter {
                let traceId = Self.makeHexId(16)
                let spanId = Self.makeHexId(8)
                let iso = ISO8601DateFormatter()
                iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

                let trace = TraceData(
                    id: traceId,
                    orgId: orgId,
                    projectId: projectId,
                    sessionId: nil,
                    startedAt: iso.string(from: startInstant),
                    endedAt: iso.string(from: endInstant),
                    device: currentDeviceAttributes(),
                    attributes: [:],
                    sensitive: false
                )
                let span = SpanData(
                    id: spanId,
                    traceId: traceId,
                    parentSpanId: nil,
                    name: spanName,
                    kind: kind.name,
                    startedAt: iso.string(from: startInstant),
                    endedAt: iso.string(from: endInstant),
                    durationMs: durationMs,
                    status: threw ? "error" : "ok",
                    attributes: [:],
                    includeContent: includeContent,
                    promptText: nil,
                    completionText: nil,
                    transcriptText: nil
                )
                exporter.export(IngestPayload(trace: trace, spans: [span]))
            }
        }
        do {
            return try block()
        } catch {
            threw = true
            throw error
        }
    }

    /// Build a hex id suitable for OTel trace_id (16 bytes = 32 hex chars) or
    /// span_id (8 bytes = 16 hex chars). Real OTel IdGenerator lands with
    /// opentelemetry-swift in month 13.
    private static func makeHexId(_ bytes: Int) -> String {
        var out = ""
        out.reserveCapacity(bytes * 2)
        for _ in 0..<bytes {
            out += String(format: "%02x", UInt8.random(in: 0...255))
        }
        return out
    }

    /// Minimal device attributes. Real impl reads UIDevice / sysctlbyname at
    /// init and caches. Day 1: just mark us as iOS/macOS for the e2e demo.
    private static func currentDeviceAttributes() -> [String: AttributeValue] {
        #if os(iOS)
        return ["device.os": .string("iOS"), "sdk.version": .string("0.0.1")]
        #elseif os(macOS)
        return ["device.os": .string("macOS"), "sdk.version": .string("0.0.1")]
        #else
        return ["device.os": .string("unknown"), "sdk.version": .string("0.0.1")]
        #endif
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
            _exporter = nil
            _lifecycleObserver = nil  // deinit removes the NotificationCenter observer
            _orgId = "org_unknown"
            _projectId = "proj_unknown"
            _startCallCount = 0
        }
    }

    /// Test-only accessor for the lifecycle observer so tests can assert it
    /// was registered and drive `flushForBackground()` directly without
    /// waiting on a real UIApplication notification.
    internal static var __currentLifecycleObserver: LifecycleObserver? {
        startLock.sync { _lifecycleObserver }
    }
}
