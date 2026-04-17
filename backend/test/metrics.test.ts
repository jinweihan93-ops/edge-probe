import { describe, test, expect } from "bun:test"
import { Metrics } from "../src/metrics.ts"

/**
 * Pure tests for the in-process counter registry. The /metrics endpoint's
 * HTTP behavior is covered by ingestHardening.test.ts; here we just check
 * the exposition format stays valid and labels encode correctly.
 */

describe("Metrics — exposition format", () => {
  test("registered counters render with # HELP / # TYPE even at zero", () => {
    const m = new Metrics()
    const out = m.render()
    expect(out).toContain("# HELP edgeprobe_spans_dropped_total")
    expect(out).toContain("# TYPE edgeprobe_spans_dropped_total counter")
    expect(out).toContain("edgeprobe_spans_dropped_total 0")
  })

  test("ends with a single newline (Prometheus scraper requirement)", () => {
    const out = new Metrics().render()
    expect(out.endsWith("\n")).toBe(true)
    expect(out.endsWith("\n\n")).toBe(false)
  })

  test("counter with labels renders in {k=\"v\"} form", () => {
    const m = new Metrics()
    m.inc("edgeprobe_spans_dropped_total", { reason: "dedup" }, 3)
    const out = m.render()
    expect(out).toContain('edgeprobe_spans_dropped_total{reason="dedup"} 3')
  })

  test("labels are deterministically ordered", () => {
    const m = new Metrics()
    m.inc("edgeprobe_ingest_requests_total", { outcome: "accepted", zebra: "1" })
    const out = m.render()
    // Alphabetical: outcome, then zebra.
    expect(out).toMatch(/edgeprobe_ingest_requests_total\{outcome="accepted",zebra="1"\}/)
  })

  test("quotes in label values are escaped", () => {
    const m = new Metrics()
    m.inc("edgeprobe_spans_dropped_total", { reason: 'he said "hi"' })
    const out = m.render()
    expect(out).toContain('reason="he said \\"hi\\""')
  })

  test("get() returns current value; inc() compounds", () => {
    const m = new Metrics()
    m.inc("edgeprobe_spans_ingested_total", {}, 5)
    m.inc("edgeprobe_spans_ingested_total", {}, 3)
    expect(m.get("edgeprobe_spans_ingested_total")).toBe(8)
  })

  test("reset() zeroes everything but keeps registered counter names", () => {
    const m = new Metrics()
    m.inc("edgeprobe_spans_dropped_total", { reason: "size" }, 7)
    m.reset()
    expect(m.get("edgeprobe_spans_dropped_total", { reason: "size" })).toBe(0)
    expect(m.render()).toContain("edgeprobe_spans_dropped_total 0")
  })
})

describe("Metrics — ad-hoc counter registration", () => {
  test("unregistered counter names also render once they've been incremented", () => {
    const m = new Metrics()
    m.inc("custom_counter_total", { tag: "x" })
    const out = m.render()
    expect(out).toContain('custom_counter_total{tag="x"} 1')
  })
})
