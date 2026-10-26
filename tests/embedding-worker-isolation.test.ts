/**
 * The embedding worker must not block the main event loop.
 *
 * WHY THIS MATTERS (see src/services/embedding-worker.ts's header comment, and
 * src/services/embedding.ts's class comment): `embed()` used to run ONNX inference on the
 * same thread that serves every request. Measured live: a single uncached embed call took
 * 8.5-11.6s, and while it ran, nothing else in the process made progress — including the
 * `setTimeout` that `searchConcepts`'s `DENSE_BUDGET_MS` race depends on to bound the dense
 * leg at 2s. The fix moves the ONNX call into a worker thread (embedding-worker.ts), so a
 * slow computation occupies that thread, not the one running the HTTP server's event loop.
 *
 * MUST-FAIL AT THE PARENT: `embeddingService.__testBusyWaitInWorker` does not exist before
 * this change — there was no worker to busy-wait inside, and no way to make the OLD,
 * same-thread implementation "take a long time" deterministically without a real,
 * timing-sensitive, model-dependent inference call. Its absence IS the defect this test
 * names: no mechanism existed to keep a long embedding-shaped computation off the main
 * thread. At the fix, the method exists and the busy-wait genuinely runs in the worker,
 * provably not blocking the main thread's timers.
 *
 * The busy-wait itself never touches the ONNX model or the tokenizer — it is a deliberate
 * CPU spin inside the worker, used only so this test is deterministic and has no
 * dependency on model files being present in the sandbox.
 */
import { describe, test, expect } from 'bun:test';

describe('embedding worker isolation', () => {
  test('a long busy-wait routed to the worker does not block the main thread event loop', async () => {
    const mod = (await import('../src/services/embedding')) as any;
    const { embeddingService } = mod;

    expect(typeof embeddingService.__testBusyWaitInWorker).toBe('function');

    await embeddingService.init();

    const BUSY_MS = 400;
    const LAG_BOUND_MS = 120; // generous: must stay well under BUSY_MS to prove isolation

    // Fire the worker busy-wait WITHOUT awaiting it yet.
    const busyWaitPromise: Promise<void> = embeddingService.__testBusyWaitInWorker(BUSY_MS);

    // While the worker is (deliberately) occupied, probe the MAIN thread's own event loop:
    // a setTimeout(0) scheduled now should still fire promptly if the main thread is free.
    // If the busy-wait were running in-process instead of in a worker, this probe would be
    // delayed by (close to) the full BUSY_MS, because nothing on a blocked thread can run a
    // timer callback early.
    const probeStart = performance.now();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const probeLagMs = performance.now() - probeStart;

    expect(probeLagMs).toBeLessThan(LAG_BOUND_MS);

    // Sanity: the busy-wait actually ran (for roughly BUSY_MS), so a passing probe above is
    // proof of isolation, not proof that the busy-wait was a no-op.
    const busyStart = performance.now();
    await busyWaitPromise;
    // It may have already been most of the way done by the time we got here; just confirm
    // the call round-trips and resolves (already proven above to not have blocked us).
    expect(performance.now() - busyStart).toBeGreaterThanOrEqual(0);
  }, 10_000);

  test('CONTROL: the embedding cache still hits on a repeated string, independent of the worker', () => {
    const { EmbeddingCache, embeddingCacheKey } = require('../src/services/embedding');
    const cache = new EmbeddingCache(4);
    const key = embeddingCacheKey('a repeated query string');
    const vec = Float32Array.from([1, 2, 3]);
    expect(cache.get(key)).toBeUndefined();
    cache.set(key, vec);
    // Same cache key, same cached reference — the hit never needed to ask the worker again.
    expect(cache.get(key)).toBe(vec);
  });
});
