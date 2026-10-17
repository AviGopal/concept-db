import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { spawn, type Subprocess } from 'bun';

/**
 * A FILTERED DENSE RECALL FINDS A TYPE THAT IS RARE AMONG THE NEAREST NEIGHBOURS.
 *
 * The dense leg ranks the WHOLE table by KNN (top K, K = max(4 x limit, 32)) and applies the tenant and
 * scalar filters afterwards, so a recall filtered to a type that is rare among the global nearest neighbours
 * found no candidate in the top K and returned empty, with no error: 95.8% of dense searches on the live node
 * ended empty. Reproduced on a throwaway 2.3.10 (8,000 rows x 384 dims). The fix widens K by the kept fraction
 * it observes, bounded by the caller's dense deadline. Gap: concept-db-filtered-dense-recall-returns-empty-
 * because-the-filter-is-applied-after-an-unfiltered-global-top-k.
 *
 * The REAL searchConcepts runs against a throwaway in-memory SurrealDB built from every core migration; the
 * term matches nothing lexically, so the dense leg answers. MUST-FAIL at the parent: the rare row is not found.
 * Needs the `surreal` binary; if missing the suite FAILS, never skips.
 *
 * TIME-AWARE (B″). e33916f's loop was reverted (41131b5) because it checked the deadline only BETWEEN passes: a
 * widened pass started late, overran the caller's 2 s race, and the caller discarded the whole leg, pass 1's hits
 * included. The widening now starts a pass only if pass1_ms x (K_N/K_1) + pass1_ms fits the remaining budget, and cuts
 * a started pass one pass1 before the deadline, returning the best-so-far. The (2) tests drive the real recall
 * (denseRecallWith) on the same engine through a query function that adds latency to the KNN statements, and race it
 * exactly as the caller does: they are red under e33916f's semantics (the leg resolves after the caller's timer).
 */

const DIM = 384;
const QUERY = Array.from({ length: DIM }, (_, i) => Math.sin(i + 1));
const nearQuery = (seed: number) => QUERY.map((v, i) => Number((v + 0.05 * Math.sin(seed * 7.3 + i * 1.7)).toFixed(4)));
const farFromQuery = () => QUERY.map((v, i) => Number((-v + 0.3 * Math.cos(i)).toFixed(4)));
let restoreEmbedding: () => void = () => {};

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 19_000 + Math.floor(Math.random() * 900);
const URL_ = `http://127.0.0.1:${PORT}`;
const PASS = crypto.randomUUID();
const NS = 'cdbtest';
const DB = 'learning_loop';
const ORG = 'organizations:o1';
let proc: Subprocess | null = null;
let startError = '';
let searchConcepts: (req: any, orgId: string) => Promise<any[]>;
let savedSurrealConfig: Record<string, unknown> = {};
let restoreSurrealConfig: () => void = () => {};

async function sql(text: string): Promise<any[]> {
  const r = await fetch(`${URL_}/sql`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'surreal-ns': NS, 'surreal-db': DB, Authorization: 'Basic ' + btoa(`root:${PASS}`) },
    body: text,
  });
  return (await r.json()) as any[];
}

async function truth(minRelevance: number, limit: number): Promise<string[]> {
  const res = await sql(`SELECT id, relevance, created_at FROM concept WITH NOINDEX WHERE org_id = '${ORG}' AND relevance >= ${minRelevance} ORDER BY relevance DESC, created_at DESC LIMIT ${limit};`);
  return (res[res.length - 1].result as any[]).map((r) => String(r.id));
}

