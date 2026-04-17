import Foundation

// MARK: - CLI dispatch
//
// Hand-rolled arg parsing (no swift-argument-parser dep) — the harness is
// Y1 OSS tooling that must build from a fresh clone with zero package
// resolution. The surface is small (two subcommands, a handful of flags
// each), so rolling it by hand is cheaper than pulling a dep.
//
// Usage:
//   harness run  --model <id> --prompt <file> --iters <n>  [--output <file>]
//   harness diff <baseline.json> <this.json>              [--threshold 0.15]
//   harness help | -h | --help

let args = CommandLine.arguments
guard args.count >= 2 else {
    printUsage(to: FileHandle.standardError)
    exit(2)
}

let sub = args[1]
let rest = Array(args.dropFirst(2))

do {
    switch sub {
    case "run":
        try runMain(args: rest)
    case "diff":
        try diffMain(args: rest)
    case "help", "-h", "--help":
        printUsage(to: FileHandle.standardOutput)
    default:
        FileHandle.standardError.write(Data("harness: unknown subcommand '\(sub)'\n\n".utf8))
        printUsage(to: FileHandle.standardError)
        exit(2)
    }
} catch let HarnessError.usage(msg) {
    FileHandle.standardError.write(Data("harness: \(msg)\n".utf8))
    exit(2)
} catch let HarnessError.internalError(msg) {
    FileHandle.standardError.write(Data("harness: internal error: \(msg)\n".utf8))
    exit(1)
} catch {
    FileHandle.standardError.write(Data("harness: \(error.localizedDescription)\n".utf8))
    exit(1)
}

// MARK: - `run` entrypoint

func runMain(args: [String]) throws {
    var model: String?
    var prompt: String?
    var iters: Int?
    var outputPath: String?
    var i = 0
    while i < args.count {
        let a = args[i]
        switch a {
        case "--model":
            model = try requireNext(args, &i, a)
        case "--prompt":
            prompt = try requireNext(args, &i, a)
        case "--iters":
            let raw = try requireNext(args, &i, a)
            guard let n = Int(raw) else { throw HarnessError.usage("--iters must be an integer (got '\(raw)')") }
            iters = n
        case "--output", "-o":
            outputPath = try requireNext(args, &i, a)
        default:
            throw HarnessError.usage("unknown flag for 'run': \(a)")
        }
        i += 1
    }
    guard let model else { throw HarnessError.usage("'run' requires --model") }
    guard let prompt else { throw HarnessError.usage("'run' requires --prompt <file>") }
    guard let iters else { throw HarnessError.usage("'run' requires --iters <n>") }

    let data = try runCommand(modelId: model, promptPath: prompt, iters: iters)

    if let outputPath {
        try data.write(to: URL(fileURLWithPath: outputPath))
    } else {
        FileHandle.standardOutput.write(data)
    }
}

// MARK: - `diff` entrypoint

func diffMain(args: [String]) throws {
    var positional: [String] = []
    var threshold: Double = 0.15
    var i = 0
    while i < args.count {
        let a = args[i]
        switch a {
        case "--threshold":
            let raw = try requireNext(args, &i, a)
            guard let v = Double(raw) else { throw HarnessError.usage("--threshold must be a number (got '\(raw)')") }
            threshold = v
        default:
            if a.hasPrefix("--") {
                throw HarnessError.usage("unknown flag for 'diff': \(a)")
            }
            positional.append(a)
        }
        i += 1
    }
    guard positional.count == 2 else {
        throw HarnessError.usage("'diff' requires exactly two file arguments: <baseline.json> <this.json>")
    }
    let baselineData = try Data(contentsOf: URL(fileURLWithPath: positional[0]))
    let thisData = try Data(contentsOf: URL(fileURLWithPath: positional[1]))
    let baseline = try decodeTimingBlob(baselineData)
    let this = try decodeTimingBlob(thisData)
    let md = try diffCommand(baseline: baseline, this: this, threshold: threshold)
    FileHandle.standardOutput.write(Data(md.utf8))
}

// MARK: - helpers

func requireNext(_ args: [String], _ i: inout Int, _ flag: String) throws -> String {
    i += 1
    guard i < args.count else {
        throw HarnessError.usage("\(flag) requires a value")
    }
    return args[i]
}

func printUsage(to handle: FileHandle) {
    let u = """
    EdgeProbe benchmark harness

    Usage:
      harness run  --model <id> --prompt <file> --iters <n> [--output <file>]
      harness diff <baseline.json> <this.json> [--threshold 0.15]

    'run' emits a JSON TimingBlob (see TimingBlob.swift) with deterministic
    synthetic timings for --model ids that don't match a real model loader.
    The mock path seeds xorshift32 from SHA(prompt) XOR modelId XOR iter so
    goldens are reproducible across machines.

    'diff' reads two run outputs and prints a Markdown perf-diff shaped like
    the EdgeProbe PR-comment template. Model + promptHash must match; the
    harness refuses to compare incomparable runs.

    Every iteration is wrapped in an EdgeProbe trace (dry-run; no network),
    so the harness doubles as an SDK span-pipeline exerciser.
    """
    handle.write(Data((u + "\n").utf8))
}
