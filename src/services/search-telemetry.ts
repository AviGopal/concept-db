/**
 * Telemetry for the two things that were unmeasurable while concept search silently
 * returned ZERO for a full day (2026-09-02/03).
 *
 * WHAT HAPPENED. The dense leg misses its 2000ms budget, search degrades to lexical,
 * lexical returns zero, and feature-compose plans with NO architectural principles — the
 * mechanism behind two inert substrate-authored commits (776391aa0f, 62e66a7) whose correct
 * pattern sat four times in the file being edited. Throughout, `/health` answered in 6.7ms:
 * a liveness ping reporting green through a total outage of the capability.
 *
 * WHY IT WAS UNDIAGNOSABLE. Every component measures fast in isolation — embed 51ms,
 * HNSW KNN 97–128ms, filter-only search 154ms, expected composition ~300ms — against an
 * observed 8–12s. A ~30x gap belonging to no operation. Three operator attributions were
 * wrong before component timing settled it, and one of them shipped. The remaining
 * hypothesis is event-loop starvation (ONNX `session.run()` is CPU-bound and blocks Bun's
 * single loop while background embedding runs), and nothing measured loop lag, so it could
 * be neither confirmed nor refuted.
 *
 * Observability only. Nothing here changes a verdict, a budget, or a query.
 */

export interface DenseLegSnapshot {
  searches: number;
  dense_hits: number;
  dense_budget_misses: number;
  dense_true_empty: number;
  dense_budget_miss_rate: number;
}

/**
 * Counts dense-leg outcomes, and — the load-bearing part — DISTINGUISHES a budget miss from
 * an honestly empty result. The existing log line cannot: both take the
 * `denseResults.length === 0` branch, so counting that branch alone would report starvation
 * on a query that simply had no matches.
 */
export class DenseLegStats {
  private searches = 0;
  private hits = 0;
  private misses = 0;
  private trueEmpty = 0;

  recordHit(): void { this.searches++; this.hits++; }

  recordEmpty(opts: { timedOut: boolean }): void {
    this.searches++;
    if (opts.timedOut) this.misses++;
    else this.trueEmpty++;
  }

  snapshot(): DenseLegSnapshot {
    return {
      searches: this.searches,
      dense_hits: this.hits,
      dense_budget_misses: this.misses,
      dense_true_empty: this.trueEmpty,
      // Never NaN: a health field that can be NaN is a field nothing can alarm on.
      dense_budget_miss_rate: this.searches === 0 ? 0 : this.misses / this.searches,
    };
  }
}

export interface EventLoopLagSnapshot {
  samples: number;
  p50_ms: number;
  max_ms: number;
}

/**
 * Rolling event-loop lag. Starvation shows up here as a large `max_ms` while every
 * individual operation still measures fast — exactly the signature this vessel exhibits.
 *
 * BOUNDED on purpose: an unbounded sample buffer in a long-lived vessel trades a latency
 * defect for a memory one, and a lifetime aggregate would describe boot rather than now.
 */
export class EventLoopLagSampler {
  private readonly buf: number[] = [];
  constructor(private readonly capacity = 120) {}

  record(lagMs: number): void {
    if (!Number.isFinite(lagMs) || lagMs < 0) return;
    this.buf.push(lagMs);
    while (this.buf.length > this.capacity) this.buf.shift();
  }

  /** Sample the loop every `intervalMs`; the drift beyond the interval IS the lag. */
  start(intervalMs = 1000): ReturnType<typeof setInterval> {
    let last = Date.now();
    const t = setInterval(() => {
      const now = Date.now();
      this.record(Math.max(0, now - last - intervalMs));
      last = now;
    }, intervalMs);
    // Never hold the process open for telemetry.
    (t as unknown as { unref?: () => void }).unref?.();
    return t;
  }

  snapshot(): EventLoopLagSnapshot {
    if (this.buf.length === 0) return { samples: 0, p50_ms: 0, max_ms: 0 };
    const sorted = [...this.buf].sort((a, b) => a - b);
    return {
      samples: sorted.length,
      p50_ms: sorted[Math.floor((sorted.length - 1) / 2)] ?? 0,
      max_ms: sorted[sorted.length - 1] ?? 0,
    };
  }
}

/** Process-wide singletons — one vessel, one loop, one search path. */
export const denseLegStats = new DenseLegStats();
export const eventLoopLag = new EventLoopLagSampler();
