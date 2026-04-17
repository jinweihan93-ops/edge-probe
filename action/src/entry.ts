#!/usr/bin/env bun
/**
 * EdgeProbe GitHub Action entry point.
 *
 * Reads a trace summary from disk (path given via flag or env), optionally
 * compares it against a baseline, renders the PR comment, and — unless
 * `--dry-run` is set — posts the result to the PR via `gh`.
 *
 * The interesting behavior is mostly wiring. Each individual step lives in
 * `comment.ts`, `compare.ts`, `client.ts`, which are unit-tested. This
 * module only:
 *   - parses flags,
 *   - pulls optional env vars for git metadata (GITHUB_SHA / GITHUB_REF),
 *   - calls the backend to mint a share URL,
 *   - writes comment body + exit code.
 *
 * Exit codes:
 *   0 — no regression (or first-run).
 *   1 — regression and `--fail-on-regression=true` (default).
 *   2 — internal error (failed to ingest / share / read input).
 */

import { renderComment } from "./comment.ts"
import { compareAgainstBaseline } from "./compare.ts"
import { ActionClient } from "./client.ts"
import type { TraceSummary } from "./types.ts"

export interface EntryOptions {
  tracePath: string
  baselinePath?: string | undefined
  threshold: number
  failOnRegression: boolean
  backendUrl?: string | undefined
  ingestKey?: string | undefined
  dashboardKey?: string | undefined
  orgId: string
  projectId: string
  dryRun: boolean
  version: string
  configureUrl?: string | undefined
  /** Injected for tests. Otherwise a real ActionClient + fs + process.exit. */
  deps?: EntryDeps | undefined
}

export interface EntryDeps {
  readFile: (path: string) => Promise<string>
  writeOutput: (body: string) => Promise<void>
  client?: ActionClient | undefined
  /** Overridable for tests. */
  now?: () => Date
}

export interface EntryResult {
  /** Rendered comment body. */
  body: string
  /** Process exit code. Callers may translate directly. */
  exitCode: 0 | 1 | 2
  /** Share URL if one was minted. */
  shareUrl: string | null
  /** Regression verdict proportion; null on first-run. */
  delta: number | null
}

export async function runAction(opts: EntryOptions): Promise<EntryResult> {
  const deps: Required<Pick<EntryDeps, "readFile" | "writeOutput">> & EntryDeps =
    opts.deps ?? {
      readFile: (p) => Bun.file(p).text(),
      writeOutput: async (body: string) => {
        const out = process.env.GITHUB_OUTPUT
        if (out) {
          // GitHub multi-line output format:
          //   comment<<EOF\n<body>\nEOF\n
          const delim = `EOF_${Math.floor(Math.random() * 1e9).toString(36)}`
          await Bun.write(
            out,
            `comment<<${delim}\n${body}\n${delim}\n`,
            { createPath: true },
          )
        }
        // Always echo to stdout for local runs + CI log grepping.
        process.stdout.write(body)
      },
    }

  let current: TraceSummary
  try {
    const raw = await deps.readFile(opts.tracePath)
    current = parseSummary(raw, opts.tracePath)
  } catch (err) {
    return fatal(`failed to read trace: ${(err as Error).message}`)
  }

  let baseline: TraceSummary | null = null
  if (opts.baselinePath) {
    try {
      const raw = await deps.readFile(opts.baselinePath)
      baseline = parseSummary(raw, opts.baselinePath)
    } catch (err) {
      // Baseline not present or malformed. Downgrade to first-run.
      // Surface on stderr so the CI log shows why the comment looks
      // like a first-run even though --baseline was passed.
      console.error(`[edgeprobe-action] ignoring unreadable baseline: ${(err as Error).message}`)
      baseline = null
    }
  }

  // Fill in git metadata from the env if the caller didn't already set it.
  current = enrichGit(current)
  if (baseline) baseline = enrichGit(baseline, { preferBase: true })

  let shareUrl: string | null = null
  const canShare = !opts.dryRun && opts.backendUrl && opts.ingestKey && opts.dashboardKey
  if (canShare) {
    const client = opts.deps?.client ?? new ActionClient({
      baseUrl: opts.backendUrl!,
      ingestKey: opts.ingestKey!,
      dashboardKey: opts.dashboardKey!,
    })
    try {
      const r = await client.ingestAndShare(current, {
        orgId: opts.orgId,
        projectId: opts.projectId,
      })
      shareUrl = r.shareUrl
    } catch (err) {
      // Backend failures must not block the CI job — the comment still
      // renders without a share link. Log and continue.
      console.error(`[edgeprobe-action] share mint failed: ${(err as Error).message}`)
    }
  }

  const verdict = compareAgainstBaseline(current, baseline, opts.threshold)
  const body = renderComment({
    current,
    baseline,
    verdict,
    threshold: opts.threshold,
    shareUrl,
    version: opts.version,
    configureUrl: opts.configureUrl,
  })

  await deps.writeOutput(body)

  const exitCode: 0 | 1 | 2 = verdict.regression && opts.failOnRegression ? 1 : 0
  return { body, exitCode, shareUrl, delta: verdict.delta }
}

