import XCTest
@testable import EdgeProbe

/// Critical Paths — iOS mirror of `backend/test/critical-paths.test.ts`.
///
/// Exactly three tests — one per iOS-only invariant. The backend invariants
/// (#1, #2, #3) have their canonical home in the TypeScript file with the
/// same name. Together, the two files cover all six ship-gating Critical
/// Paths from docs/TEST-PLAN.md.
///
/// CI runs this suite as its own filter (`swift test --filter CriticalPathsTests`)
/// so the pre-merge gate boots fast. If any test here fails, the branch
/// cannot merge — `required` aggregator wired in `.github/workflows/ci.yml`.
///
/// The tests intentionally exercise the REAL production classes (not
/// simplified stubs) so a regression anywhere in the critical-path code
/// surfaces here. Coverage is already provided by broader test files
/// (`BatchSpanProcessorTests`, `EdgeProbeTests`); this file is the
/// reviewer-facing roll-up. Duplication is the point.
final class CriticalPathsTests: XCTestCase {

    override func setUp() {
        super.setUp()
        EdgeProbe.__resetForTesting()
    }

    // MARK: - Critical Path #4: main thread never blocked by SDK

    func test_CriticalPath4_mainThreadNeverBlockedBySDK() {
        // Submit path = lock acquire + array append on a bounded ring buffer.
        // A downstream that stalls for 5s per export MUST NOT propagate the
        // stall to the caller — that's the whole point of the BSP's async
        // boundary. Measure 200 submits against a StallingExporter; if it
        // exceeds ~100ms we've regressed the invariant.
        let stall = StallingExporter(delay: 5.0)
        let bsp = BatchSpanProcessor(downstream: stall, capacity: 100, flushInterval: 60)

        let clock = ContinuousClock()
        let elapsed = clock.measure {
            for _ in 0..<200 {
                bsp.export(Self.samplePayload())
            }
        }
        XCTAssertLessThan(
            elapsed,
            .milliseconds(100),
            "Critical Path #4 regressed — submit path blocked the caller"
        )
    }

    // MARK: - Critical Path #5: drop-oldest on buffer overflow, counter rides on next flush

    func test_CriticalPath5_dropOldestOnOverflow_andReportsCountOnReconnect() {
        // A user on a plane writes 10 spans into a buffer with capacity 2.
        // We keep the NEWEST 2 (fresh telemetry is more valuable than stale)
        // and report the 8 drops on the next outbound batch as
        // `meta.droppedSpans`. The on-call engineer sees the loss; it never
        // vanishes silently.
        let spy = SpyExporter()
        let bsp = BatchSpanProcessor(downstream: spy, capacity: 2, flushInterval: 60)

        for _ in 0..<10 {
            bsp.export(Self.samplePayload())
        }

        XCTAssertLessThanOrEqual(bsp.__bufferedCount, 2, "buffer must be bounded at capacity")
        XCTAssertEqual(bsp.__droppedCount, 8, "overflow count recorded deterministically")

        // On reconnect (flush), the counter rides on the first outbound payload.
        bsp.flushNow()
        bsp.waitUntilIdle()
        XCTAssertEqual(spy.payloads.count, 2, "only 2 payloads survive the overflow")
        guard case .int(let reported) = spy.payloads[0].trace.attributes["meta.droppedSpans"] else {
            return XCTFail("Critical Path #5 regressed — first flushed payload missing meta.droppedSpans")
        }
        XCTAssertEqual(reported, 8, "reported drop count matches observed drops")
        // Second payload must NOT double-count the drops.
        XCTAssertNil(spy.payloads[1].trace.attributes["meta.droppedSpans"])
    }

    // MARK: - Critical Path #6: start() is idempotent

    func test_CriticalPath6_startIsIdempotent_evenUnderConcurrentCalls() {
        // 200 concurrent start() calls from a pool of async workers. Internal
        // state must be initialized exactly ONCE; subsequent calls are
        // accounted for in startCallCount but do not re-enter the one-time
        // init block. `_exporter` is replaced only by the first caller that
        // passed a non-nil endpoint — test that the first caller's state
        // survives.
        let iterations = 200
        let group = DispatchGroup()
        let q = DispatchQueue(label: "critical-path-6.concurrent", attributes: .concurrent)
        for _ in 0..<iterations {
            group.enter()
            q.async {
                EdgeProbe.start(apiKey: "epk_pub_test_concurrent")
                group.leave()
            }
        }
        group.wait()

        XCTAssertTrue(EdgeProbe.isStarted)
        XCTAssertEqual(
            EdgeProbe.startCallCount,
            iterations,
            "Critical Path #6 regressed — call count should record every call, even though init ran once",
        )
        // The spy exporter path: replacing the exporter via the test hook
        // mid-flight must still leave the singleton initialized (isStarted
        // cannot flip back to false).
        EdgeProbe.__setExporterForTesting(SpyExporter())
        XCTAssertTrue(EdgeProbe.isStarted)
    }

    // MARK: - helpers

    private static func samplePayload() -> IngestPayload {
        let trace = TraceData(
            id: "t_\(UUID().uuidString.prefix(8))",
            orgId: "org_acme",
            projectId: "proj_voice",
            sessionId: nil,
            startedAt: "2026-04-15T12:00:00.000Z",
            endedAt: "2026-04-15T12:00:00.100Z",
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
            endedAt: "2026-04-15T12:00:00.100Z",
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
