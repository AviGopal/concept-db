/**
 * LocalEmbeddingService — all-MiniLM-L6-v2 via onnxruntime-node, run in a worker thread.
 *
 * Loads the ONNX model from disk (EMBEDDING_MODEL_DIR env var, default
 * /app/models/all-MiniLM-L6-v2). Init is async and non-blocking; callers
 * check isReady() and fall back to BM25-only when false.
 *
 * Produces L2-normalised 384-dim Float32Arrays. Cosine similarity over
 * normalised vectors reduces to a dot product.
 *
 * THE ACTUAL ONNX INFERENCE RUNS IN embedding-worker.ts, NOT HERE. This class spawns that
 * worker once (init()) and talks to it over postMessage; every public method below keeps
 * its old signature and behaviour. See embedding-worker.ts's header comment for why: a
 * same-thread `session.run()` call could run for 8-11s (measured live, 2026-09-03) and
 * block the event loop for its whole duration, including the `setTimeout` that
 * `searchConcepts`'s DENSE_BUDGET_MS race depends on — so the race could not enforce its
 * own 2s budget against a slow embed. The worker boundary fixes that without touching the
 * race itself: the main thread stays free to run its timers regardless of how long the
 * worker takes, so a slow embed now actually gets abandoned at ~DENSE_BUDGET_MS instead of
 * at the embed's own duration. The tokenizer, the ONNX session, and the mean-pool/L2-
 * normalise maths moved to the worker VERBATIM, so a given text still produces the
 * bit-identical vector it always did.
 */

import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { logger } from '../utils/logger';

const DIM = 384;

/**
 * QUERY-EMBEDDING CACHE.
 *
 * MEASURED 2026-09-03 against the live vessel at host load ~5.5, with controls that
 * isolate the cost to a single call:
 *
 *     GET /concepts/<id>                   0.035s
 *     GET /concepts/search?source_type=…   0.154s   <- filter-only: no query embedding
 *     GET /concepts/search?query=…         8–11.6s  <- the whole cost is the embedding
 *
 * The store, the HNSW index and routing are all fast. `embed()` runs a local ONNX
 * inference padded to MAX_SEQ_LEN on every call, and an IDENTICAL query recomputes from
 * scratch every time: three consecutive runs of the same string measured 8.5s, 11.6s, 8.4s.
 *
 * Why this is not merely a latency nicety. feature-compose consults these principles
 * before planning ("CONSULTATION-ON-AUTHOR") on an 8s budget. At ~10s that consult times
 * out and the drafter plans with NO architectural principles — development-vessel logged
 * 18 principle-consult failures in one afternoon while this vessel's /health answered in
 * 6.7ms. That is the mechanism behind the substrate authoring `exports.substrateGap.emit`
 * and then `POST /v2/impulses/substrateGap`: the contract WAS in the store, and the reader
 * could not afford to read it.
 *
 * The consult reduces a spec to a few salient terms, so queries repeat heavily across
 * composes — the workload a cache is for. Bounded LRU: a cache that can grow without limit
 * would trade a latency defect for a memory one. The cache stays on the MAIN thread (not
 * in the worker): a cache hit must not pay even the cost of a worker round-trip.
 */
const EMBED_CACHE_CAPACITY = Number(process.env.EMBEDDING_CACHE_CAPACITY ?? 512);

/** Cache key. Deliberately NOT normalised — the embedder is sensitive to spacing, so two
 *  strings that differ at all must not share a vector. */
export function embeddingCacheKey(text: string): string {
  return text;
}

/** Bounded LRU over query vectors. Capacity <= 0 disables caching (never throws). */
export class EmbeddingCache {
  private readonly map = new Map<string, Float32Array>();
  constructor(private readonly capacity: number) {}
  get size(): number { return this.map.size; }
  get(key: string): Float32Array | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key); // re-insert to refresh recency
    this.map.set(key, v);
    return v;
  }
  set(key: string, vec: Float32Array): void {
    if (this.capacity <= 0) return;
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, vec);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

type PendingEmbed = { resolve: (vec: number[]) => void; reject: (err: Error) => void };
type PendingBusyWait = { resolve: () => void };

/** Cap on the worker-respawn backoff, so a worker that crashes immediately on every
 *  start (a bad model path, a crash loop) backs off instead of spinning. */
const RESPAWN_BACKOFF_CAP_MS = 30_000;
const RESPAWN_BACKOFF_BASE_MS = 250;

