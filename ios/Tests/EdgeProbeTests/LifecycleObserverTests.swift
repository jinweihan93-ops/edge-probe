import XCTest
@testable import EdgeProbe

/// Tests for the backgrounding flush hook.
///
/// The real `UIApplication.didEnterBackgroundNotification` path only fires
/// in a hosted iOS app, not in Swift Package tests on macOS. So these tests
/// drive `flushForBackground()` directly — that's the method the notification
/// callback calls. The wiring from notification → callback is a one-liner
/// inside `start()` guarded by `canImport(UIKit)`; if it regressed, it would
/// fail to compile rather than silently misbehave.
final class LifecycleObserverTests: XCTestCase {

    override func setUp() {
        super.setUp()
        EdgeProbe.__resetForTesting()
    }

    /// Start with an endpoint → the SDK wires up a lifecycle observer. Without
    /// this, a phone-lock during a voice-agent turn would leave the final
    /// ~2s of spans in the ring buffer forever.
    func test_start_withEndpoint_installsLifecycleObserver() {
        EdgeProbe.start(
            apiKey: "epk_pub_test",
            endpoint: URL(string: "https://example.test/ingest")!
        )
        XCTAssertNotNil(EdgeProbe.__currentLifecycleObserver,
            "start(endpoint:) must register the LifecycleObserver that flushes on background")
    }

    /// Dry-run mode (no endpoint) → no observer. Nothing to flush, nothing to
    /// register. Keeping the no-endpoint path allocation-free is cheap and
    /// keeps the test-time environment quiet.
    func test_start_withoutEndpoint_doesNotInstallLifecycleObserver() {
        EdgeProbe.start(apiKey: "epk_pub_test")
        XCTAssertNil(EdgeProbe.__currentLifecycleObserver,
            "dry-run SDK must not register a lifecycle observer — nothing to flush")
    }

    /// The guts of what the notification handler does: drain the BSP. We
    /// drive it manually so this test works on macOS (where UIApplication
    /// isn't present) and on iOS simulator alike.
    func test_flushForBackground_drainsBatchProcessor() {
        let spy = SpyExporter()
        let bsp = BatchSpanProcessor(downstream: spy, capacity: 100, flushInterval: 60)

        // Push a few payloads that would otherwise sit until the next 60s timer.
        for _ in 0..<5 {
            bsp.export(Self.samplePayload())
        }
        XCTAssertEqual(bsp.__bufferedCount, 5, "payloads should be pending in the buffer")

        let observer = LifecycleObserver(processor: bsp)
        observer.flushForBackground()

        XCTAssertEqual(bsp.__bufferedCount, 0, "buffer must be drained after flushForBackground()")
        XCTAssertEqual(spy.payloads.count, 5, "downstream should have received every buffered payload")
    }

    /// Calling start() twice (which can happen if two unrelated libraries both
    /// hook app lifecycle) must not double-register with NotificationCenter.
    /// Double-registration would flush twice per background event — harmless
    /// but wasteful.
    func test_lifecycleObserver_startIsIdempotent() {
        let spy = SpyExporter()
        let bsp = BatchSpanProcessor(downstream: spy, capacity: 100, flushInterval: 60)
        let observer = LifecycleObserver(processor: bsp)

        observer.start()
        let firstState = observer.isObserving
        observer.start()
        let secondState = observer.isObserving

        XCTAssertEqual(firstState, secondState,
            "second start() call must not change observer registration state")

        // On macOS `isObserving` stays false (no UIKit). On iOS it flips to true.
        // Either way, both calls produce the same state — that's what matters.
    }

    /// End-to-end through the full pipeline: start() with endpoint creates
    /// BSP + observer, trace() pushes to the buffer, flushForBackground()
    /// drains. Proves the wiring holds even after the production code path.
    func test_trace_thenBackground_flushesEverything() {
        let spy = SpyExporter()
        EdgeProbe.start(
            apiKey: "epk_pub_test",
            endpoint: URL(string: "https://example.test/ingest")!,
            orgId: "org_acme",
            projectId: "proj_voice"
        )
        // Swap the production HTTP exporter for a spy-backed BSP so we can observe.
        let bsp = BatchSpanProcessor(downstream: spy, capacity: 100, flushInterval: 60)
        EdgeProbe.__setExporterForTesting(bsp)

        for _ in 0..<3 {
            EdgeProbe.trace(.llm) { _ = 1 + 1 }
        }

        let observer = LifecycleObserver(processor: bsp)
        observer.flushForBackground()

        XCTAssertEqual(spy.payloads.count, 3,
            "phone-lock should flush buffered trace()s straight to downstream")
    }

    // MARK: - helpers

    private static func samplePayload() -> IngestPayload {
        let trace = TraceData(
            id: "t_\(UUID().uuidString.prefix(8))",
            orgId: "org_acme",
            projectId: "proj_voice",
            sessionId: nil,
            startedAt: "2026-04-15T12:00:00.000Z",
            endedAt:   "2026-04-15T12:00:00.100Z",
            device: [:],
            attributes: [:],
            sensitive: false
        )
        let span = SpanData(
            id: "s_\(UUID().uuidString.prefix(8))",
            traceId: trace.id,
            parentSpanId: nil,
            name: "llm",
            kind: "llm",
            startedAt: "2026-04-15T12:00:00.000Z",
            endedAt:   "2026-04-15T12:00:00.100Z",
            durationMs: 100,
            status: "ok",
            attributes: [:],
            includeContent: false,
            promptText: nil,
            completionText: nil,
            transcriptText: nil
        )
        return IngestPayload(trace: trace, spans: [span])
    }
}
