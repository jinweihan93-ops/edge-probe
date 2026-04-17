import Foundation

/// Deterministic synthetic generator used when `--model` is `mock-*` or any
/// non-real-model placeholder. The whole point is reproducibility: the same
/// (prompt, iter, modelId) triple must always produce the exact same timings
/// and token ids, byte-for-byte — that's how the golden at
/// `Tests/harnessTests/Fixtures/golden/run.cap.iters2.json` stays stable.
///
/// WHY a mock for the first cut (Slice 9):
///   The docs/SLICES.md Slice 9 "Done" clause calls for a minimal first cut.
///   A real MLX wire-up pulls ~700 MB of weights on first run and won't work
///   on CI runners without GPU. A deterministic synthetic path:
///     (a) exercises the harness shape end-to-end,
///     (b) makes committed goldens possible,
///     (c) doubles as an EdgeProbe.beginTrace() smoke under load — the
///         synthetic path sleeps realistic microseconds between tokens so
///         the SDK's batch processor sees actual temporal spread.
///   When a real MLX adapter lands, it slots in behind the same
///   `SyntheticGenerator`-shaped interface and the mock becomes a fallback.
///
/// RNG: xorshift32 seeded from SHA-256(prompt) ⊕ modelId hash ⊕ iter index.
/// xorshift32 is chosen over SystemRandomNumberGenerator specifically for
/// cross-platform determinism — SystemRandomNumberGenerator is not seedable
/// and would make goldens non-reproducible.
struct DeterministicRNG {
    private var state: UInt32

    init(seed: UInt64) {
        // Fold 64 bits into 32 so xorshift32 works. If the fold ever lands on
        // zero, xorshift loops on zero forever — bump by 1 as a safety rail.
        let folded = UInt32(truncatingIfNeeded: seed ^ (seed >> 32))
        self.state = folded == 0 ? 1 : folded
    }

    mutating func next() -> UInt32 {
        var x = state
        x ^= x << 13
        x ^= x >> 17
        x ^= x << 5
        state = x
        return x
    }

    /// Returns Int in [lo, hi].
    mutating func int(in range: ClosedRange<Int>) -> Int {
        let span = UInt32(range.upperBound - range.lowerBound + 1)
        return range.lowerBound + Int(next() % span)
    }
}

/// Synthesizes a full `TimingBlob.Iteration` from a prompt + iteration index.
///
/// Output shape:
///  - `tokensGenerated`: f(prompt length) — longer prompts produce longer
///    completions, matching real-world decode scaling.
///  - `prefillMs`: proportional to prompt token count at a simulated ~800 t/s
///    prefill rate.
///  - `decodeMs`: tokensGenerated × per-token latency (randomized within a
///    ±10% band per iter so iter-to-iter variance looks real but stays
///    deterministic under the same seed).
///  - `outputTokenHash`: SHA-256 prefix of the synthetic token id sequence.
///    Drift-catchable.
func synthesizeIteration(
    prompt: String,
    modelId: String,
    iter: Int,
    promptHashSeed: UInt64
) -> TimingBlob.Iteration {
    // Seed combines the full context. Fold modelId + iter in so swapping the
    // model id or iter index produces a different (but still deterministic)
    // trajectory.
    //
    // WHY NOT `modelId.hashValue`: Swift's default Hasher randomizes its seed
    // per-process (DoS-resistance default since Swift 4.2). That makes every
    // harness invocation produce different numbers, breaking committed
    // goldens. Using our own FNV1a64 guarantees cross-run reproducibility.
    var modelHasher = FNV1a64()
    modelHasher.update(Array(modelId.utf8))
    let modelSeed = modelHasher.value
    let iterSeed = UInt64(iter) &* 0x9E37_79B9_7F4A_7C15 // golden-ratio prime for decorrelation
    var rng = DeterministicRNG(seed: promptHashSeed ^ modelSeed ^ iterSeed)

    // Rough prompt token count estimate: 1 token per ~4 bytes of UTF-8.
    // Good enough for synthetic timings; real paths will pipe the true
    // tokenizer output through instead.
    let promptTokens = max(1, prompt.utf8.count / 4)

    // Simulated prefill throughput ~800 t/s, jittered ±15% per iter.
    let prefillTps = rng.int(in: 680...920)
    let prefillMs = (promptTokens * 1000 + prefillTps / 2) / prefillTps

    // Simulated completion length: 32-128 tokens depending on prompt size.
    let tokensGenerated = min(128, max(32, promptTokens * 3 + rng.int(in: -8...8)))

    // Simulated decode throughput ~45 t/s (llama-3.2-1B Q4 on a modern iPhone),
    // jittered ±10% per iter.
    let decodeTps = rng.int(in: 40...50)
    let decodeMs = (tokensGenerated * 1000 + decodeTps / 2) / decodeTps
    let totalMs = prefillMs + decodeMs

    // Synthesize token id sequence. Uniform(0, 49151) matches SmolLM2's vocab
    // size; doesn't matter for drift detection, but keeps the hash prefix
    // looking plausible if someone dumps it into a debugger.
    var tokenIds = [UInt32]()
    tokenIds.reserveCapacity(tokensGenerated)
    for _ in 0..<tokensGenerated {
        tokenIds.append(rng.next() % 49_152)
    }
    let outputTokenHash = hashPrefix(ofUInt32Array: tokenIds)

    return TimingBlob.Iteration(
        iter: iter,
        outputTokenHash: outputTokenHash,
        tokensGenerated: tokensGenerated,
        prefillMs: prefillMs,
        decodeMs: decodeMs,
        totalMs: totalMs,
        decodeTokensPerSec: decodeTps
    )
}

