/**
 * The embedding worker dying must not hang every embed() forever, and the service must
 * recover without a restart.
 *
 * At e9508bc9 (the worker-isolation fix, before this review round), `spawnWorker()`'s
 * 'error' handler set `ready=false` and logged, but never touched `pendingEmbeds` — so an
 * embed() in flight when the worker crashed stayed pending forever, leaking its promise
 * and the closure holding it. There was also no 'exit' handler at all: a worker that exits
 * WITHOUT emitting 'error' first (a native ONNX abort, an OOM kill, `process.exit()` inside
 * the worker, or simply `worker.terminate()`) left `ready` stuck at `true` with a dead
 * `Worker` object sitting in `this.worker` — every later embed() would post into a worker
 * that can never reply, so every dense recall would silently time out FOREVER instead of
 * resolving quickly, which is worse than the pre-worker (same-thread) behaviour this file
 * replaced.
 *
 * The fix (see embedding.ts's spawnWorker()): BOTH 'error' and 'exit' reject every pending
 * embed/busy-wait with a named error, drop the worker reference, and set ready=false; the
 * NEXT embed() call lazily respawns (with a backoff, so a worker crashing immediately on
 * every start does not spin).
 *
 * `worker.terminate()` triggers ONLY 'exit' (never 'error') — exactly the uncovered path
 * from the bug report — so it is what this test uses to kill the worker.
 */
import { describe, test, expect } from 'bun:test';

// This file's OWN instance of the module, not the shared specifier: in a one-process run an
// earlier file may have replaced '../src/services/embedding' with a stub through mock.module
// and never put it back (a file that throws while loading never runs its afterAll), or
// patched methods on the shared singleton. Neither reaches an instance loaded here.
const EMBEDDING = '../src/services/embedding.ts?hermetic=embedding-worker-crash-recovery';

describe('embedding worker crash recovery', () => {
  test(
    'MUST-FAIL: terminating the worker mid-embed rejects the pending call promptly (not hangs), and the next call gets a fresh worker',
    async () => {
      const mod = (await import(EMBEDDING)) as any;
      const { embeddingService } = mod;
      const svc = embeddingService as Record<string, any>;

      await embeddingService.init();
      const deadWorker = svc.worker;
      expect(deadWorker).toBeTruthy();

      // Simulate "an embed is mid-flight" directly against the real pendingEmbeds map —
      // the same map embed() itself populates — rather than racing a real postMessage
      // against termination, so the test is deterministic regardless of how fast the
      // (model-less) worker would otherwise have replied.
      const markerId = 'mf-mid-embed-marker';
      const pendingSettled = new Promise<number[]>((resolve, reject) => {
        svc.pendingEmbeds.set(markerId, { resolve, reject });
      });

      // Only 'exit' fires for this, never 'error' — the uncovered path.
      deadWorker.terminate();

      // AT THE PARENT (e9508bc9): nothing rejects this, so the test would hang until bun's
      // own test timeout below fires and FAILS it — "fails rather than hangs", per review.
      // AT THE FIX: the 'exit' handler rejects it immediately.
      await expect(pendingSettled).rejects.toBeInstanceOf(Error);

      // The dead worker's entry must be gone from the map, not merely settled once and
      // left dangling (the leak half of the bug).
      expect(svc.pendingEmbeds.has(markerId)).toBe(false);

      // A respawn right after death is backed off on purpose (so a worker that dies on
      // every start does not spin) — this FIRST post-crash call lands inside that window
      // and correctly gets the same "not ready" a caller would see with no worker at all,
      // without a fresh spawn yet.
      await expect(embeddingService.embed('post-crash-probe')).rejects.toThrow(/not ready/i);
      expect(svc.worker).toBeNull();

      // Once the backoff window has passed, the NEXT call gets a FRESH worker, lazily
      // (not eagerly at crash time): embed() itself triggers the respawn. The model is
      // not present in this sandbox, so the call ultimately still rejects with "not
      // ready" — that part is unrelated to crash recovery and unavoidable here — but the
      // respawn side effect (a new worker object, genuinely alive) happens regardless,
      // which is the thing under test.
      await new Promise((resolve) => setTimeout(resolve, 300)); // > the 250ms base backoff
      await expect(embeddingService.embed('post-crash-probe-2')).rejects.toThrow(/not ready/i);
      expect(svc.worker).toBeTruthy();
      expect(svc.worker).not.toBe(deadWorker);

      // Prove the fresh worker actually answers (model-independent: the test-only
      // busy-wait hook never touches the model), rather than merely existing as an object.
      await embeddingService.__testBusyWaitInWorker(10);
    },
    5_000, // bound the wait: at the parent this must FAIL on timeout, not hang the suite
  );

  test('CONTROL: the normal embed() path is unaffected when the worker has not died', async () => {
    const mod = (await import(EMBEDDING)) as any;
    const { embeddingService } = mod;
    const svc = embeddingService as Record<string, any>;

    await embeddingService.init();
    // No model in this sandbox, so the normal (non-crash) path still reports not-ready —
    // exactly the parent's own behaviour, unchanged by this fix. The crash-recovery
    // machinery above must not alter this ordinary case.
    expect(embeddingService.isReady()).toBe(false);
    await expect(embeddingService.embed('control string')).rejects.toThrow('LocalEmbeddingService not ready');
  });
});
