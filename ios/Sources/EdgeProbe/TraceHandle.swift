import Foundation
import os

/// Captures prompt / completion / ASR transcript text during a span's block.
/// Handed into the block as an optional argument by `TraceHandle.span(...)`.
///
/// The reporter is only honored when the enclosing span declared
/// `includeContent: true`. Regardless of what the caller writes here, the
/// backend's `/r/:token` public share endpoint drops these fields, and the
/// web view layer never imports a type that has them. Content only ever
/// surfaces on the authed dashboard.
///
/// Thread-safe: setters use an NSLock so an async span can stream tokens
/// and update `completionText` mid-flight without UB.
public final class SpanReporter: @unchecked Sendable {
    private let lock = NSLock()
    private var _promptText: String?
    private var _completionText: String?
    private var _transcriptText: String?
    private var _attributes: [String: AttributeValue] = [:]

    public init() {}

    /// The user's prompt for an LLM span, or `nil` if not captured.
    public var promptText: String? {
        get { lock.lock(); defer { lock.unlock() }; return _promptText }
        set { lock.lock(); defer { lock.unlock() }; _promptText = newValue }
    }

    /// The model's completion for an LLM span, or `nil`.
    public var completionText: String? {
        get { lock.lock(); defer { lock.unlock() }; return _completionText }
        set { lock.lock(); defer { lock.unlock() }; _completionText = newValue }
    }

    /// The recognized transcript for an ASR span, or the synthesized text for a TTS span.
    public var transcriptText: String? {
        get { lock.lock(); defer { lock.unlock() }; return _transcriptText }
        set { lock.lock(); defer { lock.unlock() }; _transcriptText = newValue }
    }

    /// Attach a custom attribute (`gen_ai.request.model = "llama-3.2-1b-q4"`, etc).
    public func setAttribute(_ key: String, _ value: AttributeValue) {
        lock.lock(); defer { lock.unlock() }
        _attributes[key] = value
    }

    /// Snapshot everything the reporter has collected. Internal so the
    /// TraceHandle can freeze state at span-close.
    internal func snapshot() -> (
        promptText: String?,
        completionText: String?,
        transcriptText: String?,
        attributes: [String: AttributeValue]
    ) {
        lock.lock(); defer { lock.unlock() }
        return (_promptText, _completionText, _transcriptText, _attributes)
    }
}

/// Groups multiple spans under one traceId. Produced by `EdgeProbe.beginTrace()`.
///
/// Use this when one user-facing event is composed of several stages that
/// each deserve their own span. The archetypal case is a voice turn:
///
/// ```swift
/// let turn = EdgeProbe.beginTrace()
/// let transcript = try await turn.span(.asr, name: "whisper", includeContent: true) { r in
///     let text = try await asr.recognize(audio)
///     r.transcriptText = text
///     return text
/// }
/// let reply = try await turn.span(.llm, name: "llama-decode", includeContent: true) { r in
///     r.promptText = transcript
///     let out = try await llm.generate(transcript)
///     r.completionText = out
///     return out
/// }
/// try await turn.span(.tts, name: "say") {
///     try await tts.speak(reply)
/// }
/// turn.end()
/// ```
///
/// Every span created through the handle shares `handle.id` as its `traceId`,
/// so the backend stores them under one trace and the dashboard waterfall
/// puts them on one timeline.
///
/// `end()` flushes all collected spans as a single `IngestPayload`. Calling
/// it twice is a no-op. If the caller forgets, `deinit` forces a flush so
/// we never silently drop data — but tests and production code should call
/// `end()` explicitly so you can await delivery.
public final class TraceHandle: @unchecked Sendable {
    private let traceId: String
    private let orgId: String
    private let projectId: String
    private let sessionId: String?
    private let startInstant: Date
    private let exporter: SpanExporter?
    private let device: [String: AttributeValue]
    private let traceAttributes: [String: AttributeValue]
    private let isSensitive: Bool
    private let iso: ISO8601DateFormatter

    private let lock = NSLock()
    private var spans: [SpanData] = []
    private var ended = false

    internal init(
        traceId: String,
        orgId: String,
        projectId: String,
        sessionId: String?,
        startInstant: Date,
        exporter: SpanExporter?,
        device: [String: AttributeValue],
        traceAttributes: [String: AttributeValue],
        isSensitive: Bool
    ) {
        self.traceId = traceId
        self.orgId = orgId
        self.projectId = projectId
        self.sessionId = sessionId
        self.startInstant = startInstant
        self.exporter = exporter
        self.device = device
        self.traceAttributes = traceAttributes
        self.isSensitive = isSensitive
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        self.iso = fmt
    }

    /// The traceId every span on this handle shares. Surface this in UI when
    /// the user taps "share" so your app can POST to `/app/trace/:id/share`
    /// and get back a token for the public URL.
    public var id: String { traceId }

    // MARK: - sync span (block returns T, optionally receives a SpanReporter)

    @discardableResult
    public func span<T>(
        _ kind: EdgeProbe.TraceKind,
        name: String? = nil,
        includeContent: Bool = false,
        _ block: () throws -> T
    ) rethrows -> T {
        let reporter = SpanReporter()
        return try runSync(kind: kind, name: name, includeContent: includeContent, reporter: reporter) {
            try block()
        }
    }

