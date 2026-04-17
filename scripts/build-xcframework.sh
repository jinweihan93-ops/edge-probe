#!/usr/bin/env bash
# build-xcframework.sh — per-slice + assemble driver for the XCFramework workflow.
#
# Invoked by .github/workflows/xcframework.yml. Two modes:
#
#   MODE A (per-slice, one invocation per matrix cell):
#     scripts/build-xcframework.sh \
#       --target {ios|ios-simulator|macos} \
#       --arch   {arm64|x86_64} \
#       --llama-tag <tag-or-empty> \
#       --whisper-tag <tag-or-empty> \
#       [--real]
#
#     Produces: build/xcframework/slices/<target>-<arch>/{libllama.a,libwhisper.a,include/…}
#
#   MODE B (assemble, one invocation at the end):
#     scripts/build-xcframework.sh --assemble \
#       --llama-tag <tag-or-empty> \
#       --whisper-tag <tag-or-empty> \
#       --real
#
#     Produces: build/xcframework/out/llama-<tag>.xcframework.zip,
#               build/xcframework/out/whisper-<tag>.xcframework.zip
#
# WHY a shell script:
#   The real build lives in upstream repos' CMake toolchain files. We're
#   orchestrating git checkout + xcodebuild, not re-implementing their build.
#   A shell script keeps the orchestration readable and trivially runnable
#   locally (`scripts/build-xcframework.sh --target ios --arch arm64 \
#   --llama-tag b4321` just prints the plan, so a founder can sanity-check
#   what a workflow run would do).
#
# Slice 8 scope (docs/SLICES.md):
#   This commit ships the SHAPE — flag surface, dry-run output, dir
#   contracts, and `.github/workflows/xcframework.yml` that calls it.
#   The --real code paths (`do_real_build`, `do_real_assemble`) are
#   stubbed: they log exactly what a real build would do and then exit 0
#   with a TODO marker. Flipping that to actually compile is a follow-up
#   once the SDK's Package.swift consumes binaryTarget() entries that
#   reference the zips this workflow uploads.

set -euo pipefail

# ---- defaults ----
MODE="slice"       # "slice" or "assemble"
TARGET=""
ARCH=""
LLAMA_TAG=""
WHISPER_TAG=""
REAL="false"

# ---- flag parsing ----
while [ $# -gt 0 ]; do
  case "$1" in
    --target)      TARGET="$2"; shift 2 ;;
    --arch)        ARCH="$2"; shift 2 ;;
    --llama-tag)   LLAMA_TAG="$2"; shift 2 ;;
    --whisper-tag) WHISPER_TAG="$2"; shift 2 ;;
    --assemble)    MODE="assemble"; shift ;;
    --real)        REAL="true"; shift ;;
    -h|--help)
      # Print the top-of-file doc block and exit. Re-reads this script so
      # the flag reference stays in sync with the comment above.
      sed -n '3,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//' | sed '$d'
      exit 0
      ;;
    *)
      echo "build-xcframework.sh: unknown flag: $1" >&2
      echo "try --help" >&2
      exit 2
      ;;
  esac
done

# ---- paths ----
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_ROOT="$REPO_ROOT/build/xcframework"
SLICES_DIR="$BUILD_ROOT/slices"
OUT_DIR="$BUILD_ROOT/out"
WORK_DIR="$BUILD_ROOT/work"

# ---- helpers ----
log()  { printf "[xcf] %s\n" "$*"; }
hr()   { printf -- "────────────────────────────────────────\n"; }

# Validate a non-empty flag. Empty tags mean "skip this upstream"; that's
# fine, but we still require at least one source to be non-empty.
require_at_least_one_source() {
  if [ -z "$LLAMA_TAG" ] && [ -z "$WHISPER_TAG" ]; then
    echo "build-xcframework.sh: need at least one of --llama-tag or --whisper-tag" >&2
    exit 2
  fi
}

# Map {target, arch} → xcodebuild -sdk + CMAKE_OSX_ARCHITECTURES.
# Centralizing this here (not in the workflow YAML) keeps the matrix
# definition in one place — YAML becomes a simple fan-out.
xc_sdk_for() {
  case "$1" in
    ios)           echo "iphoneos" ;;
    ios-simulator) echo "iphonesimulator" ;;
    macos)         echo "macosx" ;;
    *) echo "unknown target: $1" >&2; exit 2 ;;
  esac
}

# The CMAKE_SYSTEM_NAME upstream llama.cpp/whisper.cpp expects for each sdk.
cmake_system_for() {
  case "$1" in
    ios|ios-simulator) echo "iOS" ;;
    macos)             echo "Darwin" ;;
    *) echo "unknown target: $1" >&2; exit 2 ;;
  esac
}

