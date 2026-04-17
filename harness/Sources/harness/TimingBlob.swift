import Foundation

/// Output schema for `harness run`. One `TimingBlob` per invocation, containing
/// N `Iteration`s. Serialized as JSON with stable key ordering so a committed
/// golden survives iteration order and `Codable` reflection quirks.
///
/// The shape deliberately mirrors the action's `trace.sample.json` where it
/// can — `model` / `promptHash` replace what the real EdgeProbe SDK would
/// capture as `gen_ai.request.model` + prompt-text-hashed attribute. Feeding
/// this JSON into the action's diff formatter is a near-future win.
struct TimingBlob: Codable, Equatable {
    /// Schema version. Bump on ANY incompatible key rename / type change — goldens
    /// are tied to this so downstream consumers can detect format skew early.
    let schema: Int
    /// Arbitrary model identifier string passed on the CLI (e.g. `mock-deterministic`,
    /// `mlx-community/Llama-3.2-1B-Instruct-4bit`). Opaque to the harness.
    let model: String
    /// SHA-256 (first 16 hex chars) of the prompt bytes. Enough entropy for
    /// drift detection without exposing the prompt itself when goldens get
    /// copy-pasted into bug reports.
    let promptHash: String
    /// Byte length of the prompt as loaded from disk.
    let promptBytes: Int
    /// Number of completed iterations.
    let iterations: Int
    /// Per-iteration timings.
    let runs: [Iteration]

    struct Iteration: Codable, Equatable {
        /// 0-based iteration index.
        let iter: Int
        /// SHA-256 (first 16 hex chars) of the generated token id sequence. If the
        /// underlying model path (real MLX, stub, etc.) drifts between the same
        /// seed + prompt combo, this hash changes — a ship-gating signal.
        let outputTokenHash: String
        let tokensGenerated: Int
        /// Time to first token (ms). For the mock path this is synthesized; for a
        /// real MLX wire-up it maps to `time_of_first_token - prompt_start`.
        let prefillMs: Int
        /// Total decode wall-clock after first token (ms).
        let decodeMs: Int
        /// `prefillMs + decodeMs`, restated as a pre-computed field so diff
        /// consumers don't re-sum and silently diverge on rounding.
        let totalMs: Int
        /// Throughput during decode (tokens/sec, integer-rounded). Matches the
        /// "decode tok/s" convention used by llama.cpp's built-in benchmarks.
        let decodeTokensPerSec: Int
    }
}

/// JSON encode with stable (alphabetical) key ordering + 2-space indent.
/// Goldens live in the tree; their diff noise needs to be zero when nothing
/// meaningful has changed.
func encodeTimingBlob(_ blob: TimingBlob) throws -> Data {
    let enc = JSONEncoder()
    enc.outputFormatting = [.prettyPrinted, .sortedKeys]
    return try enc.encode(blob)
}

func decodeTimingBlob(_ data: Data) throws -> TimingBlob {
    try JSONDecoder().decode(TimingBlob.self, from: data)
}