class LocalEmbeddingServiceImpl {
  private worker: Worker | null = null;
  private ready = false;
  private initError: string | null = null;
  private readonly pendingEmbeds = new Map<string, PendingEmbed>();
  private readonly pendingBusyWaits = new Map<string, PendingBusyWait>();
  private readonly embedCache = new EmbeddingCache(EMBED_CACHE_CAPACITY);
  private modelStatusResolved: Promise<void> | null = null;
  /** Set once init() has actually spawned a worker. Distinguishes "never started" (embed()
   *  should throw its plain not-ready error, as always) from "started, then the worker
   *  died" (embed() should try a lazy respawn first). */
  private everInitialized = false;
  /** Consecutive worker deaths since the last successful model_status. Drives the backoff
   *  below; reset to 0 the moment a respawned worker reports a real model_status (ok or
   *  not — reaching that point means the worker process itself is viable again). */
  private respawnAttempts = 0;
  /** Earliest time (Date.now()) a lazy respawn may be attempted again. 0 = no backoff in
   *  effect. Prevents a "tight loop" of synchronous respawns against a worker that keeps
   *  dying immediately on start. */
  private nextRespawnAllowedAt = 0;

  isReady(): boolean {
    return this.ready;
  }

  getStatus(): { status: 'healthy' | 'loading' | 'disabled'; model: string; dim: number } {
    return {
      status: this.ready ? 'healthy' : this.initError ? 'disabled' : 'loading',
      model: 'all-MiniLM-L6-v2',
      dim: DIM,
    };
  }

  /** Spawns the embedding worker once and waits for its model-load attempt to settle
   *  (success or failure — both resolve init(), matching the old same-thread behaviour
   *  where a missing model left isReady() false rather than rejecting). */
  async init(): Promise<void> {
    this.everInitialized = true;
    if (this.worker) return this.modelStatusResolved ?? Promise.resolve();
    return this.spawnWorker();
  }

