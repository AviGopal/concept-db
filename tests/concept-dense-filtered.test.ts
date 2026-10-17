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
  it('the instrument is live: HNSW indexes defined, 401 rows, the rare row is outside the global top 240', async () => {
    expect(startError).toBe('');
    const info = await sql('INFO FOR TABLE concept;');
    expect(Object.keys(info[0].result.indexes ?? {})).toEqual(expect.arrayContaining(['idx_concept_content_hnsw']));
    const top = await sql(`SELECT id FROM concept WHERE content_embedding <|240,480|> ${JSON.stringify(QUERY)};`);
    const ids = (top[0].result as any[]).map((r) => String(r.id));
    expect(ids.length).toBe(240);
    expect(ids).not.toContain('concept:rare1');
  }, 120_000);

  it('MUST-FAIL: a shape-filtered recall for the rare shape returns it', async () => {
    const got = await searchConcepts({ query: 'zzqqnolexicalmatch', shape: 'rare', limit: 5 }, ORG);
    expect(got.map((r: any) => String(r.id).replace(/^concept:/, ''))).toContain('rare1');
  }, 120_000);

  it('control: an unfiltered recall still returns the nearest common rows, never the far one first', async () => {
    const got = await searchConcepts({ query: 'zzqqnolexicalmatch', limit: 5 }, ORG);
    const ids = got.map((r: any) => String(r.id).replace(/^concept:/, ''));
    expect(ids.length).toBeGreaterThan(0);
    expect(ids[0]).not.toBe('rare1');
  }, 120_000);
});
