import { describe, it, expect, beforeAll, afterAll, beforeEach, spyOn } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { spawn, type Subprocess } from 'bun';

/**
 * A SHAPE-DESCRIPTION RECALL SCORES EVERY DESCRIBED SHAPE EXACTLY, SO A RARE TYPE IS NEVER POST-FILTERED AWAY
 * (user ruling via qa, 2026-10-17 ~20:11Z).
 *
 * Live 2026-10-17: ~62% of goal-host shape recalls on both nodes returned no candidate. The dense leg ranks the WHOLE
 * table by KNN and filters afterwards, and shape_description rows are rare among the nearest neighbours, so the
 * post-filter kept none; B''s widening was skipped for budget on every such search (1487/1487). A generic lexical hit
 * also skipped the dense leg entirely. For shape = SHAPE_CONCEPT_SHAPE only, the dense leg now scores the filtered
 * subset exactly (same tenant/trust/scalar filter), runs even when lexical matched, and is RRF-merged with lexical.
 *
 * The REAL searchConcepts runs against a throwaway in-memory SurrealDB 2.3.10 built from every core migration. The
 * shared client's `query` is spied onto that engine over HTTP (realQuery, the shape-index-query-parses pattern), NOT
 * re-pointed and reconnected: in pull-sync's whole-suite file order earlier files leave the `surrealdb` driver
 * module-mocked, so a reconnected client never reaches this engine (every search returned [] in ~1 ms). Every case
 * first proves the wiring (INSTRUMENT: a sentinel row only this engine holds comes back through searchConcepts), so a
 * bleed reads as "not wired", never as a product failure; [CONTROL wire] shows that check is red when the seam points
 * at a dead engine. The query embedding is a fixed synthetic
 * vector per query text (the ONNX model is not what this measures). The fixture is shrunk (500 others, 40 described
 * shapes; the ruling asked ~2,000/~100) to fit the 30 s in-container runner: 500 others all nearer the query than the
 * target is more than the 240 of pass 1, which is what matters. MF1 pins CONCEPT_DENSE_BUDGET_MS to 100 ms: the
 * live state, a budget no widening fits; at the tip the exact path is not
 * raced against that budget at all (as ruled), so the same pin also shows the budget no longer governs this shape.
 * MUST-FAIL at the parent (d69d8467): MF1, MF2 (and HELD-OUT P3, which asserts the new path's counter). Needs the `surreal` binary; if missing the suite FAILS, never skips.
 */

const DIM = 384;
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = (seed: number) => { const r = rng(seed); return Array.from({ length: DIM }, () => r() * 2 - 1); };
const around = (base: number[], seed: number, eps: number) => { const n = rand(seed); return base.map((v, i) => Number((v + eps * n[i]!).toFixed(3))); };
const Q1 = rand(1).map((v) => Number(v.toFixed(3)));
const Q3 = rand(3).map((v) => Number(v.toFixed(3)));
const Q4 = rand(4).map((v) => Number(v.toFixed(3)));
const QUERY_VEC: Record<string, number[]> = {
  zqmfone: Q1, glorpgeneric: Q1, zqnolexb: Q1, plinkcontrol: Q1, zqprivthree: Q3, zqtrustfour: Q4,
};

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 19_000 + Math.floor(Math.random() * 900);
const URL_ = `http://127.0.0.1:${PORT}`;
const PASS = crypto.randomUUID();
const NS = 'cdbtest';
const DB = 'learning_loop';
const ORG_A = 'organizations:o1';
const ORG_B = 'organizations:o2';
const SYS = 'organizations:substrate';
const OTHERS = 500;
const DESCRIBED = 40;
let proc: Subprocess | null = null;
let startError = '';
let searchConcepts: (req: any, orgId: string) => Promise<any[]>;
let SHAPE = '';
let restoreEmbedding: () => void = () => {};
let restoreApiKey: () => void = () => {};
let restoreQuery: () => void = () => {};
let target = '';
let embedCalls = 0;

async function sql(text: string): Promise<any[]> {
  const r = await fetch(`${URL_}/sql`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'surreal-ns': NS, 'surreal-db': DB, Authorization: 'Basic ' + btoa(`root:${PASS}`) },
    body: text,
  });
  return (await r.json()) as any[];
}
/** The engine the shared client's `query` is routed to (params bound with LET; record ids bound bare, as
 *  type::thing("concept", $i) expects). Throws on a failed statement, as the driver does. */
