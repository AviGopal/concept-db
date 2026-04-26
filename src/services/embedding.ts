/**
 * LocalEmbeddingService — all-MiniLM-L6-v2 via onnxruntime-node
 *
 * Loads the ONNX model from disk (EMBEDDING_MODEL_DIR env var, default
 * /app/models/all-MiniLM-L6-v2). Init is async and non-blocking; callers
 * check isReady() and fall back to BM25-only when false.
 *
 * Produces L2-normalised 384-dim Float32Arrays. Cosine similarity over
 * normalised vectors reduces to a dot product.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';

const MODEL_DIR = process.env.EMBEDDING_MODEL_DIR ?? '/app/models/all-MiniLM-L6-v2';
const DIM = 384;
const MAX_SEQ_LEN = 128;

// ---------------------------------------------------------------------------
// Minimal WordPiece tokeniser
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

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class LocalEmbeddingServiceImpl {
  private session: any | null = null;
  private tokenizer = new WordPieceTokenizer();
  private ready = false;
  private initError: string | null = null;

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

  async init(): Promise<void> {
    const modelPath = path.join(MODEL_DIR, 'model.onnx');
    const vocabPath = path.join(MODEL_DIR, 'vocab.txt');

    if (!fs.existsSync(modelPath) || !fs.existsSync(vocabPath)) {
      this.initError = `Model files not found at ${MODEL_DIR}`;
      logger.warn('[LocalEmbedding] Model files missing — dense search disabled', {
        modelPath,
        vocabPath,
      });
      return;
    }

    try {
      const ort = await import('onnxruntime-node');
      this.session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
      });
      this.tokenizer.load(vocabPath);
      this.ready = true;
      logger.info('[LocalEmbedding] all-MiniLM-L6-v2 loaded', { dim: DIM, modelPath });
    } catch (err) {
      this.initError = err instanceof Error ? err.message : String(err);
      logger.error('[LocalEmbedding] Failed to load ONNX model', { error: this.initError });
    }
  }

  async embed(text: string): Promise<Float32Array> {
    if (!this.ready || !this.session) {
      throw new Error('LocalEmbeddingService not ready');
    }

    const ort = await import('onnxruntime-node');
    const { input_ids, attention_mask, token_type_ids } = this.tokenizer.encode(text);
    const shape = [1, MAX_SEQ_LEN];

    const feeds: Record<string, any> = {
      input_ids: new ort.Tensor('int64', input_ids, shape),
      attention_mask: new ort.Tensor('int64', attention_mask, shape),
      token_type_ids: new ort.Tensor('int64', token_type_ids, shape),
    };

    const output = await this.session.run(feeds);
    const hiddenState: Float32Array = output['last_hidden_state']?.data as Float32Array;
    if (!hiddenState) {
      throw new Error('Unexpected ONNX output — missing last_hidden_state');
    }

    // Mean-pool over non-padded token positions
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

    // L2 normalise
    let norm = 0;
    for (let d = 0; d < DIM; d++) norm += vec[d] * vec[d];
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let d = 0; d < DIM; d++) vec[d] /= norm;
    }

    return vec;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

/** Singleton local embedding service (all-MiniLM-L6-v2 via ONNX Runtime) */
export const embeddingService = new LocalEmbeddingServiceImpl();