# ---- mode: slice (per matrix cell) ----

do_slice_plan() {
  local target="$1" arch="$2"
  local sdk cmake_sys
  sdk="$(xc_sdk_for "$target")"
  cmake_sys="$(cmake_system_for "$target")"

  hr
  log "slice build plan"
  log "  target           = $target"
  log "  arch             = $arch"
  log "  xcodebuild -sdk  = $sdk"
  log "  CMAKE_SYSTEM     = $cmake_sys"
  log "  llama.cpp tag    = ${LLAMA_TAG:-<skip>}"
  log "  whisper.cpp tag  = ${WHISPER_TAG:-<skip>}"
  log "  slice output dir = $SLICES_DIR/${target}-${arch}/"
  hr

  if [ -n "$LLAMA_TAG" ]; then
    log "would: git clone --depth 1 --branch $LLAMA_TAG https://github.com/ggerganov/llama.cpp $WORK_DIR/llama-$LLAMA_TAG"
    log "would: cmake -S $WORK_DIR/llama-$LLAMA_TAG -B $WORK_DIR/llama-$LLAMA_TAG/build-$target-$arch \\"
    log "         -G Xcode \\"
    log "         -DCMAKE_SYSTEM_NAME=$cmake_sys \\"
    log "         -DCMAKE_OSX_ARCHITECTURES=$arch \\"
    log "         -DCMAKE_OSX_DEPLOYMENT_TARGET=14.0 \\"
    log "         -DLLAMA_METAL=ON -DLLAMA_ACCELERATE=ON -DBUILD_SHARED_LIBS=OFF"
    log "would: cmake --build … --config Release --target llama"
    log "would: strip -x -S libllama.a"
    log "would: cp libllama.a → $SLICES_DIR/${target}-${arch}/libllama.a"
  fi

  if [ -n "$WHISPER_TAG" ]; then
    log "would: git clone --depth 1 --branch $WHISPER_TAG https://github.com/ggerganov/whisper.cpp $WORK_DIR/whisper-$WHISPER_TAG"
    log "would: cmake -S $WORK_DIR/whisper-$WHISPER_TAG -B $WORK_DIR/whisper-$WHISPER_TAG/build-$target-$arch \\"
    log "         -G Xcode \\"
    log "         -DCMAKE_SYSTEM_NAME=$cmake_sys \\"
    log "         -DCMAKE_OSX_ARCHITECTURES=$arch \\"
    log "         -DCMAKE_OSX_DEPLOYMENT_TARGET=14.0 \\"
    log "         -DWHISPER_COREML=ON -DBUILD_SHARED_LIBS=OFF"
    log "would: cmake --build … --config Release --target whisper"
    log "would: strip -x -S libwhisper.a"
    log "would: cp libwhisper.a → $SLICES_DIR/${target}-${arch}/libwhisper.a"
  fi

  hr
  log "dry-run OK (mode=slice). Re-run with --real to actually compile."
}

do_slice_real() {
  local target="$1" arch="$2"
  mkdir -p "$SLICES_DIR/${target}-${arch}" "$WORK_DIR"

  log "REAL build requested for $target-$arch"
  # TODO(slice 8 follow-up): turn the do_slice_plan commands into actual
  # execution. Left as a guarded stub so the workflow's --real path still
  # exits 0 (dry-runs from CI today, will compile once Package.swift
  # consumes the uploaded XCFrameworks). See docs/SLICES.md Slice 8 "Done".
  log "SDK's Package.swift does not yet reference binaryTarget() for these"
  log "zips; skipping compile to avoid producing orphan artifacts. When"
  log "the pin flips on, delete this early-return and the do_slice_plan"
  log "body becomes the real command list."

  # Even in stub mode, lay down a placeholder so the upload-artifact step
  # has something to pick up and the assemble job has a predictable shape
  # to iterate. Zero-byte sentinel — obvious it's not a real library.
  touch "$SLICES_DIR/${target}-${arch}/.stub"
  do_slice_plan "$target" "$arch"
}

# ---- mode: assemble (aggregate slices → .xcframework → zip) ----