async function realQuery(text: string, params: Record<string, unknown> = {}): Promise<unknown[]> {
  const lets = Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => {
    const val = k === 'ids' && Array.isArray(v) ? v.map((i) => String(i).replace(/^concept:/, '')) : v;
    return `LET $${k} = ${JSON.stringify(val)};`;
  }).join(' ');
  const r = await fetch(`${target}/sql`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'surreal-ns': NS, 'surreal-db': DB, Authorization: 'Basic ' + btoa(`root:${PASS}`) },
    body: `${lets} ${text};`,
  });
  const res = (await r.json()) as any[];
  const last = res[res.length - 1];
  if (last?.status !== 'OK') throw new Error(String(last?.result ?? 'query failed'));
  return last.result as unknown[];
}
/** INSTRUMENT: true iff searchConcepts reaches THIS engine (the sentinel row exists nowhere else). */
async function wired(): Promise<boolean> {
  try { return bare(await searchConcepts({ query: 'wiresentinel', limit: 5 }, ORG_A)).includes('wire1'); } catch { return false; }
}
async function expectWired(): Promise<void> {
  expect(startError).toBe('');
  if (!(await wired())) throw new Error('INSTRUMENT: not wired — searchConcepts does not reach this file\'s engine (module state from an earlier file); no product verdict is possible');
}
const bare = (got: any[]) => got.map((r: any) => String(r.id).replace(/^concept:/, ''));
const row = (id: string, shape: string, org: string, content: string, vec: number[], extra = '') =>
  `{ id: '${id}', pointer: {}, shape: '${shape}', source_type: '${shape}', relevance: 0.5, org_id: '${org}', content: '${content}', summary: 's', content_embedding: ${JSON.stringify(vec)}, summary_embedding: ${JSON.stringify(vec)}${extra} }`;
const shared = ", scope: 'global', public: true";

async function stats() { return (await import('../src/services/search-telemetry')).denseLegStats.snapshot(); }