// --- helpers ---

function fatal(message: string): EntryResult {
  console.error(`[edgeprobe-action] ${message}`)
  const body = `### EdgeProbe · action failed\n\n${message}\n`
  return { body, exitCode: 2, shareUrl: null, delta: null }
}

export function parseSummary(raw: string, path: string): TraceSummary {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`${path}: invalid JSON: ${(err as Error).message}`)
  }
  if (!isTraceSummary(parsed)) {
    throw new Error(`${path}: missing required fields (project, label, headlineMetric, headlineMs, totalMs, turns[])`)
  }
  return parsed
}

function isTraceSummary(v: unknown): v is TraceSummary {
  if (!v || typeof v !== "object") return false
  const o = v as Record<string, unknown>
  return (
    typeof o.project === "string" &&
    typeof o.label === "string" &&
    typeof o.headlineMetric === "string" &&
    typeof o.headlineMs === "number" &&
    typeof o.totalMs === "number" &&
    Array.isArray(o.turns)
  )
}

function enrichGit(summary: TraceSummary, flags?: { preferBase?: boolean }): TraceSummary {
  const ref = process.env.GITHUB_REF_NAME
  const sha = process.env.GITHUB_SHA
  const baseRef = process.env.GITHUB_BASE_REF

  if (!ref && !sha && !baseRef) return summary
  const git = { ...(summary.git ?? {}) }
  if (flags?.preferBase) {
    if (!git.thisRef && baseRef) git.thisRef = baseRef
    if (!git.thisSha && sha) git.thisSha = sha
  } else {
    if (!git.thisRef && ref) git.thisRef = ref
    if (!git.thisSha && sha) git.thisSha = sha
    if (!git.baselineRef && baseRef) git.baselineRef = baseRef
  }
  return { ...summary, git }
}

// --- CLI wrapper ---

/**
 * Tiny flag parser. Intentionally home-grown — adding a dependency here
 * is worse than 30 lines of string handling for a five-flag surface.
 */
export function parseArgs(argv: string[]): Partial<EntryOptions> & { _positional: string[] } {
  const out: Partial<EntryOptions> & { _positional: string[] } = { _positional: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a) continue
    const next = argv[i + 1]
    switch (a) {
      case "--trace":
      case "--trace-file":
        if (next) { out.tracePath = next; i++ }
        break
      case "--baseline":
      case "--baseline-file":
        if (next) { out.baselinePath = next; i++ }
        break
      case "--threshold":
        if (next) { out.threshold = Number(next); i++ }
        break
      case "--fail-on-regression":
        if (next) { out.failOnRegression = next !== "false"; i++ }
        else out.failOnRegression = true
        break
      case "--backend-url":
        if (next) { out.backendUrl = next; i++ }
        break
      case "--ingest-key":
        if (next) { out.ingestKey = next; i++ }
        break
      case "--dashboard-key":
        if (next) { out.dashboardKey = next; i++ }
        break
      case "--org":
      case "--org-id":
        if (next) { out.orgId = next; i++ }
        break
      case "--project":
      case "--project-id":
        if (next) { out.projectId = next; i++ }
        break
      case "--dry-run":
        out.dryRun = true
        break
      case "--configure-url":
        if (next) { out.configureUrl = next; i++ }
        break
      case "--version":
        if (next) { out.version = next; i++ }
        break
      default:
        if (!a.startsWith("--")) out._positional.push(a)
        break
    }
  }
  return out
}

/** Default used when no version is specified; sourced from env or fallback. */
export const ACTION_VERSION = process.env.EDGEPROBE_ACTION_VERSION ?? "0.0.1"

/** Invoked by `bun run src/entry.ts …`. */
export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv)
  if (!parsed.tracePath) {
    console.error("usage: edgeprobe-action --trace <file> [--baseline <file>] [--threshold 0.15] [--backend-url …] [--ingest-key …] [--dashboard-key …] [--dry-run]")
    return 2
  }
  const opts: EntryOptions = {
    tracePath: parsed.tracePath,
    baselinePath: parsed.baselinePath,
    threshold: parsed.threshold ?? 0.15,
    failOnRegression: parsed.failOnRegression ?? true,
    backendUrl: parsed.backendUrl ?? process.env.EDGEPROBE_BACKEND_URL,
    ingestKey: parsed.ingestKey ?? process.env.EDGEPROBE_INGEST_KEY,
    dashboardKey: parsed.dashboardKey ?? process.env.EDGEPROBE_DASHBOARD_KEY,
    orgId: parsed.orgId ?? process.env.EDGEPROBE_ORG_ID ?? "org_unknown",
    projectId: parsed.projectId ?? process.env.EDGEPROBE_PROJECT_ID ?? "proj_unknown",
    dryRun: parsed.dryRun ?? false,
    version: parsed.version ?? ACTION_VERSION,
    configureUrl: parsed.configureUrl,
  }
  const result = await runAction(opts)
  return result.exitCode
}

if (import.meta.main) {
  const code = await main(Bun.argv.slice(2))
  process.exit(code)
}
