import Foundation
import os

/// Sits between `EdgeProbe.trace()` and a terminal `SpanExporter`
/// (typically `HTTPSpanExporter`). Submit path is non-blocking: a lock
/// acquire + array append on a bounded ring buffer, then return. A
/// background queue drains the buffer at a fixed interval or on explicit
/// `flushNow()`.
///
/// This is the SDK's answer to two Critical Regression Paths from
/// docs/TEST-PLAN.md:
///
///   #4  Main thread never blocks on export — `export()` does not wait
///       for network I/O, JSON encoding, or anything else slow. Worst case
///       is a ~µs lock acquire. Test: `test_export_returnsImmediately_*`.
///
///   #5  Network outage does not OOM — buffer is bounded (default 512
///       payloads). On overflow the oldest payload is dropped and a
///       counter increments. The counter rides on the next outbound batch
///       as `trace.attributes["meta.droppedSpans"]` so a watching human
///       sees the silent loss instead of it vanishing. Test:
///       `test_droppedCount_ridesOnNextFlush`.
public final class BatchSpanProcessor: SpanExporter, @unchecked Sendable {
    private let buffer: RingBuffer<IngestPayload>
    private let downstream: SpanExporter
    private let flushQueue: DispatchQueue
    private let flushInterval: TimeInterval
    private var timer: DispatchSourceTimer?
    private static let log = Logger(subsystem: "dev.edgeprobe.sdk", category: "batch")

    public init(
        downstream: SpanExporter,
        capacity: Int = 512,
        flushInterval: TimeInterval = 2.0,
        queue: DispatchQueue = DispatchQueue(label: "dev.edgeprobe.sdk.batch", qos: .utility)
    ) {
        self.buffer = RingBuffer(capacity: capacity)
        self.downstream = downstream
        self.flushQueue = queue
        self.flushInterval = flushInterval
        startTimer()
    }

    /// Non-blocking: pushes onto the ring buffer and returns.
    /// The only work done on the caller's thread is `NSLock.lock` + one
    /// array append. Measured at ~1µs on an iPhone 15 Pro.
    public func export(_ payload: IngestPayload) {
        buffer.push(payload)
    }

    /// Drain the buffer NOW on the flush queue. Used by:
    ///   - tests (deterministic, no waiting for timer)
    ///   - app-backgrounding hook (so a user-backgrounded app flushes before
    ///     iOS suspends us — lands with UIApplication observer in month 13)
    public func flushNow() {
        flushQueue.async { [weak self] in
            self?.drainAndSend()
        }
    }

    /// Synchronously wait for the flush queue to quiesce. Test only.
    /// Every async in `flushQueue` finishes before this returns.
    public func waitUntilIdle(timeout: TimeInterval = 5.0) {
        let sem = DispatchSemaphore(value: 0)
        flushQueue.async { sem.signal() }
        _ = sem.wait(timeout: .now() + timeout)
    }

    // MARK: - Test hooks

    internal var __bufferedCount: Int { buffer.count }
    internal var __droppedCount: Int { buffer.droppedCount }

    // MARK: - Private

    private func startTimer() {
        let t = DispatchSource.makeTimerSource(queue: flushQueue)
        t.schedule(deadline: .now() + flushInterval, repeating: flushInterval)
        t.setEventHandler { [weak self] in
            self?.drainAndSend()
        }
        t.resume()
        self.timer = t
    }

    deinit {
        timer?.cancel()
    }

    /// Drain the ring buffer and ship every payload to the downstream exporter.
    /// If spans were dropped since the last flush, tag the FIRST outbound
    /// payload of this batch with `meta.droppedSpans = n` so the loss is
    /// visible server-side instead of silent.
    ///
    /// Only the first payload is tagged — tagging every one would double-count
    /// in the aggregator and mislead on-call about the magnitude.
    private func drainAndSend() {
        let payloads = buffer.drain()
        guard !payloads.isEmpty else { return }
        let dropped = buffer.consumeDroppedCount()

        if dropped > 0 {
            Self.log.warning("BatchSpanProcessor dropped \(dropped, privacy: .public) spans (buffer overflow)")
        }

        for (idx, payload) in payloads.enumerated() {
            let tagged: IngestPayload
            if idx == 0 && dropped > 0 {
                tagged = Self.tagWithDroppedCount(payload, dropped: dropped)
            } else {
                tagged = payload
            }
            downstream.export(tagged)
        }
    }

    /// Returns a copy of `payload` with `meta.droppedSpans = n` merged into
    /// `trace.attributes`. Pure function — does not mutate input.
    private static func tagWithDroppedCount(_ payload: IngestPayload, dropped: Int) -> IngestPayload {
        var attrs = payload.trace.attributes
        attrs["meta.droppedSpans"] = .int(dropped)
        let newTrace = TraceData(
            id: payload.trace.id,
            orgId: payload.trace.orgId,
            projectId: payload.trace.projectId,
            sessionId: payload.trace.sessionId,
            startedAt: payload.trace.startedAt,
            endedAt: payload.trace.endedAt,
            device: payload.trace.device,
            attributes: attrs,
            sensitive: payload.trace.sensitive
        )
        return IngestPayload(trace: newTrace, spans: payload.spans)
    }
}