beforeAll(async () => {
  const hardStop = setTimeout(() => proc?.kill(), 180_000);
  (hardStop as any).unref?.();
  try {
    proc = spawn(['surreal', 'start', 'memory', '--bind', `127.0.0.1:${PORT}`, '--user', 'root', '--pass', PASS, '--log', 'none'], { stdout: 'ignore', stderr: 'ignore' });
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try { up = (await fetch(`${URL_}/health`)).ok; } catch { /* not up yet */ }
      if (!up) await Bun.sleep(100);
    }
    if (!up) throw new Error('surreal did not answer /health within 6 s');
    for (const f of readdirSync(ROOT + 'sql/core').filter((n) => n.endsWith('.surql')).sort()) {
      await sql(readFileSync(ROOT + 'sql/core/' + f, 'utf8'));
    }
    ({ SHAPE_CONCEPT_SHAPE: SHAPE } = await import('../src/upkeep/shape-index'));
    const rows: string[] = [];
    // OTHERS concepts of the caller's org clustered tightly around Q1: the whole global top K for Q1.
    for (let i = 0; i < OTHERS; i++) rows.push(row(`c${i}`, 'common', ORG_A, i < 3 ? 'plinkcontrol '.repeat(3 - i) + 'x'.repeat(i) : `filler ${i}`, around(Q1, 1000 + i, 0.1)));
    // The shape index as the indexer writes it (system org, scope global, public): the TARGET is the described shape
    // nearest Q1 but far outside the global top K; the rest are unrelated directions.
    rows.push(row('sd_target', SHAPE, SYS, 'targetshape: the shape the goal needs', around(Q1, 50, 0.6), shared));
    rows.push(row('sd_generic', SHAPE, SYS, 'genericshape: a glorpgeneric description', rand(60), shared));
    for (let j = 0; j < DESCRIBED - 2; j++) rows.push(row(`sd_${j}`, SHAPE, SYS, `shape${j}: description`, rand(200 + j), shared));
    // isolation: the caller org's PRIVATE described shape at Q3; trust: untrusted writers' global rows and a retired
    // system row AT Q4, the trusted system row near it.
    rows.push(row('sd_a_private', SHAPE, ORG_A, 'privshape: private', Q3, ", scope: 'org', public: false"));
    rows.push(row('sd_default', SHAPE, 'default', 'defshape: unauthenticated', Q4, shared));
    rows.push(row('sd_o3', SHAPE, 'organizations:o3', 'othershape: other tenant', Q4, shared));
    rows.push(row('sd_retired', SHAPE, SYS, 'retiredshape: retired', Q4, ", scope: 'global', public: false"));
    rows.push(row('sd_sys4', SHAPE, SYS, 'sysshape: trusted', around(Q4, 70, 0.3), shared));
    rows.push(row('rare1', 'rare', ORG_A, 'rare one', rand(80)));
    rows.push(row('wire1', 'common', ORG_A, 'wiresentinel', rand(90)));
    for (let i = 0; i < rows.length; i += 40) {
      const r = await sql(`INSERT INTO concept [${rows.slice(i, i + 40).join(',')}];`);
      if (r[r.length - 1]?.status !== 'OK') throw new Error(`insert failed: ${JSON.stringify(r).slice(0, 300)}`);
    }
    const emb = (await import('../src/services/embedding')).embeddingService as any;
    const saved = { isReady: emb.isReady, embed: emb.embed };
    emb.isReady = () => true;
    emb.embed = async (text: string) => {
      const v = QUERY_VEC[text.trim()];
      if (!v) throw new Error(`no fixture vector for query ${text}`);
      embedCalls++;
      return Float32Array.from(v);
    };
    restoreEmbedding = () => { emb.isReady = saved.isReady; emb.embed = saved.embed; };
    const { config } = await import('../src/config');
    const savedKey = config.metabob.apiKey;
    restoreApiKey = () => { (config.metabob as any).apiKey = savedKey; };
    target = URL_;
    const { surrealDB } = await import('../src/db/surreal');
    const spy = spyOn(surrealDB, 'query').mockImplementation(((text: string, params?: Record<string, unknown>) => realQuery(text, params ?? {})) as never);
    restoreQuery = () => spy.mockRestore();
    // The shared scope trusts the validated system org (b412f7d); primed through the validator seam.
    const so = await import('../src/services/system-org');
    so.resetSystemOrgCache();
    expect(await so.systemOrgId(async () => ({ orgId: SYS }), 'own-key')).toBe(SYS);
    ({ searchConcepts } = await import('../src/resolvers/concept'));
  } catch (e) {
    startError = `setup: ${e instanceof Error ? e.message : String(e)}`;
    proc?.kill();
  }
}, 120_000);

afterAll(async () => {
  restoreEmbedding();
  restoreApiKey();
  (await import('../src/services/system-org')).resetSystemOrgCache();
  restoreQuery();
  proc?.kill();
});

beforeEach(async () => { await expectWired(); });

async function withBudget<T>(ms: string, f: () => Promise<T>): Promise<T> {
  const saved = process.env.CONCEPT_DENSE_BUDGET_MS;
  process.env.CONCEPT_DENSE_BUDGET_MS = ms;
  try { return await f(); } finally {
    if (saved === undefined) delete process.env.CONCEPT_DENSE_BUDGET_MS; else process.env.CONCEPT_DENSE_BUDGET_MS = saved;
  }
}

