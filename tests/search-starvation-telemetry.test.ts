import { describe, it, expect } from "bun:test";
import { DenseLegStats, EventLoopLagSampler } from "../src/services/search-telemetry.js";

// Instruments the two things that were unmeasurable when concept search silently returned
// zero for a full day, 2026-09-02/03.
//
// WHAT HAPPENED. The dense leg misses a 2000ms budget, search degrades to lexical, lexical
// returns ZERO, and feature-compose plans with NO architectural principles — the mechanism
// behind two inert substrate-authored commits (776391aa0f, 62e66a7) whose correct pattern
// sat four times in the file being edited. Throughout, /health answered in 6.7ms.
//
// WHY IT WAS UNDIAGNOSABLE. Every component measures fast in isolation — embed 51ms,
// HNSW KNN 97–128ms, filter-only search 154ms, expected composition ~300ms — against an
// observed 8–12s. A ~30x gap that belongs to no operation. The remaining hypothesis is
// event-loop starvation (ONNX session.run() is CPU-bound and blocks Bun's single loop while
// background embedding runs), and NOTHING measured loop lag, so it could not be confirmed
// or refuted. Three operator attributions were wrong before component timing settled it,
// one of them shipped.
//
// TWO READERS, both of which the vessel needed and neither of which existed:
//  1. a dense-leg miss counter that DISTINGUISHES timeout from genuinely-zero-matches —
//     the existing log conflates them (both take `denseResults.length === 0`), so a naive
//     counter would overcount and report starvation where there simply were no matches;
//  2. event-loop lag, which is the direct test of the starvation hypothesis.

describe("DenseLegStats — must distinguish timeout from true-zero", () => {
  it("counts a budget miss separately from an honest empty result", () => {
    const s = new DenseLegStats();
    s.recordHit();
    s.recordEmpty({ timedOut: true });   // starvation
    s.recordEmpty({ timedOut: false });  // no matches — NOT a defect
    const snap = s.snapshot();
    expect(snap.searches).toBe(3);
    expect(snap.dense_budget_misses).toBe(1);
    expect(snap.dense_true_empty).toBe(1);
    expect(snap.dense_hits).toBe(1);
  });

  it("reports a miss RATE, which is the thing worth alarming on", () => {
    const s = new DenseLegStats();
    for (let i = 0; i < 3; i++) s.recordEmpty({ timedOut: true });
    s.recordHit();
    expect(s.snapshot().dense_budget_miss_rate).toBeCloseTo(0.75, 5);
  });

  it("is 0 rate with no searches rather than NaN — a health field must never be NaN", () => {
    expect(new DenseLegStats().snapshot().dense_budget_miss_rate).toBe(0);
  });

  it("keeps counters monotonic and independent", () => {
    const s = new DenseLegStats();
    s.recordEmpty({ timedOut: true });
    const a = s.snapshot();
    s.recordHit();
    const b = s.snapshot();
    expect(b.dense_budget_misses).toBe(a.dense_budget_misses);
    expect(b.dense_hits).toBe(a.dense_hits + 1);
  });
});

describe("EventLoopLagSampler — the direct test of the starvation hypothesis", () => {
  it("reports zero-ish lag before any sample rather than NaN", () => {
    const s = new EventLoopLagSampler();
    const snap = s.snapshot();
    expect(snap.samples).toBe(0);
    expect(Number.isFinite(snap.max_ms)).toBe(true);
    expect(Number.isFinite(snap.p50_ms)).toBe(true);
  });

  it("records lag and tracks the maximum, which is what starvation shows up as", () => {
    const s = new EventLoopLagSampler();
    s.record(2); s.record(900); s.record(4);
    const snap = s.snapshot();
    expect(snap.samples).toBe(3);
    expect(snap.max_ms).toBe(900);
  });

  it("is BOUNDED — a long-running vessel must not accumulate samples forever", () => {
    const s = new EventLoopLagSampler(4);
    for (let i = 0; i < 50; i++) s.record(i);
    expect(s.snapshot().samples).toBeLessThanOrEqual(4);
    // keeps the most recent window, so it reflects NOW rather than boot
    expect(s.snapshot().max_ms).toBe(49);
  });

  it("computes a median that is robust to one spike", () => {
    const s = new EventLoopLagSampler(8);
    for (const v of [1, 2, 3, 4, 5000]) s.record(v);
    expect(s.snapshot().p50_ms).toBe(3);
    expect(s.snapshot().max_ms).toBe(5000);
  });
});
