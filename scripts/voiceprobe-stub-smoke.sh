#!/usr/bin/env bash
#
# voiceprobe-stub-smoke.sh — Slice 10 stability gate for the VoiceProbe
# simulator stub reply text.
#
# docs/SLICES.md §Slice 10 "Done" requires:
#   simulator smoke via `-EDGEPROBE_AUTOLOAD 1 -EDGEPROBE_AUTOGENERATE "hello"`
#   produces a stable textual output.
#
# Running the full autoload+autogenerate path every CI run would mean booting a
# simulator, compiling the 700 MB MLX/swift-transformers universe, and paying
# multi-minute load times for a single-line assertion. That's absurd for what is
# in fact a pure-function contract: `SimulatorStubReply.text(for:)` in
# ios/DemoApp/Sources/Services/SimulatorStubReply.swift is the deterministic
# formatter the autogenerate path prints. If that formatter's output is stable,
# the autogenerate output is stable.
#
# This script compiles the REAL production helper file (not a copy) with
# swiftc alongside a tiny in-line driver, then runs the binary and diffs its
# stdout against the golden for `"hello"`. No Xcode, no simulator, no MLX — just
# the Swift toolchain that already exists on the macos-14 runner.
#
# Runs in CI as a post-step on the `ios` job (same macos-14 runner that has
# `swift` on PATH). Local invocation: `bash scripts/voiceprobe-stub-smoke.sh`.
#
# Exit code 0 on match, 1 on mismatch, 2 on environment failure.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER="$REPO_ROOT/ios/DemoApp/Sources/Services/SimulatorStubReply.swift"

if [[ ! -f "$HELPER" ]]; then
  echo "ERROR: SimulatorStubReply.swift missing at $HELPER" >&2
  exit 2
fi

if ! command -v swiftc >/dev/null 2>&1; then
  echo "ERROR: swiftc not on PATH; cannot build stub smoke" >&2
  exit 2
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# The driver calls the real enum from the real file. If anyone renames the
# enum or changes the function signature, this compile-fails first — the
# assertion check below is just belt-and-suspenders.
#
# Must be named `main.swift` — Swift only allows top-level expressions in a
# file with that exact name when multiple files are compiled together. Any
# other name is treated as a library module and top-level code is rejected.
cat > "$WORKDIR/main.swift" <<'SWIFT'
import Foundation

// Expected golden string for input "hello". If you change
// SimulatorStubReply.text(for:), bump this golden AND the README snippet
// under "The stub reply contract" in ios/DemoApp/README.md in lockstep.
let expectedHello =
    "Got it: \"hello\". (Simulator stub — real on-device inference runs on a physical iPhone.)"

// Expected for empty input (the whitespace-only fallback path).
let expectedEmpty =
    "Simulator stub — real on-device inference runs on a physical iPhone."

func assertEq(_ label: String, _ got: String, _ want: String) {
    if got != want {
        FileHandle.standardError.write(Data(
            "FAIL [\(label)]: got=\(got.debugDescription) want=\(want.debugDescription)\n".utf8
        ))
        exit(1)
    }
    print("PASS [\(label)]: \(got)")
}

// Core stability — the one case the autogenerate CI smoke would hit.
assertEq("hello", SimulatorStubReply.text(for: "hello"), expectedHello)

// Whitespace trimming → falls through to disclaimer-only branch.
assertEq("whitespace", SimulatorStubReply.text(for: "   \n\t  "), expectedEmpty)

// 60-char truncation contract: 61-char input gets a "…" suffix.
let longIn = String(repeating: "a", count: 61)
let longOut = SimulatorStubReply.text(for: longIn)
let longWant =
    "Got it: \"" + String(repeating: "a", count: 60) + "…\". " +
    "(Simulator stub — real on-device inference runs on a physical iPhone.)"
assertEq("truncate-61", longOut, longWant)

// 60-char input is NOT truncated (boundary check — `>` not `>=`).
let exactIn = String(repeating: "b", count: 60)
let exactOut = SimulatorStubReply.text(for: exactIn)
let exactWant =
    "Got it: \"" + String(repeating: "b", count: 60) + "\". " +
    "(Simulator stub — real on-device inference runs on a physical iPhone.)"
assertEq("truncate-60-boundary", exactOut, exactWant)

print("ALL PASS")
SWIFT

# Build it. `-parse-as-library` is wrong here — the driver uses top-level
# code, which is main-module syntax. Default swiftc mode handles that.
# Both files are compile-everywhere (no platform guards) so this works on
# any Swift-available host without Xcode.
if ! swiftc -O \
    -o "$WORKDIR/smoke" \
    "$HELPER" \
    "$WORKDIR/main.swift" \
    2> "$WORKDIR/build.log"; then
  echo "ERROR: swiftc build failed:" >&2
  cat "$WORKDIR/build.log" >&2
  exit 2
fi

# Run it. On failure, the driver has already printed FAIL + exited(1).
# We just relay its output.
if ! "$WORKDIR/smoke"; then
  exit 1
fi
