import XCTest
@testable import EdgeProbe

/// Covers Critical Regression Paths #4 and #5 from docs/TEST-PLAN.md.
///
/// #4 Main thread never blocks on export
///    - `test_bsp_export_returnsImmediately_evenIfDownstreamStalls`
///    - `test_trace_withBSP_neverBlocksEvenIfNetworkStalls`
///
/// #5 Network outage does not OOM; dropped count is surfaced
///    - `test_ringBuffer_overflowDropsOldestAndCounts`
///    - `test_bsp_export_overCapacity_dropsOldestAndTracksCount`
///    - `test_bsp_droppedCount_ridesOnFirstPayloadOfNextFlush`
///    - `test_bsp_droppedCount_doesNotDoubleCountAcrossFlushes`
///
/// If any of these regress, the SDK has silently become dangerous to ship.
/// A user-facing voice agent would either stall on every turn (#4) or
/// spike memory until iOS jetsams the host app (#5).
final class BatchSpanProcessorTests: XCTestCase {

    override func setUp() {
        super.setUp()
        EdgeProbe.__resetForTesting()
    }

    // MARK: - RingBuffer (Critical Path #5 mechanics)

    func test_ringBuffer_holdsUpToCapacity() {
        let rb = RingBuffer<Int>(capacity: 3)
        rb.push(1); rb.push(2); rb.push(3)
        XCTAssertEqual(rb.count, 3)
        XCTAssertEqual(rb.droppedCount, 0)
        XCTAssertEqual(rb.drain(), [1, 2, 3])
    }

    func test_ringBuffer_overflowDropsOldestAndCounts() {
        let rb = RingBuffer<Int>(capacity: 3)
        rb.push(1); rb.push(2); rb.push(3); rb.push(4); rb.push(5)
        // Oldest two (1, 2) evicted; newest three retained.
        XCTAssertEqual(rb.count, 3)
        XCTAssertEqual(rb.droppedCount, 2)
        XCTAssertEqual(rb.drain(), [3, 4, 5])
    }

    func test_ringBuffer_drainClearsStorageButKeepsDroppedCount() {
        let rb = RingBuffer<Int>(capacity: 2)
        rb.push(1); rb.push(2); rb.push(3) // drops 1 → dropped=1
        _ = rb.drain()
        XCTAssertEqual(rb.count, 0)
        // drain() does NOT reset dropped — consumeDroppedCount() does.
        XCTAssertEqual(rb.droppedCount, 1)
    }

    func test_ringBuffer_consumeDroppedCountResets() {
        let rb = RingBuffer<Int>(capacity: 1)
        rb.push(1); rb.push(2); rb.push(3)
        XCTAssertEqual(rb.consumeDroppedCount(), 2)
        XCTAssertEqual(rb.droppedCount, 0)
        // Second consume returns 0 — no double-counting.
        XCTAssertEqual(rb.consumeDroppedCount(), 0)
    }

    func test_ringBuffer_concurrentPushesNeverCrashOrLoseAccounting() {
        let rb = RingBuffer<Int>(capacity: 100)
        let q = DispatchQueue(label: "rb-test", attributes: .concurrent)
        let g = DispatchGroup()
        for i in 0..<1000 {
            q.async(group: g) { rb.push(i) }
        }
        g.wait()
        // Invariant: for every push, either it's in the buffer or it was counted as dropped.
        XCTAssertLessThanOrEqual(rb.count, 100)
        XCTAssertEqual(rb.count + rb.droppedCount, 1000)
    }

    // MARK: - BatchSpanProcessor (Critical Path #4 — non-blocking submit)

    func test_bsp_export_returnsImmediately_evenIfDownstreamStalls() {
        // Downstream sleeps 5s on every export. Without the BSP shielding us,
        // a single trace() call on a stalled network would block the caller for 5s.
        let stall = StallingExporter(delay: 5.0)
        let bsp = BatchSpanProcessor(downstream: stall, capacity: 100, flushInterval: 60)

        let clock = ContinuousClock()
        let elapsed = clock.measure {
            for _ in 0..<200 {
                bsp.export(Self.samplePayload())
            }
        }
        // 200 exports against a 5-second-per-call stalling downstream must
        // complete in well under 100ms — we only do a lock+append per call.
        XCTAssertLessThan(elapsed, .milliseconds(100),
            "BSP.export() blocked the caller — critical path #4 regressed")
    }