async function engineVersion(): Promise<[number, number, number]> {
  const m = (await (await fetch(`${URL_}/version`)).text()).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Error('engine version unreadable');
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

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
    // The real schema, every core migration in order (005 defines the embedding fields, 009 the HNSW indexes).
    for (const f of readdirSync(ROOT + 'sql/core').filter((n) => n.endsWith('.surql')).sort()) {
      await sql(readFileSync(ROOT + 'sql/core/' + f, 'utf8'));
    }
    // 400 concepts of a COMMON shape near the query, then 1 of a RARE shape far from it: the rare one is never in the
    // global top K, so a shape-filtered recall finds it only if the leg looks past the first K.
    const rows: string[] = [];
    for (let i = 0; i < 400; i++) rows.push(`{ id: 'c${i}', pointer: {}, shape: 'common', source_type: 'goal', relevance: 0.5, org_id: '${ORG}', content: 'densefixture filler ${i}', summary: 's', content_embedding: ${JSON.stringify(nearQuery(i))}, summary_embedding: ${JSON.stringify(nearQuery(i + 1000))} }`);
    // 2 MID-shape rows AT the query (always in pass 1's top K) and 6 far from it:
    // a mid-filtered recall keeps 2 of a page of 5 in pass 1, so it widens, and pass 1's 2 hits are the best-so-far.
    for (let i = 0; i < 2; i++) rows.push(`{ id: 'mnear${i}', pointer: {}, shape: 'mid', source_type: 'goal', relevance: 0.5, org_id: '${ORG}', content: 'densefixture mid near ${i}', summary: 'm', content_embedding: ${JSON.stringify(QUERY)}, summary_embedding: ${JSON.stringify(QUERY)} }`);
    for (let i = 0; i < 6; i++) rows.push(`{ id: 'mfar${i}', pointer: {}, shape: 'mid', source_type: 'goal', relevance: 0.5, org_id: '${ORG}', content: 'densefixture mid far ${i}', summary: 'm', content_embedding: ${JSON.stringify(farFromQuery())}, summary_embedding: ${JSON.stringify(farFromQuery())} }`);
    for (let i = 0; i < rows.length; i += 50) await sql(`INSERT INTO concept [${rows.slice(i, i + 50).join(',')}];`);
    await sql(`INSERT INTO concept [{ id: 'rare1', pointer: {}, shape: 'rare', source_type: 'goal', relevance: 0.5, org_id: '${ORG}', content: 'densefixture rare', summary: 'r', content_embedding: ${JSON.stringify(farFromQuery())}, summary_embedding: ${JSON.stringify(farFromQuery())} }];`);
    // The query vector is fixed: the ONNX model is not what this test measures. The service's two methods are
    // overridden on the singleton and restored in afterAll (no module mock, so nothing leaks to later files).
    const emb = (await import('../src/services/embedding')).embeddingService as any;
    const saved = { isReady: emb.isReady, embed: emb.embed };
    emb.isReady = () => true;
    emb.embed = async () => Float32Array.from(QUERY);
    restoreEmbedding = () => { emb.isReady = saved.isReady; emb.embed = saved.embed; };
    process.env.SURREALDB_URL = URL_;
    process.env.SURREALDB_NAMESPACE = NS;
    process.env.SURREALDB_DATABASE = DB;
    process.env.SURREALDB_USERNAME = 'root';
    process.env.SURREALDB_PASSWORD = PASS;
    // In a full-suite run another file has already imported src/config (frozen at import from the
    // env of that moment) and possibly connected the shared client, so the env above is not
    // enough: re-point the config object the client reads at connect time and drop any
    // existing connection. Without this the file passes alone and fails in `bun test`.
    const { config } = await import('../src/config');
    savedSurrealConfig = { ...config.surrealdb };
    restoreSurrealConfig = () => Object.assign(config.surrealdb, savedSurrealConfig);
    Object.assign(config.surrealdb, { url: URL_, namespace: NS, database: DB, username: 'root', password: PASS });
    await (await import('../src/db/surreal')).surrealDB.close();
    ({ searchConcepts } = await import('../src/resolvers/concept'));
  } catch (e) {
    startError = `cannot spawn surreal: ${e instanceof Error ? e.message : String(e)}`;
    proc?.kill();
  }
}, 120_000);

afterAll(async () => {
  restoreEmbedding();
  // Hand the shared client back as found, so files that run after this one are not pointed at a dead server.
  await (await import('../src/db/surreal')).surrealDB.close();
  restoreSurrealConfig();
  proc?.kill();
});