/// SHA-256 hex prefix (16 chars / 8 bytes) of raw UTF-8. Stable across
/// CommonCrypto / CryptoKit — we use CryptoKit here since the harness
/// is macOS-only and CryptoKit is always available.
func hashPrefix(ofString s: String) -> String {
    hashPrefix(ofBytes: Array(s.utf8))
}

func hashPrefix(ofUInt32Array arr: [UInt32]) -> String {
    var bytes = [UInt8]()
    bytes.reserveCapacity(arr.count * 4)
    for v in arr {
        // Little-endian. Choice doesn't matter for drift detection; commit to
        // one so goldens stay stable.
        bytes.append(UInt8(truncatingIfNeeded: v))
        bytes.append(UInt8(truncatingIfNeeded: v >> 8))
        bytes.append(UInt8(truncatingIfNeeded: v >> 16))
        bytes.append(UInt8(truncatingIfNeeded: v >> 24))
    }
    return hashPrefix(ofBytes: bytes)
}

// Implementation deliberately avoids CryptoKit so the harness stays pure-Swift
// dep-free and runs identically on Linux CI if we ever port. 16-char prefix is
// enough entropy for drift detection (2^64 space), not intended as crypto.
func hashPrefix(ofBytes bytes: [UInt8]) -> String {
    var h = FNV1a64()
    h.update(bytes)
    // Fold in a second pass with a shifted seed to give us 128 bits of state
    // we can split into 16 hex chars without collision pressure from real
    // payloads (prompts + token id arrays).
    var h2 = FNV1a64(seed: 0xA5A5_A5A5_A5A5_A5A5)
    h2.update(bytes)
    let a = String(h.value, radix: 16)
    let b = String(h2.value, radix: 16)
    let padded = (String(repeating: "0", count: max(0, 8 - a.count)) + a)
        + (String(repeating: "0", count: max(0, 8 - b.count)) + b)
    return String(padded.prefix(16))
}

/// 64-bit FNV-1a. Not cryptographic; sufficient for golden-style drift detection.
struct FNV1a64 {
    private var h: UInt64

    init(seed: UInt64 = 0xcbf29ce484222325) { self.h = seed }

    mutating func update(_ bytes: [UInt8]) {
        var x = h
        for b in bytes {
            x ^= UInt64(b)
            x = x &* 0x100000001b3
        }
        h = x
    }

    var value: UInt64 { h }
}

/// Compute the promptHash seed used by `synthesizeIteration`.
func promptHashSeed(prompt: String) -> UInt64 {
    var h = FNV1a64()
    h.update(Array(prompt.utf8))
    return h.value
}
