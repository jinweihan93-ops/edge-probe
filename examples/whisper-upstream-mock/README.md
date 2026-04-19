# Whisper upstream mock — EdgeProbe CI demo

This directory simulates a **whisper.cpp upstream maintainer**'s workflow.
Change a parameter → open a PR → EdgeProbe posts a comment showing the
transcription latency impact vs main.

The three demo PRs linked from the [root README](../../README.md) land on
this directory, and each is permanently open — point and click to see the
Action in action.

---

## Files

| File | What it is |
|------|-----------|
| `params.json` | Whisper knobs: `model_size`, `beam_size`, `n_threads` |
| `bin/synthesize.ts` | Pure function: params → trace.json |
| `baselines/main.json` | Baseline generated on main (default params) |

## The three demo PRs

| PR branch | Diff | What you'll see |
|-----------|------|-----------------|
| `demo/first-run` | `params.json` adds `project` pointing to a new id | **First-run** comment, no regression check, share URL |
| `demo/regression` | `beam_size: 1 → 5` | **Red**: decode +4x, headline +114%, share URL |
| `demo/green` | `n_threads: 4 → 8` | **Green ✓**: whisper-encoder speedup, headline −18% |

### Opening them (one-time, after the demo lands on main)

All three are intentionally boring mechanical diffs — copy-paste:

```bash
# 1. demo/regression — the star of the show
git checkout main && git pull
git checkout -b demo/regression
cat > examples/whisper-upstream-mock/params.json <<'EOF'
{
  "model_size": "tiny",
  "beam_size": 5,
  "n_threads": 4
}
EOF
git commit -am "demo: regression — bump beam_size to 5 to illustrate EdgeProbe red comment"
git push -u origin demo/regression
gh pr create --fill --title "demo: whisper beam_size 1→5 (regression)" \
  --body "Illustrates EdgeProbe catching a ~4x decode slowdown. Do not merge — keep permanently open."

# 2. demo/green — perf-win side
git checkout main && git checkout -b demo/green
cat > examples/whisper-upstream-mock/params.json <<'EOF'
{
  "model_size": "tiny",
  "beam_size": 1,
  "n_threads": 8
}
EOF
git commit -am "demo: green — bump n_threads to 8 to illustrate EdgeProbe green comment"
git push -u origin demo/green
gh pr create --fill --title "demo: whisper n_threads 4→8 (speedup)" \
  --body "Illustrates EdgeProbe confirming a safe perf win. Do not merge — keep permanently open."

# 3. demo/first-run — no baseline branch
git checkout main && git checkout -b demo/first-run
cat > examples/whisper-upstream-mock/params.json <<'EOF'
{
  "model_size": "tiny",
  "beam_size": 1,
  "n_threads": 4,
  "project": "whisper-upstream-mock-preview"
}
EOF
# Delete the baseline so the Action renders its first-run variant.
git rm examples/whisper-upstream-mock/baselines/main.json
git commit -am "demo: first-run — route trace to a fresh project with no baseline"
git push -u origin demo/first-run
gh pr create --fill --title "demo: whisper first trace on a new project" \
  --body "Illustrates EdgeProbe's first-run variant (no baseline, no regression math). Do not merge — keep permanently open."
```

**Why keep them open?** The three PRs are the README's "see it live" links. Merging any of them would retire the demo. Label them `demo` in the repo to make that explicit. When EdgeProbe evolves, re-push the branch — the sticky comment updates in place.

## The synthesis model

`bin/synthesize.ts` is NOT real whisper. It's a deterministic pure function
of `params.json`:

```
whisper_ms = BASE_ENCODE[model] * (1.5 / sqrt(threads))   # encoder → `whisper` column
decode_ms  = BASE_ENCODE[model] * 0.4 * (beam ^ 0.9)      # text decoder → `decode` column
```

Plus **±3% SHA-seeded noise** so the numbers look real but re-runs of the
same PR are byte-identical — no flaky CI, ever.

Why synthetic and not real whisper? Because GitHub runner CPU jitter
corrupts real benchmarks: two runs on the same machine can differ by
10-15%, which is already more than the Action's default regression
threshold. A demo that "sometimes" triggers a regression builds the wrong
intuition about EdgeProbe. We use synthetic so the demo is always right.

For the genuine "run whisper.cpp" experience, see
`examples/whisper-real-bench/` (not yet implemented — Layer 2 in the
fidelity matrix; add when Layer 1 graduates).

## Running locally

```bash
# 1. Synthesize current-run trace
bun run bin/synthesize.ts > /tmp/trace.json

# 2. Dry-run the Action against the baseline
bun run ../../action/src/entry.ts \
  --trace /tmp/trace.json \
  --baseline baselines/main.json \
  --threshold 0.15 \
  --dry-run
```

The last command prints the PR comment to stdout — same shape GitHub will
post, minus the share URL (dry-run skips the backend).

## Regenerating the baseline

When legitimate perf work on main produces a new "expected" number,
refresh the baseline:

```bash
bun run bin/synthesize.ts > baselines/main.json
```

Commit it to main. All demo PRs now diff against the new baseline
automatically.
