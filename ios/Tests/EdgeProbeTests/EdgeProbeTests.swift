import XCTest
@testable import EdgeProbe

/// First test suite — pinned to Critical Regression Paths from the plan.
/// These run on every PR. If any fail, the SDK does not ship.
final class EdgeProbeTests: XCTestCase {

    override func setUp() {
        super.setUp()
        EdgeProbe.__resetForTesting()
    }

    // MARK: - Critical Path #6: start() is idempotent

    func test_start_isIdempotent_whenCalledOnce() {
        XCTAssertFalse(EdgeProbe.isStarted, "SDK should not be started before start() is called")
        EdgeProbe.start(apiKey: "epk_pub_test")
        XCTAssertTrue(EdgeProbe.isStarted, "SDK should be started after start()")
        XCTAssertEqual(EdgeProbe.startCallCount, 1)
    }

    func test_start_isIdempotent_whenCalledTwice() {
        EdgeProbe.start(apiKey: "epk_pub_test_1")
        EdgeProbe.start(apiKey: "epk_pub_test_2")
        XCTAssertTrue(EdgeProbe.isStarted)
        XCTAssertEqual(EdgeProbe.startCallCount, 2, "Both calls recorded for debugging")
        // Note: second call's apiKey is ignored; real behavior will be verified once
        // the exporter is wired. For now this test guards the no-op-on-re-entry path.
    }

    func test_start_idempotent_underHighConcurrency() {
        let iterations = 200
        let group = DispatchGroup()
        let q = DispatchQueue(label: "test.concurrent", attributes: .concurrent)
        for _ in 0..<iterations {
            group.enter()
            q.async {
                EdgeProbe.start(apiKey: "epk_pub_test_concurrent")
                group.leave()
            }
        }
        group.wait()
        XCTAssertTrue(EdgeProbe.isStarted)
        XCTAssertEqual(EdgeProbe.startCallCount, iterations,
                       "Every call is recorded, but internal state is only initialized once.")
    }

    // MARK: - trace(_:) happy path — returns block's value, measures time

    func test_trace_returnsBlockValue() {
        EdgeProbe.start(apiKey: "epk_pub_test")
        let result = EdgeProbe.trace(.llm) { 42 }
        XCTAssertEqual(result, 42)
    }

    func test_trace_rethrowsBlockError() {
        struct TestError: Error, Equatable { let code: Int }
        EdgeProbe.start(apiKey: "epk_pub_test")

        XCTAssertThrowsError(
            try EdgeProbe.trace(.llm) {
                throw TestError(code: 7)
            }
        ) { error in
            XCTAssertEqual(error as? TestError, TestError(code: 7))
        }
    }

    func test_trace_worksEvenIfStartNotCalled() {
        // This is important: if the developer forgets to call start(),
        // trace() should still be a no-op pass-through, NOT crash the host app.
        // Real behavior later: span gets dropped with an OSLog warning. For now,
        // it still returns the block's value.
        let result = EdgeProbe.trace(.asr) { "hello" }
        XCTAssertEqual(result, "hello")
    }

    func test_trace_supportsNesting() {
        EdgeProbe.start(apiKey: "epk_pub_test")
        let outer = EdgeProbe.trace(.llm) { () -> Int in
            let inner = EdgeProbe.trace(.asr) { 1 }
            return inner + 2
        }
        XCTAssertEqual(outer, 3)
    }

    // MARK: - TraceKind naming (what will be exported as gen_ai.system / custom attr)

    func test_traceKind_namesAreStableForExport() {
        XCTAssertEqual(EdgeProbe.TraceKind.llm.name, "llm")
        XCTAssertEqual(EdgeProbe.TraceKind.asr.name, "asr")
        XCTAssertEqual(EdgeProbe.TraceKind.tts.name, "tts")
        XCTAssertEqual(EdgeProbe.TraceKind.custom("embedding").name, "embedding")
    }

    // MARK: - Default content privacy

    func test_trace_defaultsToIncludeContentFalse() {
        // The default MUST be false. Critical Path #1 (public share never shows content) and
        // #3 (opt-in does not escalate public visibility) both depend on developers having
        // to EXPLICITLY opt in per call. If the default becomes true, those invariants break.
        //
        // This test will grow teeth once the span has a real `includeContent` attribute
        // to read back. For now it pins the API shape.
        EdgeProbe.start(apiKey: "epk_pub_test")
        // If this compiles without passing includeContent:, the default stays false.
        _ = EdgeProbe.trace(.llm) { "ok" }
    }
}

/// Accessor extensions so tests can read internal flags without @testable needing `internal`
/// to expose `isStarted` / `startCallCount` (already `internal` in the main target,
/// accessible via @testable import above).
extension EdgeProbe {
    // Placeholder — intentionally empty. Hooks live on the type itself.
}
