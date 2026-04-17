import Foundation
import EdgeProbe

/// Implements `harness run --model <id> --prompt <file> --iters N`.
///
/// Contract:
///   - Produces ONE `TimingBlob` (JSON) to `output` containing an array of
///     `iters` iterations. Key ordering and formatting are pinned so the
///     committed golden at Tests/harnessTests/Fixtures/golden/run.cap.iters2.json
///     stays byte-stable.
///   - EdgeProbe is started in dry-run mode (no endpoint): each iteration
///     wraps its synthetic work in `beginTrace()` → `span(.llm) { ... }` →
///     `end()`, so the SDK's span pipeline is exercised under realistic
///     per-iteration cadence even when no network call happens. This is
///     what makes the harness a "span-pipeline exerciser" per Slice 9's
///     contract, without paying the cost of real HTTP.
///   - Deterministic: the mock model path (MockModel.swift) is xorshift32-
///     seeded from SHA(prompt) ⊕ modelId ⊕ iter. Same inputs ⇒ same JSON.
///
/// Return value is the Data form of the emitted JSON so tests can assert
/// byte-equality against the golden without round-tripping through stdout.
func runCommand(
    modelId: String,
    promptPath: String,
    iters: Int
) throws -> Data {
    guard iters >= 1 else {
        throw HarnessError.usage("--iters must be ≥ 1 (got \(iters))")
    }

    let promptData: Data
    do {
        promptData = try Data(contentsOf: URL(fileURLWithPath: promptPath))
    } catch {
        throw HarnessError.usage("could not read --prompt file: \(promptPath) (\(error.localizedDescription))")
    }
    guard let prompt = String(data: promptData, encoding: .utf8) else {
        throw HarnessError.usage("prompt file is not valid UTF-8: \(promptPath)")
    }

    // Start EdgeProbe in dry-run (no endpoint). The harness's job is to
    // exercise the SDK's pipeline; it must never POST real data from a
    // developer laptop or CI runner. `start()` is idempotent (Critical Path
    // #6) so repeat invocations across harness runs in the same process are
    // fine.
    EdgeProbe.start(apiKey: "epk_pub_harness_dryrun", endpoint: nil, orgId: "org_harness", projectId: "proj_harness")

    let seed = promptHashSeed(prompt: prompt)
    let promptHashHex = hashPrefix(ofString: prompt)

    var iterations: [TimingBlob.Iteration] = []
    iterations.reserveCapacity(iters)

    for i in 0..<iters {
        // Wrap the work in an EdgeProbe trace so the BSP path gets exercised.
        // `includeContent: false` — the harness MUST NOT upload prompt/completion
        // even if a real endpoint were wired, per the SDK's default.
        let handle = EdgeProbe.beginTrace(sessionId: "harness_\(UUID().uuidString.prefix(8))")
        let it = handle.span(.llm, name: "harness-decode") { reporter in
            reporter.setAttribute("gen_ai.request.model", .string(modelId))
            reporter.setAttribute("harness.iter", .int(i))
            // Synthesize the iteration — deterministic + cheap, no model load.
            return synthesizeIteration(
                prompt: prompt,
                modelId: modelId,
                iter: i,
                promptHashSeed: seed
            )
        }
        handle.end()
        iterations.append(it)
    }

    let blob = TimingBlob(
        schema: 1,
        model: modelId,
        promptHash: promptHashHex,
        promptBytes: promptData.count,
        iterations: iters,
        runs: iterations
    )
    let data = try encodeTimingBlob(blob)
    // JSONEncoder doesn't add a trailing newline; add one so `echo $(harness run)
    // > file.json` and `cat file.json | harness diff ...` both behave.
    var out = data
    out.append(0x0a)
    return out
}
