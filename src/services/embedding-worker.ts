/**
 * embedding-worker — runs all-MiniLM-L6-v2 ONNX inference off the main thread.
 *
 * WHY A WORKER. `embed()` used to call `session.run()` in the same process/thread that
 * serves HTTP requests. Measured live (2026-09-03): a single uncached embed call took
 * 8.5-11.6s, and while it ran, nothing else in the process made progress — including the
 * `setTimeout` that `searchConcepts`'s `DENSE_BUDGET_MS` race depends on to bound the dense
 * leg at 2s. A budget enforced by a timer cannot fire while the same thread is busy running
 * the computation the timer is meant to bound. Moving the ONNX call into a worker thread
 * means the computation can run as long as it needs to without blocking the main thread's
 * event loop, so the EXISTING race (unchanged) actually resolves at ~DENSE_BUDGET_MS instead
 * of at the embed's own duration.
 *
 * PROTOCOL (structured-clone messages over the worker's MessagePort):
 *   main -> worker  {type:'embed', id, text}
 *   worker -> main  {type:'embed_result', id, vec:number[]} | {type:'embed_error', id, error}
 *   worker -> main  {type:'model_status', ok, error?}            (sent once, after model load attempts)
 *   main -> worker  {type:'test_busy_wait', id, ms}               (test-only; see below)
 *   worker -> main  {type:'test_busy_wait_done', id}
 *
 * The tokenizer, the ONNX session, and the mean-pool + L2-normalise maths are the SAME code
 * that used to run on the main thread — moved verbatim, not rewritten — so a given text
 * still produces the bit-identical vector it always did; only WHERE it runs changed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parentPort } from 'node:worker_threads';

const MODEL_DIR = process.env.EMBEDDING_MODEL_DIR ?? '/app/models/all-MiniLM-L6-v2';
const DIM = 384;
const MAX_SEQ_LEN = 128;

// ---------------------------------------------------------------------------
// Minimal WordPiece tokeniser — moved verbatim from the main-thread service.
// ---------------------------------------------------------------------------

class WordPieceTokenizer {
  private vocab = new Map<string, number>();
  private unkId = 100;
  private clsId = 101;
  private sepId = 102;
  private padId = 0;

  load(vocabPath: string): void {
    const lines = fs.readFileSync(vocabPath, 'utf-8').split('\n');
    lines.forEach((token, idx) => {
      const t = token.trim();
      if (t) this.vocab.set(t, idx);
    });
    this.unkId = this.vocab.get('[UNK]') ?? 100;
    this.clsId = this.vocab.get('[CLS]') ?? 101;
    this.sepId = this.vocab.get('[SEP]') ?? 102;
    this.padId = this.vocab.get('[PAD]') ?? 0;
  }

  encode(text: string): {
    input_ids: BigInt64Array;
    attention_mask: BigInt64Array;
    token_type_ids: BigInt64Array;
  } {
    const tokens = this.tokenize(text);
    const ids: number[] = [this.clsId];
    for (const tok of tokens) {
      if (ids.length >= MAX_SEQ_LEN - 1) break;
      ids.push(this.vocab.get(tok) ?? this.unkId);
    }
    ids.push(this.sepId);

    const seqLen = ids.length;
    const input_ids = new BigInt64Array(MAX_SEQ_LEN).fill(BigInt(this.padId));
    const attention_mask = new BigInt64Array(MAX_SEQ_LEN).fill(BigInt(0));
    const token_type_ids = new BigInt64Array(MAX_SEQ_LEN).fill(BigInt(0));

    for (let i = 0; i < seqLen; i++) {
      input_ids[i] = BigInt(ids[i]);
      attention_mask[i] = BigInt(1);
    }

    return { input_ids, attention_mask, token_type_ids };
  }

  private tokenize(text: string): string[] {
    const words = text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' $& ')
      .split(/\s+/)
      .filter(Boolean);
    const result: string[] = [];
    for (const word of words) {
      result.push(...this.wordPiece(word));
    }
    return result;
  }

  private wordPiece(word: string): string[] {
    if (this.vocab.has(word)) return [word];
    const chars = [...word];
    if (chars.length === 1) return [word];

    const tokens: string[] = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length;
      let found = '';
      while (end > start) {
        const substr = chars.slice(start, end).join('');
        const candidate = start === 0 ? substr : `##${substr}`;
        if (this.vocab.has(candidate)) {
          found = candidate;
          break;
        }
        end--;
      }
      if (!found) {
        tokens.push('[UNK]');
        start++;
      } else {
        tokens.push(found);
        start = end;
      }
    }
    return tokens;
  }
}

const tokenizer = new WordPieceTokenizer();
let session: any | null = null;
let modelError: string | null = null;

async function loadModel(): Promise<void> {
  const modelPath = path.join(MODEL_DIR, 'model.onnx');
  const vocabPath = path.join(MODEL_DIR, 'vocab.txt');

  if (!fs.existsSync(modelPath) || !fs.existsSync(vocabPath)) {
    modelError = `Model files not found at ${MODEL_DIR}`;
    return;
  }

  try {
    const ort = await import('onnxruntime-node');
    session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    });
    tokenizer.load(vocabPath);
  } catch (err) {
    modelError = err instanceof Error ? err.message : String(err);
    session = null;
  }
}

/** Mean-pool over non-padded positions, then L2-normalise. Moved verbatim. */
async function runEmbed(text: string): Promise<number[]> {
  if (!session) throw new Error('LocalEmbeddingService not ready');
  const ort = await import('onnxruntime-node');
  const { input_ids, attention_mask, token_type_ids } = tokenizer.encode(text);
  const shape = [1, MAX_SEQ_LEN];

  const feeds: Record<string, any> = {
    input_ids: new ort.Tensor('int64', input_ids, shape),
    attention_mask: new ort.Tensor('int64', attention_mask, shape),
    token_type_ids: new ort.Tensor('int64', token_type_ids, shape),
  };

  const output = await session.run(feeds);
  const hiddenState: Float32Array = output['last_hidden_state']?.data as Float32Array;
  if (!hiddenState) {
    throw new Error('Unexpected ONNX output — missing last_hidden_state');
  }

  const vec = new Float32Array(DIM);
  let tokenCount = 0;
  for (let t = 0; t < MAX_SEQ_LEN; t++) {
    if (attention_mask[t] === BigInt(0)) continue;
    tokenCount++;
    for (let d = 0; d < DIM; d++) {
      vec[d] += hiddenState[t * DIM + d];
    }
  }
  if (tokenCount > 0) {
    for (let d = 0; d < DIM; d++) vec[d] /= tokenCount;
  }

  let norm = 0;
  for (let d = 0; d < DIM; d++) norm += vec[d] * vec[d];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let d = 0; d < DIM; d++) vec[d] /= norm;
  }

  return Array.from(vec);
}

