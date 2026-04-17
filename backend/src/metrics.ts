/**
 * Minimal Prometheus-style counter registry.
 *
 * Scope for Slice 4: just enough to expose `edgeprobe_spans_dropped_total{reason}`
 * and siblings at `GET /metrics`. We don't import `prom-client` because:
 * - `prom-client` pulls Node perf_hooks that Bun's test runner serializes less
 *   cleanly than a pure map.
 * - Counters are all we need until there's a histogram story worth telling.
 *
 * Exposition format reference:
 *   https://prometheus.io/docs/instrumenting/exposition_formats/
 *
 * Thread-safety note: Bun runs our handlers on a single JS event loop, so
 * concurrent `inc()` calls are serialized by the engine. If/when we go
 * multi-worker this has to move to a shared store (or per-worker scrape
 * endpoints). Document the assumption, don't silently break it.
 */

export class Metrics {
  private readonly counters = new Map<string, number>()
  /** Known metric names → help text, for consistent output ordering. */
  private readonly helps = new Map<string, string>()

  constructor() {
    // Pre-register the counter names we care about so they render even when
    // zero — otherwise a scraper sees "no data" right after boot and can't
    // tell "metric absent" from "metric intentionally 0".
    this.register(
      "edgeprobe_spans_dropped_total",
      "Total spans dropped at /ingest, labeled by reason (size, rate_limit, dedup).",
    )
    this.register(
      "edgeprobe_spans_ingested_total",
      "Total spans successfully persisted via /ingest.",
    )
    this.register(
      "edgeprobe_traces_purged_total",
      "Total traces purged by the retention sweep.",
    )
    this.register(
      "edgeprobe_ingest_requests_total",
      "Total /ingest requests, labeled by outcome.",
    )
  }

  /** Register a counter name so it renders even when unincremented. */
  register(name: string, help: string): void {
    this.helps.set(name, help)
    // Ensure the empty-labels key exists so first render shows 0.
    const key = this.key(name, {})
    if (!this.counters.has(key)) this.counters.set(key, 0)
  }

  inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = this.key(name, labels)
    this.counters.set(key, (this.counters.get(key) ?? 0) + by)
  }

  /** Exposed for tests. */
  get(name: string, labels: Record<string, string> = {}): number {
    return this.counters.get(this.key(name, labels)) ?? 0
  }

  reset(): void {
    this.counters.clear()
    // Re-seed registered zero rows.
    for (const name of this.helps.keys()) {
      this.counters.set(this.key(name, {}), 0)
    }
  }

  /** Prometheus text exposition format. Trailing newline is required. */
  render(): string {
    const lines: string[] = []
    // Group by metric name, deterministic order.
    const byName = new Map<string, Array<{ labels: string; value: number }>>()
    for (const [k, v] of this.counters) {
      const sep = k.indexOf("|")
      const name = sep === -1 ? k : k.slice(0, sep)
      const labels = sep === -1 ? "" : k.slice(sep + 1)
      const list = byName.get(name) ?? []
      list.push({ labels, value: v })
      byName.set(name, list)
    }
    const names = [...byName.keys()].sort()
    for (const name of names) {
      const entries = byName.get(name)!.sort((a, b) => a.labels.localeCompare(b.labels))
      const help = this.helps.get(name) ?? ""
      if (help) lines.push(`# HELP ${name} ${help}`)
      lines.push(`# TYPE ${name} counter`)
      for (const e of entries) {
        const labelStr = e.labels ? `{${e.labels}}` : ""
        lines.push(`${name}${labelStr} ${e.value}`)
      }
    }
    return lines.join("\n") + "\n"
  }

  private key(name: string, labels: Record<string, string>): string {
    const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))
    if (entries.length === 0) return name
    const enc = entries
      .map(([k, v]) => `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
      .join(",")
    return `${name}|${enc}`
  }
}
