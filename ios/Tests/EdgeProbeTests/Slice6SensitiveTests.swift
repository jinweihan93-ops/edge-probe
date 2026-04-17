import XCTest
@testable import EdgeProbe

/// Slice 6 — SDK-side tests for the `sensitive:` flag and the `includeContent`
/// content-on-the-wire behavior. These sit alongside TraceHandleTests which
/// covers the shared handle machinery; this file is Slice-6-specific so a
/// reviewer can see the contract coverage at a glance.
///
/// What Slice 6 adds on the SDK:
///   1. `EdgeProbe.trace(kind, sensitive: true) { … }` parameter exists and
///      propagates to `IngestPayload.trace.sensitive`.
///   2. `beginTrace(..., sensitive: true)` propagates the same way.
///   3. Default is `false` on both surfaces (Critical Path #1/#3 depend on
///      callers having to opt IN).
///   4. With `includeContent: true`, prompt/completion/transcript text travel
///      on the wire. With `includeContent: false`, they do NOT — even if the
///      SpanReporter captured them. (This mirrors TraceHandleTests; we dup
///      the assertion under a Slice-6 name for the named regression set.)
final class Slice6SensitiveTests: XCTestCase {

    override func setUp() {
        super.setUp()
        EdgeProbe.__resetForTesting()
    }

    // MARK: - beginTrace(sensitive:)

    func test_beginTrace_sensitiveTrue_propagatesToWire() {
        let spy = SpyExporter()
        EdgeProbe.start(apiKey: "epk_pub_test")
        EdgeProbe.__setExporterForTesting(spy)

        let turn = EdgeProbe.beginTrace(sensitive: true)
        turn.span(.llm) { _ = 1 + 1 }
        turn.end()

        XCTAssertEqual(spy.payloads.count, 1)
        XCTAssertTrue(spy.payloads[0].trace.sensitive, "sensitive:true must travel over the wire")
    }

    func test_beginTrace_sensitiveDefaultsFalse() {
        let spy = SpyExporter()
        EdgeProbe.start(apiKey: "epk_pub_test")
        EdgeProbe.__setExporterForTesting(spy)

        let turn = EdgeProbe.beginTrace()
        turn.span(.llm) { _ = 1 + 1 }
        turn.end()

        XCTAssertFalse(spy.payloads[0].trace.sensitive, "sensitive must default false")
    }

    // MARK: - EdgeProbe.trace(sensitive:)

    func test_trace_sensitiveTrue_propagatesToWire() {
        let spy = SpyExporter()
        EdgeProbe.start(apiKey: "epk_pub_test")
        EdgeProbe.__setExporterForTesting(spy)

        _ = EdgeProbe.trace(.llm, sensitive: true) { "out" }

        XCTAssertEqual(spy.payloads.count, 1)
        XCTAssertTrue(spy.payloads[0].trace.sensitive)
    }

    func test_trace_sensitiveDefaultsFalse() {
        let spy = SpyExporter()
        EdgeProbe.start(apiKey: "epk_pub_test")
        EdgeProbe.__setExporterForTesting(spy)

        _ = EdgeProbe.trace(.llm) { "out" }

        XCTAssertFalse(spy.payloads[0].trace.sensitive)
    }

    // MARK: - includeContent on the wire

    func test_includeContent_true_sendsContentOnWire() {
        let spy = SpyExporter()
        EdgeProbe.start(apiKey: "epk_pub_test")
        EdgeProbe.__setExporterForTesting(spy)

        let turn = EdgeProbe.beginTrace()
        turn.span(.llm, includeContent: true) { reporter in
            reporter.promptText = "what is 2+2"
            reporter.completionText = "4"
        }
        turn.end()

        let span = spy.payloads[0].spans[0]
        XCTAssertEqual(span.includeContent, true)
        XCTAssertEqual(span.promptText, "what is 2+2")
        XCTAssertEqual(span.completionText, "4")
    }

    func test_includeContent_false_stripsContentEvenIfReporterWroteIt() {
        // This is THE caller-side invariant. Even when the reporter captured
        // text, the wire payload must have nil content fields if the span
        // wasn't opted-in. The backend would strip them on public too, but
        // we don't trust-and-verify — we don't SEND them in the first place.
        let spy = SpyExporter()
        EdgeProbe.start(apiKey: "epk_pub_test")
        EdgeProbe.__setExporterForTesting(spy)

        let turn = EdgeProbe.beginTrace()
        turn.span(.llm) { reporter in
            reporter.promptText = "SLICE-6-SECRET-PROMPT"
            reporter.completionText = "SLICE-6-SECRET-COMPLETION"
            reporter.transcriptText = "SLICE-6-SECRET-TRANSCRIPT"
        }
        turn.end()

        let span = spy.payloads[0].spans[0]
        XCTAssertEqual(span.includeContent, false)
        XCTAssertNil(span.promptText)
        XCTAssertNil(span.completionText)
        XCTAssertNil(span.transcriptText)
    }

    // MARK: - sensitive is orthogonal to includeContent

    func test_sensitive_and_includeContent_compose() {
        // sensitive:true + includeContent:true is the "medical dashboard only"
        // case: content lands in the store, but the public share URL is 404
        // regardless of any token that gets minted.
        let spy = SpyExporter()
        EdgeProbe.start(apiKey: "epk_pub_test")
        EdgeProbe.__setExporterForTesting(spy)

        let turn = EdgeProbe.beginTrace(sensitive: true)
        turn.span(.llm, includeContent: true) { reporter in
            reporter.promptText = "patient history..."
            reporter.completionText = "diagnosis..."
        }
        turn.end()

        let payload = spy.payloads[0]
        XCTAssertTrue(payload.trace.sensitive)
        XCTAssertEqual(payload.spans[0].includeContent, true)
        XCTAssertEqual(payload.spans[0].promptText, "patient history...")
        XCTAssertEqual(payload.spans[0].completionText, "diagnosis...")
    }
}
