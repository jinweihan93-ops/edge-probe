import Foundation
import os

/// Anything that can take a captured span and try to ship it somewhere.
/// The ring buffer + BatchSpanProcessor from the plan will sit between
/// `EdgeProbe.trace()` and an `SpanExporter`.
public protocol SpanExporter: Sendable {
    /// Export one (trace, spans) batch. Must not block the caller —
    /// real implementations dispatch to a background queue.
    func export(_ payload: IngestPayload)
}

/// Fire-and-forget HTTP exporter. Day-1 implementation: every call turns into
/// one POST /ingest with no retry, no batching, no ring buffer. Ring buffer +
/// drop-oldest + reconnect counter land in the next commit (Critical Paths
/// #4 and #5 from docs/TEST-PLAN.md).
///
/// What this DOES guarantee today:
/// - never blocks the caller (all work on `exportQueue`)
/// - never crashes the host app on network error (errors go to OSLog)
/// - sends the exact JSON shape the backend expects (proven by end-to-end tests)
public final class HTTPSpanExporter: SpanExporter {
    private let endpoint: URL
    private let apiKey: String
    private let session: URLSession
    private let exportQueue: DispatchQueue
    private static let log = Logger(subsystem: "dev.edgeprobe.sdk", category: "exporter")

    public init(
        endpoint: URL,
        apiKey: String,
        session: URLSession = .shared,
        queue: DispatchQueue = DispatchQueue(label: "dev.edgeprobe.sdk.export", qos: .utility)
    ) {
        self.endpoint = endpoint
        self.apiKey = apiKey
        self.session = session
        self.exportQueue = queue
    }

    public func export(_ payload: IngestPayload) {
        exportQueue.async { [weak self] in
            guard let self else { return }
            self.sendNow(payload)
        }
    }

    /// Synchronous send, called on `exportQueue`. Tests can observe completion
    /// by using an injected URLSession whose URLProtocol mock fulfils an expectation.
    private func sendNow(_ payload: IngestPayload) {
        var req = URLRequest(url: endpoint)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        req.setValue("edgeprobe-ios/0.0.1", forHTTPHeaderField: "User-Agent")

        do {
            let encoder = JSONEncoder()
            req.httpBody = try encoder.encode(payload)
        } catch {
            Self.log.error("failed to encode ingest payload: \(error.localizedDescription, privacy: .public)")
            return
        }

        let task = session.dataTask(with: req) { data, response, error in
            if let error {
                Self.log.error("ingest POST failed: \(error.localizedDescription, privacy: .public)")
                return
            }
            guard let http = response as? HTTPURLResponse else {
                Self.log.error("ingest POST returned non-HTTP response")
                return
            }
            if !(200..<300).contains(http.statusCode) {
                let bodyStr = data.flatMap { String(data: $0, encoding: .utf8) } ?? "<no body>"
                Self.log.error("ingest POST \(http.statusCode, privacy: .public): \(bodyStr, privacy: .public)")
            }
        }
        task.resume()
    }

    /// Synchronously wait for all in-flight work on the export queue to finish.
    /// Tests use this to await delivery without sleeping.
    public func waitUntilDone(timeout: TimeInterval = 5.0) {
        let sem = DispatchSemaphore(value: 0)
        exportQueue.async { sem.signal() }
        _ = sem.wait(timeout: .now() + timeout)
    }
}