    @discardableResult
    public func span<T>(
        _ kind: EdgeProbe.TraceKind,
        name: String? = nil,
        includeContent: Bool = false,
        _ block: (SpanReporter) throws -> T
    ) rethrows -> T {
        let reporter = SpanReporter()
        return try runSync(kind: kind, name: name, includeContent: includeContent, reporter: reporter) {
            try block(reporter)
        }
    }

    // MARK: - async span (for ASR, LLM, TTS — everything real)
    //
    // `@Sendable` on the closure parameter is what makes this pleasant to
    // use from `@MainActor` sites (every real voice-turn caller is on main:
    // the UI owns the mic button). `@MainActor` closures are implicitly
    // `Sendable`, so they satisfy the constraint; nonisolated test closures
    // that only capture Sendable state also satisfy it. Without it, Swift 6
    // flags "sending non-Sendable closure risks a data race" at every
    // caller. `T: Sendable` is required because the return hops back across
    // the actor boundary.

    @discardableResult
    public func span<T: Sendable>(
        _ kind: EdgeProbe.TraceKind,
        name: String? = nil,
        includeContent: Bool = false,
        _ block: @Sendable @escaping () async throws -> T
    ) async rethrows -> T {
        let reporter = SpanReporter()
        return try await runAsync(kind: kind, name: name, includeContent: includeContent, reporter: reporter) {
            try await block()
        }
    }

    @discardableResult
    public func span<T: Sendable>(
        _ kind: EdgeProbe.TraceKind,
        name: String? = nil,
        includeContent: Bool = false,
        _ block: @Sendable @escaping (SpanReporter) async throws -> T
    ) async rethrows -> T {
        let reporter = SpanReporter()
        return try await runAsync(kind: kind, name: name, includeContent: includeContent, reporter: reporter) {
            try await block(reporter)
        }
    }

    // MARK: - end / flush

    /// Flush the collected spans as one `IngestPayload` through the active
    /// exporter. Idempotent — a second call is a no-op, which is what you
    /// want when the `deinit` fallback fires after an explicit `end()`.
    public func end() {
        lock.lock()
        if ended { lock.unlock(); return }
        ended = true
        let collected = spans
        lock.unlock()

        let endInstant = Date()
        guard let exporter else { return } // dry-run: no endpoint configured
        let trace = TraceData(
            id: traceId,
            orgId: orgId,
            projectId: projectId,
            sessionId: sessionId,
            startedAt: iso.string(from: startInstant),
            endedAt: iso.string(from: endInstant),
            device: device,
            attributes: traceAttributes,
            sensitive: isSensitive
        )
        exporter.export(IngestPayload(trace: trace, spans: collected))
    }

    deinit {
        // Belt-and-suspenders: if the caller forgot end(), don't silently lose
        // the data. In tests and production code you should still call end()
        // explicitly so you can observe the flush deterministically.
        if !ended { end() }
    }

    // MARK: - test hook

    /// Snapshot the currently-collected spans without ending the trace.
    /// Tests use this to assert the set of spans accumulated under one id.
    internal var __spansSoFar: [SpanData] {
        lock.lock(); defer { lock.unlock() }
        return spans
    }

    // MARK: - private

    private func runSync<T>(
        kind: EdgeProbe.TraceKind,
        name: String?,
        includeContent: Bool,
        reporter: SpanReporter,
        _ work: () throws -> T
    ) rethrows -> T {
        let started = Date()
        let startClock = ContinuousClock.now
        var threw = false
        defer {
            recordSpan(
                kind: kind,
                name: name,
                started: started,
                ended: Date(),
                durationMs: Self.durationMs(since: startClock),
                status: threw ? "error" : "ok",
                reporter: reporter,
                includeContent: includeContent
            )
        }
        do { return try work() } catch {
            threw = true
            throw error
        }
    }

    private func runAsync<T>(
        kind: EdgeProbe.TraceKind,
        name: String?,
        includeContent: Bool,
        reporter: SpanReporter,
        _ work: @Sendable () async throws -> T
    ) async rethrows -> T {
        let started = Date()
        let startClock = ContinuousClock.now
        var threw = false
        defer {
            recordSpan(
                kind: kind,
                name: name,
                started: started,
                ended: Date(),
                durationMs: Self.durationMs(since: startClock),
                status: threw ? "error" : "ok",
                reporter: reporter,
                includeContent: includeContent
            )
        }
        do { return try await work() } catch {
            threw = true
            throw error
        }
    }

    private func recordSpan(
        kind: EdgeProbe.TraceKind,
        name: String?,
        started: Date,
        ended: Date,
        durationMs: Int,
        status: String,
        reporter: SpanReporter,
        includeContent: Bool
    ) {
        let snap = reporter.snapshot()
        let span = SpanData(
            id: EdgeProbe.makeHexId(8),
            traceId: traceId,
            parentSpanId: nil,
            name: name ?? kind.name,
            kind: kind.name,
            startedAt: iso.string(from: started),
            endedAt: iso.string(from: ended),
            durationMs: durationMs,
            status: status,
            attributes: snap.attributes,
            includeContent: includeContent,
            promptText: includeContent ? snap.promptText : nil,
            completionText: includeContent ? snap.completionText : nil,
            transcriptText: includeContent ? snap.transcriptText : nil
        )
        lock.lock()
        spans.append(span)
        lock.unlock()
    }

    private static func durationMs(since start: ContinuousClock.Instant) -> Int {
        let delta = start.duration(to: ContinuousClock.now)
        let ns = delta.components.attoseconds / 1_000_000_000
        return Int(max(0, ns / 1_000_000))
    }
}