  /**
   * Spawns one worker and wires its lifecycle. Returns a promise that settles once the
   * worker's model_status arrives OR the worker dies before it ever does — both cases
   * unblock a caller awaiting this, matching the old same-thread behaviour where a
   * missing model left isReady() false rather than hanging a caller forever.
   *
   * ON 'error' AND ON 'exit' (BOTH — Node can emit either, or both, for the same crash;
   * a native ONNX abort, an OOM kill, or an explicit process.exit() inside the worker
   * produce 'exit' with no preceding 'error' at all, and `worker.terminate()` ALWAYS
   * produces only 'exit'): every pending embed and busy-wait is settled immediately (never
   * left to hang — a hung caller is worse than the pre-worker behaviour this file replaced,
   * because it never times out on its own), `ready` drops to false, and the dead worker
   * reference is dropped so the NEXT embed() knows to respawn rather than post into the
   * void. Idempotent: 'error' then 'exit' for the same crash must not double-reject an
   * already-cleared pendingEmbeds map, and a handler firing on an ALREADY-REPLACED worker
   * (this.worker !== the one that died) is a no-op.
   */
  private spawnWorker(): Promise<void> {
    const worker = new Worker(new URL('./embedding-worker.ts', import.meta.url));
    this.worker = worker;

    let resolveModelStatus: () => void = () => {};
    const modelStatusResolved = new Promise<void>((resolve) => { resolveModelStatus = resolve; });
    this.modelStatusResolved = modelStatusResolved;

    let handledDeath = false;
    const onDeath = (reason: 'error' | 'exit', detail: string): void => {
      if (handledDeath) return; // 'error' then 'exit' for the same crash — handle once
      if (this.worker !== worker) return; // this worker was already replaced; not our concern
      handledDeath = true;

      const message = `embedding worker ${reason} (${detail})`;
      logger.error('[LocalEmbedding] embedding worker died — rejecting in-flight embeds, will respawn lazily', {
        reason,
        detail,
        pending_embeds: this.pendingEmbeds.size,
      });

      this.ready = false;
      this.initError = message;
      this.worker = null;

      const failure = new Error(message);
      for (const p of this.pendingEmbeds.values()) p.reject(failure);
      this.pendingEmbeds.clear();
      for (const p of this.pendingBusyWaits.values()) p.resolve();
      this.pendingBusyWaits.clear();

      this.respawnAttempts += 1;
      const backoffMs = Math.min(RESPAWN_BACKOFF_CAP_MS, RESPAWN_BACKOFF_BASE_MS * 2 ** (this.respawnAttempts - 1));
      this.nextRespawnAllowedAt = Date.now() + backoffMs;

      resolveModelStatus();
    };

    worker.on('message', (msg: any) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'model_status') {
        this.ready = !!msg.ok;
        this.initError = msg.error ?? null;
        // The worker process itself came up and answered — whatever the model's own
        // status, the crash-backoff no longer applies to IT.
        this.respawnAttempts = 0;
        this.nextRespawnAllowedAt = 0;
        if (!this.ready) {
          logger.warn('[LocalEmbedding] Model files missing — dense search disabled', { error: this.initError });
        } else {
          logger.info('[LocalEmbedding] all-MiniLM-L6-v2 loaded', { dim: DIM });
        }
        resolveModelStatus();
      } else if (msg.type === 'embed_result') {
        const p = this.pendingEmbeds.get(msg.id);
        if (p) { this.pendingEmbeds.delete(msg.id); p.resolve(msg.vec); }
      } else if (msg.type === 'embed_error') {
        const p = this.pendingEmbeds.get(msg.id);
        if (p) { this.pendingEmbeds.delete(msg.id); p.reject(new Error(msg.error ?? 'embed failed in worker')); }
      } else if (msg.type === 'test_busy_wait_done') {
        const p = this.pendingBusyWaits.get(msg.id);
        if (p) { this.pendingBusyWaits.delete(msg.id); p.resolve(); }
      }
    });
    worker.on('error', (err) => onDeath('error', err instanceof Error ? err.message : String(err)));
    worker.on('exit', (code) => onDeath('exit', `code ${code}`));

    return modelStatusResolved;
  }

  /** Lazy respawn, called from embed() when a previously-spawned worker has died. Backs
   *  off per `nextRespawnAllowedAt` (set in spawnWorker()'s onDeath) rather than retrying
   *  on every single embed() call against a worker that keeps dying immediately — a
   *  caller inside the backoff window just falls through to the plain not-ready error
   *  below, the same as if the model had never loaded. */
  private async maybeRespawn(): Promise<void> {
    if (this.worker) return;
    if (Date.now() < this.nextRespawnAllowedAt) return;
    logger.warn('[LocalEmbedding] respawning embedding worker after it died', { attempt: this.respawnAttempts + 1 });
    await this.spawnWorker();
  }

  async embed(text: string): Promise<Float32Array> {
    if (this.everInitialized && !this.worker) {
      await this.maybeRespawn();
    }
    if (!this.ready || !this.worker) {
      throw new Error('LocalEmbeddingService not ready');
    }

    // See the EMBEDDING CACHE note above: an identical query recomputed a full ONNX
    // inference every time (measured 8.5s / 11.6s / 8.4s for three runs of one string),
    // which is the whole reason the drafter's 8s principle consult was timing out. The
    // cache lives here, on the main thread, so a hit never even reaches the worker.
    const cacheKey = embeddingCacheKey(text);
    const cached = this.embedCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const id = randomUUID();
    const vecArr = await new Promise<number[]>((resolve, reject) => {
      this.pendingEmbeds.set(id, { resolve, reject });
      this.worker!.postMessage({ type: 'embed', id, text });
    });
    const vec = Float32Array.from(vecArr);

    // Cache the FINISHED vector (mean-pooled and L2-normalised), so a hit is byte-for-byte
    // what a miss would have produced.
    this.embedCache.set(cacheKey, vec);
    return vec;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  /**
   * TEST-ONLY. Asks the worker to busy-wait for `ms` on ITS OWN thread and resolves when it
   * replies. Used by tests/embedding-worker-isolation.test.ts to prove that a long
   * synchronous computation routed to the worker does not block the main thread's event
   * loop (the architectural claim this file's header comment makes) — without needing real
   * model files or a timing-sensitive real inference call. Requires init() to have been
   * called (the worker must be spawned; it does not need the model to have loaded, since
   * this never touches the model). Never called from production code.
   */
  async __testBusyWaitInWorker(ms: number): Promise<void> {
    if (!this.worker) {
      throw new Error('LocalEmbeddingService not initialised — call init() first');
    }
    const id = randomUUID();
    await new Promise<void>((resolve) => {
      this.pendingBusyWaits.set(id, { resolve });
      this.worker!.postMessage({ type: 'test_busy_wait', id, ms });
    });
  }
}

/** Singleton local embedding service (all-MiniLM-L6-v2 via ONNX Runtime, run in a worker) */
export const embeddingService = new LocalEmbeddingServiceImpl();
