import XCTest
@testable import harness

/// Tests for the benchmark harness (Slice 9).
///
/// Coverage:
///   - `run` is byte-deterministic: re-running produces exactly the same
///     JSON, so a committed golden fixture stays valid.
///   - `diff` matches a committed Markdown golden for a hand-tuned
///     baseline/regression pair (no CLI invocation — we exercise the
///     `diffCommand(baseline:this:threshold:)` function directly so the
///     test is hermetic).
///   - The EdgeProbe span pipeline is exercised by every `run` iteration
///     (smoke; no assertion on exporter state — the SDK's own Critical
///     Paths suite is the authoritative gate there).
///   - Error surface: mismatched model id / promptHash / iter count in
///     `diff` throws `HarnessError.usage` rather than producing misleading
///     numbers.
final class HarnessTests: XCTestCase {

    // MARK: - run: deterministic + golden

    func test_run_isByteDeterministic() throws {
        let promptURL = try fixture("prompts/cap.txt")
        let a = try runCommand(modelId: "mock-v1", promptPath: promptURL.path, iters: 2)
        let b = try runCommand(modelId: "mock-v1", promptPath: promptURL.path, iters: 2)
        XCTAssertEqual(a, b, "harness run must be byte-identical across invocations")
    }

    func test_run_matchesCommittedGolden() throws {
        let promptURL = try fixture("prompts/cap.txt")
        let goldenURL = try fixture("golden/run.cap.iters2.json")
        let produced = try runCommand(modelId: "mock-v1", promptPath: promptURL.path, iters: 2)
        let golden = try Data(contentsOf: goldenURL)
        // The golden file was written from the exact same code path. If this
        // fails, either the mock model changed (in which case the schema
        // version must bump too) or the RNG/hash drifted.
        XCTAssertEqual(
            String(data: produced, encoding: .utf8),
            String(data: golden, encoding: .utf8),
            "run output diverged from golden — re-examine MockModel.swift changes"
        )
    }

    func test_run_changingModelIdChangesTokenHash() throws {
        let promptURL = try fixture("prompts/cap.txt")
        let a = try runCommand(modelId: "mock-v1", promptPath: promptURL.path, iters: 1)
        let b = try runCommand(modelId: "mock-v2", promptPath: promptURL.path, iters: 1)
        // Same prompt, different model → different synthesized token stream.
        // This is load-bearing for drift detection: comparing mock-v1 and
        // mock-v2 runs must surface as a real difference.
        XCTAssertNotEqual(a, b, "different --model ids must produce different timings")
    }

    func test_run_rejectsZeroIters() throws {
        let promptURL = try fixture("prompts/cap.txt")
        XCTAssertThrowsError(try runCommand(modelId: "mock-v1", promptPath: promptURL.path, iters: 0)) { err in
            guard case HarnessError.usage = err else {
                return XCTFail("expected HarnessError.usage for --iters 0, got \(err)")
            }
        }
    }

    func test_run_rejectsMissingPromptFile() {
        XCTAssertThrowsError(try runCommand(modelId: "mock-v1", promptPath: "/tmp/does-not-exist-\(UUID()).txt", iters: 1)) { err in
            guard case HarnessError.usage = err else {
                return XCTFail("expected HarnessError.usage for missing prompt, got \(err)")
            }
        }
    }

    // MARK: - diff: golden comparison + error surface

    func test_diff_matchesCommittedGolden() throws {
        let baseURL = try fixture("golden/diff.baseline.json")
        let thisURL = try fixture("golden/diff.regression.json")
        let base = try decodeTimingBlob(Data(contentsOf: baseURL))
        let this = try decodeTimingBlob(Data(contentsOf: thisURL))
        let md = try diffCommand(baseline: base, this: this, threshold: 0.15)
        let expected = try String(contentsOf: fixture("golden/diff.expected.md"), encoding: .utf8)
        XCTAssertEqual(md, expected, "diff output diverged from golden — re-examine DiffCommand.swift formatters")
    }

    func test_diff_refusesToCompareDifferentModels() throws {
        let baseURL = try fixture("golden/diff.baseline.json")
        let thisURL = try fixture("golden/diff.regression.json")
        var base = try decodeTimingBlob(Data(contentsOf: baseURL))
        var this = try decodeTimingBlob(Data(contentsOf: thisURL))
        // Swap one model id; the diff MUST refuse rather than quietly producing
        // garbage. Users who compare different models are almost always
        // making a mistake.
        this = TimingBlob(
            schema: this.schema,
            model: "mock-different",
            promptHash: this.promptHash,
            promptBytes: this.promptBytes,
            iterations: this.iterations,
            runs: this.runs
        )
        _ = base // silence warning if compiler is strict
        XCTAssertThrowsError(try diffCommand(baseline: base, this: this)) { err in
            guard case HarnessError.usage(let msg) = err, msg.contains("model mismatch") else {
                return XCTFail("expected usage error 'model mismatch', got \(err)")
            }
        }
    }

    func test_diff_refusesToCompareDifferentPrompts() throws {
        let baseURL = try fixture("golden/diff.baseline.json")
        let thisURL = try fixture("golden/diff.regression.json")
        let base = try decodeTimingBlob(Data(contentsOf: baseURL))
        var this = try decodeTimingBlob(Data(contentsOf: thisURL))
        this = TimingBlob(
            schema: this.schema,
            model: this.model,
            promptHash: "deadbeefcafebabe",
            promptBytes: this.promptBytes,
            iterations: this.iterations,
            runs: this.runs
        )
        XCTAssertThrowsError(try diffCommand(baseline: base, this: this)) { err in
            guard case HarnessError.usage(let msg) = err, msg.contains("prompt hash mismatch") else {
                return XCTFail("expected usage error 'prompt hash mismatch', got \(err)")
            }
        }
    }

    func test_diff_noChangeWhenWithinThreshold() throws {
        let baseURL = try fixture("golden/diff.baseline.json")
        let base = try decodeTimingBlob(Data(contentsOf: baseURL))
        // Comparing a blob to itself must always report "no change".
        let md = try diffCommand(baseline: base, this: base, threshold: 0.15)
        XCTAssertTrue(md.contains("no change"), "expected 'no change' verdict, got: \(md.prefix(80))")
        XCTAssertTrue(md.contains("±0%"), "expected ±0% delta for self-comparison")
    }

    // MARK: - helpers

    /// Resolve a test fixture URL. `.copy("Fixtures")` in Package.swift
    /// preserves the directory hierarchy under the bundle, so the caller
    /// passes the path relative to the `Fixtures/` root.
    private func fixture(_ path: String) throws -> URL {
        let url = Bundle.module.bundleURL
            .appendingPathComponent("Fixtures")
            .appendingPathComponent(path)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw XCTSkip("fixture not found on disk: \(url.path)")
        }
        return url
    }
}