    // MARK: - BatchSpanProcessor (Critical Path #5 — overflow + dropped counter)

    func test_bsp_export_overCapacity_dropsOldestAndTracksCount() {
        let spy = SpyExporter()
        let bsp = BatchSpanProcessor(downstream: spy, capacity: 2, flushInterval: 60)

        for _ in 0..<10 {
            bsp.export(Self.samplePayload())
        }

        XCTAssertLessThanOrEqual(bsp.__bufferedCount, 2)
        XCTAssertEqual(bsp.__droppedCount, 8)
    }

    func test_bsp_flushNow_drainsToDownstream() {
        let spy = SpyExporter()
        let bsp = BatchSpanProcessor(downstream: spy, capacity: 100, flushInterval: 60)

        for _ in 0..<5 {
            bsp.export(Self.samplePayload())
        }
        bsp.flushNow()
        bsp.waitUntilIdle()

        XCTAssertEqual(spy.payloads.count, 5)
        XCTAssertEqual(bsp.__bufferedCount, 0)
    }

    func test_bsp_droppedCount_ridesOnFirstPayloadOfNextFlush() {
        let spy = SpyExporter()
        let bsp = BatchSpanProcessor(downstream: spy, capacity: 2, flushInterval: 60)

        // Push 5 with capacity 2 → oldest 3 dropped, newest 2 retained.
        for _ in 0..<5 {
            bsp.export(Self.samplePayload())
        }
        bsp.flushNow()
        bsp.waitUntilIdle()

        XCTAssertEqual(spy.payloads.count, 2, "only 2 payloads survive the overflow")

        // First payload out carries the dropped counter.
        guard case .int(let firstDropped) = spy.payloads[0].trace.attributes["meta.droppedSpans"] else {
            XCTFail("first flushed payload missing meta.droppedSpans")
            return
        }
        XCTAssertEqual(firstDropped, 3)

        // Second payload must NOT carry the counter (would double-count in aggregators).
        XCTAssertNil(spy.payloads[1].trace.attributes["meta.droppedSpans"])
    }

    func test_bsp_droppedCount_doesNotDoubleCountAcrossFlushes() {
        let spy = SpyExporter()
        let bsp = BatchSpanProcessor(downstream: spy, capacity: 2, flushInterval: 60)

        // First batch: drop 3.
        for _ in 0..<5 { bsp.export(Self.samplePayload()) }
        bsp.flushNow()
        bsp.waitUntilIdle()
        XCTAssertEqual(spy.payloads.count, 2)

        // Second batch: no drops. The dropped counter was consumed on the
        // previous flush, so nothing on this batch should carry it.
        bsp.export(Self.samplePayload())
        bsp.flushNow()
        bsp.waitUntilIdle()

        XCTAssertEqual(spy.payloads.count, 3)
        XCTAssertNil(spy.payloads[2].trace.attributes["meta.droppedSpans"],
            "dropped counter leaked into a post-recovery batch")
    }

    // MARK: - trace() → BSP integration (end-to-end of Critical Path #4)

    func test_trace_withBSP_neverBlocksEvenIfNetworkStalls() {
        let stall = StallingExporter(delay: 5.0)
        let bsp = BatchSpanProcessor(downstream: stall, capacity: 512, flushInterval: 60)
        EdgeProbe.start(apiKey: "epk_pub_test")
        EdgeProbe.__setExporterForTesting(bsp)

        let clock = ContinuousClock()
        let elapsed = clock.measure {
            for _ in 0..<50 {
                EdgeProbe.trace(.llm) { _ = (0..<10).reduce(0, +) }
            }
        }
        // 50 traced blocks against a stalling downstream must complete fast.
        // Budget: 50ms for 50 traces (~1ms each including the trivial work).
        XCTAssertLessThan(elapsed, .milliseconds(50),
            "trace() blocked on export — a user's voice agent would stutter on every turn")
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

// MARK: - Test doubles

/// Sleeps for `delay` on every export. Simulates a dead or molasses-slow
/// network without needing URLSession configuration gymnastics.
/// Run on the BSP's flush queue — stalling here MUST NOT propagate to callers.
final class StallingExporter: SpanExporter, @unchecked Sendable {
    let delay: TimeInterval
    init(delay: TimeInterval) { self.delay = delay }
    func export(_ payload: IngestPayload) {
        Thread.sleep(forTimeInterval: delay)
    }
}
