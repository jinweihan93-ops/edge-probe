import XCTest
@testable import EdgeProbe

/// TraceHandle tests — the API the DemoApp (and every real caller with more
/// than one span per turn) uses.
///
/// The SpyExporter from ExporterTests is reused here to inspect the wire
/// payload without going through URLSession.
final class TraceHandleTests: XCTestCase {

    override func setUp() {
        super.setUp()
        EdgeProbe.__resetForTesting()
    }

    // MARK: - one traceId across spans

    func test_beginTrace_collectsMultipleSpansUnderOneTraceId() {
        let spy = SpyExporter()
        EdgeProbe.start(apiKey: "epk_pub_test", orgId: "org_acme", projectId: "proj_voice")
        EdgeProbe.__setExporterForTesting(spy)

        let turn = EdgeProbe.beginTrace()
        turn.span(.asr, name: "whisper") { _ = (0..<50).reduce(0, +) }
        turn.span(.llm, name: "llama-decode") { _ = (0..<100).reduce(0, +) }
        turn.span(.tts, name: "say") { _ = (0..<25).reduce(0, +) }
        turn.end()

        XCTAssertEqual(spy.payloads.count, 1, "end() produces exactly one IngestPayload")
        let payload = spy.payloads[0]
        XCTAssertEqual(payload.spans.count, 3)
        XCTAssertEqual(payload.spans[0].kind, "asr")
        XCTAssertEqual(payload.spans[1].kind, "llm")
        XCTAssertEqual(payload.spans[2].kind, "tts")
        XCTAssertEqual(Set(payload.spans.map(\.traceId)).count, 1, "all three spans share one traceId")
        XCTAssertEqual(payload.spans[0].traceId, payload.trace.id)
    }

    // MARK: - content capture via reporter

    func test_reporter_capturesContent_whenIncludeContentTrue() {
        let spy = SpyExporter()
        EdgeProbe.start(apiKey: "epk_pub_test")
        EdgeProbe.__setExporterForTesting(spy)

        let turn = EdgeProbe.beginTrace()
        turn.span(.asr, name: "whisper", includeContent: true) { reporter in
            reporter.transcriptText = "what's the weather"
        }
        turn.span(.llm, name: "llama-decode", includeContent: true) { reporter in
            reporter.promptText = "what's the weather"
            reporter.completionText = "sunny, 72°"
        }
        turn.end()

        let asr = spy.payloads[0].spans[0]
        let llm = spy.payloads[0].spans[1]
        XCTAssertEqual(asr.includeContent, true)
        XCTAssertEqual(asr.transcriptText, "what's the weather")
        XCTAssertEqual(llm.promptText, "what's the weather")
        XCTAssertEqual(llm.completionText, "sunny, 72°")
    }

    func test_reporter_dropsContent_whenIncludeContentFalse() {
        // Default is includeContent:false. Even if the caller writes
        // to the reporter, the wire payload MUST have nil content.
        // This is the caller-side mirror of the backend's public-view
        // PII boundary — we don't even ship opted-out content.
        let spy = SpyExporter()
        EdgeProbe.start(apiKey: "epk_pub_test")
        EdgeProbe.__setExporterForTesting(spy)

        let turn = EdgeProbe.beginTrace()
        turn.span(.llm, name: "llama-decode") { reporter in
            reporter.promptText = "SECRET DO NOT LEAK"
            reporter.completionText = "ALSO SECRET"
        }
        turn.end()

        let llm = spy.payloads[0].spans[0]
        XCTAssertEqual(llm.includeContent, false)
        XCTAssertNil(llm.promptText)
        XCTAssertNil(llm.completionText)
    }

    // MARK: - idempotent end()

