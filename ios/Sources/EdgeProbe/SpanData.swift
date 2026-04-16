import Foundation

/// The wire shape of a single captured span, matching the backend's
/// `StoredSpan` TypeScript interface in backend/src/views.ts.
///
/// Keep these field names in lockstep with the backend. The e2e test proves
/// they line up by POSTing a real JSON and asserting the backend stores it.
public struct SpanData: Codable, Sendable, Equatable {
    public let id: String
    public let traceId: String
    public let parentSpanId: String?
    public let name: String
    public let kind: String          // "llm" | "asr" | "tts" | custom
    public let startedAt: String     // ISO8601
    public let endedAt: String
    public let durationMs: Int
    public let status: String        // "ok" | "error"
    public let attributes: [String: AttributeValue]

    public let includeContent: Bool
    public let promptText: String?
    public let completionText: String?
    public let transcriptText: String?

    public init(
        id: String,
        traceId: String,
        parentSpanId: String?,
        name: String,
        kind: String,
        startedAt: String,
        endedAt: String,
        durationMs: Int,
        status: String,
        attributes: [String: AttributeValue],
        includeContent: Bool,
        promptText: String?,
        completionText: String?,
        transcriptText: String?
    ) {
        self.id = id
        self.traceId = traceId
        self.parentSpanId = parentSpanId
        self.name = name
        self.kind = kind
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.durationMs = durationMs
        self.status = status
        self.attributes = attributes
        self.includeContent = includeContent
        self.promptText = promptText
        self.completionText = completionText
        self.transcriptText = transcriptText
    }
}

/// Attribute values are a small, typed subset of JSON — enough for
/// `gen_ai.request.model = "llama-3.2-3b-q4"`, `device.thermal_state = "nominal"`,
/// `gen_ai.usage.input_tokens = 28`, `session.id = "sess_abc"`.
public enum AttributeValue: Codable, Sendable, Equatable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let i = try? c.decode(Int.self) { self = .int(i); return }
        if let d = try? c.decode(Double.self) { self = .double(d); return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        throw DecodingError.typeMismatch(
            AttributeValue.self,
            .init(codingPath: decoder.codingPath, debugDescription: "not a supported attribute scalar")
        )
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .int(let i): try c.encode(i)
        case .double(let d): try c.encode(d)
        case .bool(let b): try c.encode(b)
        }
    }
}

/// The parent trace for a set of spans.
public struct TraceData: Codable, Sendable, Equatable {
    public let id: String
    public let orgId: String
    public let projectId: String
    public let sessionId: String?
    public let startedAt: String
    public let endedAt: String?
    public let device: [String: AttributeValue]
    public let attributes: [String: AttributeValue]
    public let sensitive: Bool
}

/// The POST /ingest payload. The backend's `createApp` expects exactly this shape.
public struct IngestPayload: Codable, Sendable, Equatable {
    public let trace: TraceData
    public let spans: [SpanData]
}