describe('the dense leg with a filter the global top K does not satisfy', () => {
  it('the instrument is live: HNSW indexes defined, 409 rows, the rare row is outside the global top 240', async () => {
    expect(startError).toBe('');
    const info = await sql('INFO FOR TABLE concept;');
    expect(Object.keys(info[0].result.indexes ?? {})).toEqual(expect.arrayContaining(['idx_concept_content_hnsw']));
    const top = await sql(`SELECT id FROM concept WHERE content_embedding <|240,480|> ${JSON.stringify(QUERY)};`);
    const ids = (top[0].result as any[]).map((r) => String(r.id));
    expect(ids.length).toBe(240);
    expect(ids).not.toContain('concept:rare1');
  }, 120_000);

  it('[MUST-FAIL] (1) when time allows, a shape-filtered recall for the rare shape returns it', async () => {
    // "When time allows" is a fixture fact, not a load lottery: kept=0 widens 240 -> 14,400 (60x), so the default
    // 2000 ms budget would need pass 1 under ~30 ms on a loaded host. The caller reads this budget per call.
    const saved = process.env.CONCEPT_DENSE_BUDGET_MS;
    process.env.CONCEPT_DENSE_BUDGET_MS = '20000';
    try {
      const got = await searchConcepts({ query: 'zzqqnolexicalmatch', shape: 'rare', limit: 5 }, ORG);
      expect(got.map((r: any) => String(r.id).replace(/^concept:/, ''))).toContain('rare1');
    } finally {
      if (saved === undefined) delete process.env.CONCEPT_DENSE_BUDGET_MS; else process.env.CONCEPT_DENSE_BUDGET_MS = saved;
    }
  }, 120_000);

  // The real recall on the same engine and client, with latency added to the KNN statements, raced like the caller.
  const HYDRATE = `SELECT * OMIT content_embedding, summary_embedding FROM $ids.map(|$i| type::thing("concept", $i)) WHERE true AND org_id = $org_id AND shape = $shape`;
  const kOf = (text: string) => Number(text.match(/<\|(\d+),/)?.[1] ?? 0);
  async function racedLikeTheCaller(delay: (k: number) => Promise<void>, budgetMs: number) {
    const { denseRecallWith } = await import('../src/resolvers/concept');
    const { surrealDB } = await import('../src/db/surreal');
    const { denseLegStats } = await import('../src/services/search-telemetry');
    const query = async <T>(text: string, params: Record<string, unknown>): Promise<T[]> => {
      const k = kOf(text);
      if (k > 0) await delay(k);
      return surrealDB.query<T>(text, params);
    };
    const before = denseLegStats.snapshot();
    const t0 = Date.now();
    const deadline = t0 + budgetMs; // computed before the caller's timer, as searchConcepts does
    const got = await Promise.race([
      denseRecallWith(query, HYDRATE, { org_id: ORG, shape: 'mid', query_vec: QUERY }, 5, deadline),
      new Promise<any[]>((resolve) => setTimeout(() => resolve([]), budgetMs)),
    ]);
    const ids = got.map((r: any) => String(r.id).replace(/^concept:/, ''));
    return { ids, elapsed: Date.now() - t0, before, after: denseLegStats.snapshot() };
  }

  it('[MUST-FAIL] (2a) cost grows with K: the leg widens while it fits, skips the pass that does not, and returns its hits on time', async () => {
    // 100 ms per 32 of K, so a pass costs pass1_ms x (K_N/K_1), as the estimate assumes. Pass 1 keeps fewer mid rows
    // than the page, so K grows each pass until a pass's estimate no longer fits the 900 ms budget, which is skipped.
    // e33916f's loop starts that pass anyway (the deadline has not passed yet) and resolves after the caller's timer.
    const r = await racedLikeTheCaller((k) => Bun.sleep(100 * k / 32), 900);
    expect(r.ids).toEqual(expect.arrayContaining(['mnear0', 'mnear1']));
    expect(r.elapsed).toBeLessThan(900);
    expect(r.after.dense_widen_skipped_budget).toBeGreaterThan(r.before.dense_widen_skipped_budget);
  }, 60_000);

  it('[MUST-FAIL] (2b) a widened pass far slower than its estimate is cut before the deadline, and pass 1\'s hits come back', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    try {
      // pass 1 (K 32) runs at engine speed; every widened pass hangs until released (far past any budget).
      const r = await racedLikeTheCaller((k) => (k > 32 ? held : Promise.resolve()), 900);
      expect(r.ids.length).toBeGreaterThan(0);
      expect(r.ids).toEqual(expect.arrayContaining(['mnear0', 'mnear1']));
      expect(r.elapsed).toBeLessThan(900);
      expect(r.after.dense_widen_cut_deadline).toBeGreaterThan(r.before.dense_widen_cut_deadline);
    } finally {
      release(); // the cut pass then finishes against the live engine; its result is discarded
      await Bun.sleep(200);
    }
  }, 60_000);

  it('(3) control: an unfiltered recall still returns the nearest common rows, never the far one first', async () => {
    const got = await searchConcepts({ query: 'zzqqnolexicalmatch', limit: 5 }, ORG);
    const ids = got.map((r: any) => String(r.id).replace(/^concept:/, ''));
    expect(ids.length).toBeGreaterThan(0);
    expect(ids[0]).not.toBe('rare1');
  }, 120_000);
});