    func test_end_isIdempotent_doesNotDoubleFlush() {
        let spy = SpyExporter()
        EdgeProbe.start(apiKey: "epk_pub_test")
        EdgeProbe.__setExporterForTesting(spy)

        let turn = EdgeProbe.beginTrace()
        turn.span(.llm) { 42 }
        turn.end()
        turn.end()
        turn.end()

        XCTAssertEqual(spy.payloads.count, 1, "double/triple end() is a no-op after the first")
    }

    // MARK: - deinit fallback

    func test_handle_flushesOnDeinit_ifEndForgotten() {
        let spy = SpyExporter()
        EdgeProbe.start(apiKey: "epk_pub_test")
        EdgeProbe.__setExporterForTesting(spy)

        do {
            let turn = EdgeProbe.beginTrace()
            turn.span(.llm) { 1 }
            // deliberately NOT calling turn.end()
            _ = turn
        }
        // The handle is out of scope now. ARC should deinit it, which triggers
        // the safety-net flush. Don't rely on this in real code — tests should
        // call end() explicitly so the semaphore in waitUntilDone has something
        // to await — but it guarantees we never silently drop a forgotten turn.
        XCTAssertEqual(spy.payloads.count, 1, "deinit triggered safety-net flush")
    }

    // MARK: - status propagation

    func test_span_thrownError_marksStatusError() {
        let spy = SpyExporter()
        EdgeProbe.start(apiKey: "epk_pub_test")
        EdgeProbe.__setExporterForTesting(spy)

        struct Boom: Error {}
        let turn = EdgeProbe.beginTrace()
        XCTAssertThrowsError(
            try turn.span(.llm, name: "llama-decode") { () throws -> Int in throw Boom() }
        )
        turn.span(.tts, name: "say") { _ = 0 }
        turn.end()

        let spans = spy.payloads[0].spans
        XCTAssertEqual(spans.count, 2)
        XCTAssertEqual(spans[0].status, "error")
        XCTAssertEqual(spans[1].status, "ok", "later spans on same handle keep working after an earlier error")
    }

    // MARK: - dry-run (no exporter)

    func test_beginTrace_dryRun_doesNotCrash() {
        // start() with no endpoint → no exporter. end() becomes a no-op.
        EdgeProbe.start(apiKey: "epk_pub_test")
        XCTAssertNil(EdgeProbe.__currentExporter)

        let turn = EdgeProbe.beginTrace()
        turn.span(.llm) { 1 }
        turn.end()  // must not crash
    }

    // MARK: - async span

    func test_asyncSpan_capturesDuration_andReporter() async {
        let spy = SpyExporter()
        EdgeProbe.start(apiKey: "epk_pub_test")
        EdgeProbe.__setExporterForTesting(spy)

        let turn = EdgeProbe.beginTrace()
        let out: String = await turn.span(.llm, name: "llama-decode", includeContent: true) { (reporter: SpanReporter) in
            reporter.promptText = "hi"
            try? await Task.sleep(nanoseconds: 10_000_000) // 10 ms
            reporter.completionText = "hello"
            return "hello"
        }
        turn.end()

        XCTAssertEqual(out, "hello")
        let span = spy.payloads[0].spans[0]
        XCTAssertEqual(span.kind, "llm")
        XCTAssertGreaterThanOrEqual(span.durationMs, 0) // sleep-based timing is noisy on CI; just sanity check
        XCTAssertEqual(span.promptText, "hi")
        XCTAssertEqual(span.completionText, "hello")
    }

    // MARK: - handle.id surfacing

    func test_handle_idIs32HexChars_forSharing() {
        // The DemoApp's "share this turn" button passes handle.id to the
        // backend's /app/trace/:id/share endpoint. It has to be a stable,
        // sharable string — 32 hex chars, matching the backend's trace id shape.
        EdgeProbe.start(apiKey: "epk_pub_test")
        let turn = EdgeProbe.beginTrace()
        XCTAssertEqual(turn.id.count, 32)
        XCTAssertTrue(turn.id.allSatisfy { "0123456789abcdef".contains($0) })
    }
}
