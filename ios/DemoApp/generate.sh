#!/usr/bin/env bash
#
# generate.sh — wrap `xcodegen generate` with post-generation patches that
# xcodegen (as of 2.45.4) cannot express itself.
#
# Why this script exists:
#
# 1. Local SwiftPM package product dependencies.
#    xcodegen emits `XCSwiftPackageProductDependency` entries for local
#    packages (`packages: { Foo: { path: ../Foo } }`) *without* the
#    `package = <XCLocalSwiftPackageReference id>` attribute. For remote
#    packages it emits the attribute correctly; local packages are a
#    long-standing gap. Xcode's package graph resolver then fails to tie
#    the product to its owning package and the build dies with
#    "Missing package product 'Foo'" — even though SPM resolve succeeds
#    and the package shows up in the sidebar with a "?" badge.
#
#    We patch both `EdgeProbe` (root SPM package at `..`) and
#    `LlamaRuntime` (sibling SPM package at `../LlamaRuntime`) to add the
#    missing `package = ...;` line. Without this Xcode 26 cannot link
#    either library into VoiceProbe.
#
# 2. EDGEPROBE_API_KEY.
#    project.yml uses the placeholder `$(EDGEPROBE_API_KEY)` so you can
#    override at generate time (e.g. in CI), but the repo default needs
#    to be a real working public demo key rather than the string
#    `epk_pub_demo_voiceprobe` that xcodegen writes when the env var is
#    unset. We substitute the working key in so a fresh clone runs
#    against the live demo backend without extra setup.
#
# Run this instead of `xcodegen generate`:
#
#     ./generate.sh
#
# Override the API key if you want your own:
#
#     EDGEPROBE_API_KEY=epk_pub_yours ./generate.sh
#
set -euo pipefail

cd "$(dirname "$0")"

# 1. Run xcodegen (let its own env-var pass-through handle normal overrides)
xcodegen generate

PBXPROJ="VoiceProbe.xcodeproj/project.pbxproj"

if [[ ! -f "$PBXPROJ" ]]; then
  echo "ERROR: $PBXPROJ missing after xcodegen" >&2
  exit 1
fi

# 2. Patch XCSwiftPackageProductDependency entries for local packages.
#    We find each `* /* Foo */ = { isa = XCSwiftPackageProductDependency;`
#    block that is missing a `package = ...;` line and insert one.
#
#    Done in-place via python rather than sed so we can match reliably on
#    multi-line blocks.
python3 <<'PY'
from pathlib import Path
import re

pbxproj = Path("VoiceProbe.xcodeproj/project.pbxproj")
text = pbxproj.read_text()

# Map from local-package XCSwiftPackageProductDependency productName ->
# the XCLocalSwiftPackageReference object id it belongs to.
#
# These ids are stable across xcodegen runs because xcodegen hashes the
# package name + path. If you add another local package, add a row here
# and a matching assertion above will fail-fast if xcodegen changes the
# id scheme.
LOCAL_PACKAGE_REF = {
    "EdgeProbe":    ("0E3F1EADCB6D23866E914B2D", ".."),
    "LlamaRuntime": ("5FDB92BA7861D450D9D8A8FC", "../LlamaRuntime"),
}

# Sanity-check that every expected XCLocalSwiftPackageReference is present
# before we try to link to it.
for product, (ref_id, rel_path) in LOCAL_PACKAGE_REF.items():
    needle = f'{ref_id} /* XCLocalSwiftPackageReference "{rel_path}" */'
    if needle not in text:
        raise SystemExit(
            f"ERROR: expected XCLocalSwiftPackageReference {ref_id} "
            f"for {product!r} ({rel_path!r}) not found in pbxproj. "
            f"xcodegen output changed — update generate.sh."
        )

# Insert `package = ...;` line into XCSwiftPackageProductDependency blocks
# for each local package. Skip if already present (idempotent).
patch_count = 0
for product, (ref_id, rel_path) in LOCAL_PACKAGE_REF.items():
    pattern = re.compile(
        r"(\/\* " + re.escape(product) + r" \*\/ = \{\n"
        r"\t+isa = XCSwiftPackageProductDependency;\n)"
        r"(\t+productName = " + re.escape(product) + r";)",
        re.MULTILINE,
    )
    new_text, n = pattern.subn(
        r'\1\t\t\tpackage = ' + ref_id +
        r' /* XCLocalSwiftPackageReference "' + rel_path + r'" */;' + "\n" +
        r'\2',
        text,
    )
    if n == 1:
        text = new_text
        patch_count += 1
    elif n == 0:
        # Either already patched, or block isn't shaped as expected.
        # Check for already-patched state — grep for the package= line.
        if f'package = {ref_id} /* XCLocalSwiftPackageReference "{rel_path}" */;' in text:
            patch_count += 1  # treat as patched
        else:
            raise SystemExit(
                f"ERROR: could not patch XCSwiftPackageProductDependency "
                f"block for {product!r}. xcodegen output shape changed — "
                f"update the regex in generate.sh."
            )
    else:
        raise SystemExit(
            f"ERROR: matched {n} blocks for {product!r}; expected 1."
        )

pbxproj.write_text(text)
print(f"Patched {patch_count}/{len(LOCAL_PACKAGE_REF)} local-package product dependencies.")
PY

# 3. Substitute the working public demo API key if the current value is
#    xcodegen's placeholder (happens when EDGEPROBE_API_KEY is unset).
#    Override at invocation time: `EDGEPROBE_API_KEY=epk_pub_yours ./generate.sh`.
DEFAULT_API_KEY="epk_pub_7b5b6c4854_87981d8e4d2e13c1b285e4f11c53b481"
if grep -q "EDGEPROBE_API_KEY = epk_pub_demo_voiceprobe;" "$PBXPROJ"; then
  sed -i '' \
    "s|EDGEPROBE_API_KEY = epk_pub_demo_voiceprobe;|EDGEPROBE_API_KEY = ${DEFAULT_API_KEY};|g" \
    "$PBXPROJ"
  echo "Substituted default EDGEPROBE_API_KEY (override via env var)."
fi

echo "VoiceProbe.xcodeproj regenerated and patched."