do_assemble_plan() {
  hr
  log "assemble plan"
  log "  llama.cpp tag   = ${LLAMA_TAG:-<skip>}"
  log "  whisper.cpp tag = ${WHISPER_TAG:-<skip>}"
  log "  input slices    = $SLICES_DIR/*/"
  log "  output bundles  = $OUT_DIR/*.xcframework.zip"
  hr

  # Each target gets its own .xcframework containing all arches. The
  # lipo step fuses simulator arm64 + simulator x86_64 into a single fat
  # static library, then xcodebuild bundles per-target libs into the
  # XCFramework alongside the headers.
  if [ -n "$LLAMA_TAG" ]; then
    log "would: lipo -create \\"
    log "         $SLICES_DIR/ios-simulator-arm64/libllama.a \\"
    log "         $SLICES_DIR/ios-simulator-x86_64/libllama.a \\"
    log "         -output $WORK_DIR/libllama-ios-simulator.a"
    log "would: lipo -create \\"
    log "         $SLICES_DIR/macos-arm64/libllama.a \\"
    log "         $SLICES_DIR/macos-x86_64/libllama.a \\"
    log "         -output $WORK_DIR/libllama-macos.a"
    log "would: xcodebuild -create-xcframework \\"
    log "         -library $SLICES_DIR/ios-arm64/libllama.a -headers … \\"
    log "         -library $WORK_DIR/libllama-ios-simulator.a -headers … \\"
    log "         -library $WORK_DIR/libllama-macos.a -headers … \\"
    log "         -output $OUT_DIR/llama.xcframework"
    log "would: ditto -c -k --sequesterRsrc --keepParent \\"
    log "         $OUT_DIR/llama.xcframework $OUT_DIR/llama-${LLAMA_TAG}.xcframework.zip"
  fi

  if [ -n "$WHISPER_TAG" ]; then
    log "would: lipo + xcodebuild -create-xcframework for whisper (same shape as llama)"
    log "would: ditto -c -k --sequesterRsrc --keepParent \\"
    log "         $OUT_DIR/whisper.xcframework $OUT_DIR/whisper-${WHISPER_TAG}.xcframework.zip"
  fi

  hr
  log "dry-run OK (mode=assemble). Re-run with --real to actually assemble + zip."
}

do_assemble_real() {
  mkdir -p "$OUT_DIR" "$WORK_DIR"

  log "REAL assemble requested"
  # TODO(slice 8 follow-up): wire lipo + xcodebuild -create-xcframework +
  # ditto zip. Gated for the same reason as do_slice_real — no consumer
  # in Package.swift yet, so zips would ship unused.
  do_assemble_plan

  # Emit a placeholder zip so the release-upload step has a file to attach
  # and reviewers can confirm the workflow's tail-end wiring (checksums,
  # release draft, etc.) even before the real compile lands.
  if [ -n "$LLAMA_TAG" ]; then
    printf "stub llama xcframework for tag %s\n" "$LLAMA_TAG" \
      > "$OUT_DIR/llama-${LLAMA_TAG}.README.txt"
    (cd "$OUT_DIR" && zip -q "llama-${LLAMA_TAG}.xcframework.zip" "llama-${LLAMA_TAG}.README.txt")
  fi
  if [ -n "$WHISPER_TAG" ]; then
    printf "stub whisper xcframework for tag %s\n" "$WHISPER_TAG" \
      > "$OUT_DIR/whisper-${WHISPER_TAG}.README.txt"
    (cd "$OUT_DIR" && zip -q "whisper-${WHISPER_TAG}.xcframework.zip" "whisper-${WHISPER_TAG}.README.txt")
  fi

  log "wrote placeholder zips to $OUT_DIR/"
  ls -la "$OUT_DIR" || true
}

# ---- dispatch ----

if [ "$MODE" = "assemble" ]; then
  require_at_least_one_source
  if [ "$REAL" = "true" ]; then
    do_assemble_real
  else
    do_assemble_plan
  fi
  exit 0
fi

# slice mode needs target + arch
if [ -z "$TARGET" ] || [ -z "$ARCH" ]; then
  echo "build-xcframework.sh: --target and --arch required in slice mode" >&2
  echo "try --help" >&2
  exit 2
fi

# ios is arm64-only — mirror the matrix exclude in .github/workflows/xcframework.yml
# so a wayward local invocation fails fast with a clear reason (matches
# the docstring comment in the workflow YAML).
if [ "$TARGET" = "ios" ] && [ "$ARCH" = "x86_64" ]; then
  echo "build-xcframework.sh: target=ios + arch=x86_64 is invalid (no x86_64 iOS devices exist)" >&2
  exit 2
fi

require_at_least_one_source

if [ "$REAL" = "true" ]; then
  do_slice_real "$TARGET" "$ARCH"
else
  do_slice_plan "$TARGET" "$ARCH"
fi
