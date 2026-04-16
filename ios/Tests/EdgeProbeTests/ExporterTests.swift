import XCTest
@testable import EdgeProbe

/// These tests prove two things:
/// 1. HTTPSpanExporter sends the exact HTTP request the backend expects
///    (method, headers, JSON body shape)
/// 2. EdgeProbe.trace() produces a wire payload that round-trips through
///    the backend's contract — same field names, same types, same nullability
///
/// The URLProtocol mock lets us intercept URLSession without a live server.
/// A parallel scripts/e2e.sh runs the real backend and proves it for real.
final class ExporterTests: XCTestCase {

    override func setUp() {
        super.setUp()
        EdgeProbe.__resetForTesting()
        MockURLProtocol.reset()
    }

    // MARK: - HTTPSpanExporter contract

    func test_httpExporter_sendsPostToEndpointWithBearerKey() throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: config)

        let endpoint = URL(string: "https://example.test/ingest")!
        let exporter = HTTPSpanExporter(endpoint: endpoint, apiKey: "epk_pub_k1", session: session)

        let payload = samplePayload()
        let expectRequest = expectation(description: "request observed")
        MockURLProtocol.onRequest = { req in
            XCTAssertEqual(req.url, endpoint)
            XCTAssertEqual(req.httpMethod, "POST")
            XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer epk_pub_k1")
            XCTAssertEqual(req.value(forHTTPHeaderField: "Content-Type"), "application/json")
            XCTAssertTrue(req.value(forHTTPHeaderField: "User-Agent")?.hasPrefix("edgeprobe-ios/") ?? false)
            expectRequest.fulfill()
            return (200, Data("{\"ok\":true}".utf8))
        }

        exporter.export(payload)
        exporter.waitUntilDone(timeout: 3.0)
        wait(for: [expectRequest], timeout: 3.0)
    }

    func test_httpExporter_encodesPayloadMatchingBackendShape() throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: config)

        let exporter = HTTPSpanExporter(
            endpoint: URL(string: "https://example.test/ingest")!,
            apiKey: "epk_pub_k1",
            session: session
        )

        let payload = samplePayload()

        let expectRequest = expectation(description: "request observed")
        MockURLProtocol.onRequest = { req in
            // URLProtocol strips the body into `HTTPBodyStream` on the
            // ephemeral session. Pull it back out via the stream.
            let body = req.bodyData
            XCTAssertNotNil(body)
            let json = try? JSONSerialization.jsonObject(with: body!) as? [String: Any]
            XCTAssertNotNil(json)

            let trace = json?["trace"] as? [String: Any]
            XCTAssertEqual(trace?["id"] as? String, payload.trace.id)
            XCTAssertEqual(trace?["orgId"] as? String, payload.trace.orgId)
            XCTAssertEqual(trace?["projectId"] as? String, payload.trace.projectId)
            XCTAssertEqual(trace?["sensitive"] as? Bool, false)

            let spans = json?["spans"] as? [[String: Any]]
            XCTAssertEqual(spans?.count, 1)
            let s = spans?.first
            XCTAssertEqual(s?["name"] as? String, "llama-decode")
            XCTAssertEqual(s?["kind"] as? String, "llm")
            XCTAssertEqual(s?["durationMs"] as? Int, 600)
            XCTAssertEqual(s?["status"] as? String, "ok")
            XCTAssertEqual(s?["includeContent"] as? Bool, false)

            expectRequest.fulfill()
            return (202, Data())
        }

        exporter.export(payload)
        exporter.waitUntilDone(timeout: 3.0)
        wait(for: [expectRequest], timeout: 3.0)
    }

    // MARK: - EdgeProbe.trace() → exporter wiring

    func test_trace_emitsSpanThroughSpyExporter() {
        let spy = SpyExporter()
        EdgeProbe.start(apiKey: "epk_pub_test", orgId: "org_acme", projectId: "proj_voice")
        EdgeProbe.__setExporterForTesting(spy)

        EdgeProbe.trace(.llm, name: "llama-decode") {
            // pretend to do work
            _ = (0..<100).reduce(0, +)
        }

        XCTAssertEqual(spy.payloads.count, 1)
        let payload = spy.payloads[0]
        XCTAssertEqual(payload.trace.orgId, "org_acme")
        XCTAssertEqual(payload.trace.projectId, "proj_voice")
        XCTAssertEqual(payload.trace.sensitive, false)
        XCTAssertEqual(payload.spans.count, 1)

        let span = payload.spans[0]
        XCTAssertEqual(span.name, "llama-decode")
        XCTAssertEqual(span.kind, "llm")
        XCTAssertEqual(span.status, "ok")
        XCTAssertEqual(span.includeContent, false)
        XCTAssertNil(span.promptText, "Day 1: prompt/completion text not captured by the macro yet")
        XCTAssertGreaterThanOrEqual(span.durationMs, 0)
    }

    func test_trace_thrownError_marksStatusError() {
        let spy = SpyExporter()
        EdgeProbe.start(apiKey: "epk_pub_test")
        EdgeProbe.__setExporterForTesting(spy)

        struct Boom: Error {}
        XCTAssertThrowsError(
            try EdgeProbe.trace(.llm) { () throws -> Int in throw Boom() }
        )
        XCTAssertEqual(spy.payloads.count, 1)
        XCTAssertEqual(spy.payloads[0].spans[0].status, "error")
    }

    func test_trace_dryRunWithoutEndpoint_doesNotCrash() {
        // start() with no endpoint → no exporter → no network. Must still complete.
        EdgeProbe.start(apiKey: "epk_pub_test")
        XCTAssertNil(EdgeProbe.__currentExporter)
        let result = EdgeProbe.trace(.llm) { "ok" }
        XCTAssertEqual(result, "ok")
    }

    // MARK: - helpers

    private func samplePayload() -> IngestPayload {
        let trace = TraceData(
            id: "trace_deadbeef",
            orgId: "org_acme",
            projectId: "proj_voice",
            sessionId: nil,
            startedAt: "2026-04-15T12:00:00.000Z",
            endedAt: "2026-04-15T12:00:00.600Z",
            device: ["device.os": .string("iOS")],
            attributes: [:],
            sensitive: false
        )
        let span = SpanData(
            id: "span_cafef00d",
            traceId: "trace_deadbeef",
            parentSpanId: nil,
            name: "llama-decode",
            kind: "llm",
            startedAt: "2026-04-15T12:00:00.000Z",
            endedAt: "2026-04-15T12:00:00.600Z",
            durationMs: 600,
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

/// Captures every payload submitted through the SpanExporter protocol.
/// Used to verify EdgeProbe.trace() produces correct wire shapes without
/// going through URLSession.
final class SpyExporter: SpanExporter, @unchecked Sendable {
    private let lock = NSLock()
    private var _payloads: [IngestPayload] = []
    var payloads: [IngestPayload] {
        lock.lock(); defer { lock.unlock() }
        return _payloads
    }
    func export(_ payload: IngestPayload) {
        lock.lock(); defer { lock.unlock() }
        _payloads.append(payload)
    }
}

/// Intercepts URLSession requests so we can assert on them without a server.
/// Standard Swift testing pattern — see WWDC 2018 "Testing Tips & Tricks".
final class MockURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var onRequest: (@Sendable (URLRequest) -> (Int, Data))? = nil

    static func reset() { onRequest = nil }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = MockURLProtocol.onRequest else {
            client?.urlProtocol(self, didFailWithError: NSError(domain: "mock", code: -1))
            return
        }
        let (status, data) = handler(request)
        let resp = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

// URLRequest convenience to read the body regardless of whether it came
// as .httpBody (direct) or .httpBodyStream (serialized upload).
private extension URLRequest {
    var bodyData: Data? {
        if let b = httpBody { return b }
        guard let stream = httpBodyStream else { return nil }
        stream.open(); defer { stream.close() }
        var data = Data()
        let bufferSize = 4096
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer { buffer.deallocate() }
        while stream.hasBytesAvailable {
            let read = stream.read(buffer, maxLength: bufferSize)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}