describe('a shape-description recall on the real engine', () => {
  it('[CONTROL wire] the INSTRUMENT discriminates: with the seam on a dead engine it reports not wired', async () => {
    expect(await wired()).toBe(true);
    target = 'http://127.0.0.1:9'; // nothing listens there
    try { expect(await wired()).toBe(false); } finally { target = URL_; }
    expect(await wired()).toBe(true);
  }, 60_000);

  it('the instrument is live: HNSW indexes, the fixture rows, the target outside the global top 240', async () => {
    expect(startError).toBe('');
    const info = await sql('INFO FOR TABLE concept;');
    expect(Object.keys(info[0].result.indexes ?? {})).toEqual(expect.arrayContaining(['idx_concept_content_hnsw']));
    const n = await sql(`SELECT count() AS n FROM concept WHERE shape = '${SHAPE}' GROUP ALL;`);
    expect(n[0].result[0].n).toBe(DESCRIBED + 5);
    const top = await sql(`SELECT id FROM concept WHERE content_embedding <|240,480|> ${JSON.stringify(Q1)};`);
    const ids = (top[0].result as any[]).map((r) => String(r.id));
    expect(ids.length).toBe(240);
    expect(ids.some((i) => i.includes('sd_'))).toBe(false);
  }, 60_000);

  it('[MUST-FAIL] (MF1) a query nearest one described shape returns it, under the live budget pressure', async () => {
    const before = await stats();
    const got = await withBudget('100', () => searchConcepts({ query: 'zqmfone', shape: SHAPE, include_global: true, limit: 5 }, ORG_A));
    expect(embedCalls).toBeGreaterThan(0); // the fixture query vector reached the leg (not another file's embedder)
    expect(bare(got)[0]).toBe('sd_target');
    expect((await stats()).dense_exact_shape_searches).toBe(before.dense_exact_shape_searches + 1);
  }, 60_000);

  it('[MUST-FAIL] (MF2) ALWAYS-RUN: a lexical match on a generic term still returns the exact-scored candidate, merged', async () => {
    const got = await searchConcepts({ query: 'glorpgeneric', shape: SHAPE, include_global: true, limit: 5 }, ORG_A);
    expect(bare(got)).toEqual(expect.arrayContaining(['sd_generic', 'sd_target']));
  }, 60_000);

  it('[CONTROL a] a non-shape search returns what the lexical path returns (same ids/order); the exact path is not taken', async () => {
    const before = await stats();
    const got = await searchConcepts({ query: 'plinkcontrol', limit: 5 }, ORG_A);
    expect(bare(got)).toEqual(['c0', 'c1', 'c2']);
    expect((await stats()).dense_exact_shape_searches).toBe(before.dense_exact_shape_searches);
  }, 60_000);

  it('[CONTROL b] a search filtered to ANOTHER shape still takes the KNN path', async () => {
    const before = await stats();
    await withBudget('20000', () => searchConcepts({ query: 'zqnolexb', shape: 'rare', limit: 5 }, ORG_A));
    const after = await stats();
    expect(after.dense_exact_shape_searches).toBe(before.dense_exact_shape_searches);
    expect(after.searches).toBe(before.searches + 1);
  }, 60_000);

  it('[CONTROL c] isolation: another org sees none of the caller org rows; without include_global it sees nothing', async () => {
    expect(bare(await searchConcepts({ query: 'zqmfone', shape: SHAPE, limit: 5 }, ORG_B))).toEqual([]);
    const own = bare(await searchConcepts({ query: 'zqprivthree', shape: SHAPE, include_global: true, limit: 5 }, ORG_A));
    expect(own[0]).toBe('sd_a_private');
    const other = bare(await searchConcepts({ query: 'zqprivthree', shape: SHAPE, include_global: true, limit: 5 }, ORG_B));
    expect(other.length).toBeGreaterThan(0); // the shared index is visible to every org
    expect(other).not.toContain('sd_a_private');
  }, 60_000);

  it('[HELD-OUT P3] isolation ON THE EXACT PATH: a different org, system-org described shapes, no include_global -> []', async () => {
    // Red at the parent only because the exact path (and its counter) does not exist there.
    const b0 = await stats();
    expect(bare(await searchConcepts({ query: 'zqmfone', shape: SHAPE, limit: 5 }, ORG_B))).toEqual([]);
    const b1 = await stats();
    expect(b1.dense_exact_shape_searches).toBe(b0.dense_exact_shape_searches + 1);
    expect(b1.dense_exact_shape_empty).toBe(b0.dense_exact_shape_empty + 1);
  }, 60_000);

  it('[CONTROL d] the shared scope trusts only the validated system org; fail closed without one', async () => {
    const got = bare(await searchConcepts({ query: 'zqtrustfour', shape: SHAPE, include_global: true, limit: 5 }, ORG_A));
    expect(got[0]).toBe('sd_sys4');
    for (const untrusted of ['sd_default', 'sd_o3', 'sd_retired']) expect(got).not.toContain(untrusted);
    const so = await import('../src/services/system-org');
    const { config } = await import('../src/config');
    so.resetSystemOrgCache();
    (config.metabob as any).apiKey = '';
    try {
      const closed = bare(await searchConcepts({ query: 'zqtrustfour', shape: SHAPE, include_global: true, limit: 5 }, ORG_A));
      expect(closed).toEqual(['sd_a_private']); // the caller's own row only; no global row at all
    } finally {
      restoreApiKey();
      so.resetSystemOrgCache();
      await so.systemOrgId(async () => ({ orgId: SYS }), 'own-key');
    }
  }, 60_000);
});