/**
 * TEST-ONLY. A synchronous busy-wait, run inside THIS worker thread, that never touches
 * the model. It exists only so a test can prove the architectural claim this file makes —
 * that a long synchronous computation routed here does not block the main thread's event
 * loop — without needing real model files or a timing-sensitive real inference call to be
 * slow enough to observe. It is inert in production: nothing on the main side calls it
 * except the test in tests/embedding-worker-isolation.test.ts.
 */
function testBusyWait(ms: number): void {
  const until = Date.now() + ms;
  // eslint-disable-next-line no-empty
  while (Date.now() < until) { /* spin: deliberately occupies this thread, nothing else */ }
}

if (parentPort) {
  const port = parentPort;
  loadModel().then(
    () => port.postMessage({ type: 'model_status', ok: session !== null, error: modelError ?? undefined }),
    (err) => port.postMessage({ type: 'model_status', ok: false, error: err instanceof Error ? err.message : String(err) }),
  );

  port.on('message', (msg: any) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'embed') {
      runEmbed(msg.text).then(
        (vec) => port.postMessage({ type: 'embed_result', id: msg.id, vec }),
        (err) => port.postMessage({ type: 'embed_error', id: msg.id, error: err instanceof Error ? err.message : String(err) }),
      );
    } else if (msg.type === 'test_busy_wait') {
      testBusyWait(typeof msg.ms === 'number' ? msg.ms : 0);
      port.postMessage({ type: 'test_busy_wait_done', id: msg.id });
    }
  });
}
