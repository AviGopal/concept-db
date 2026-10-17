import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { spawn, type Subprocess } from 'bun';

/**
 * THE LEXICAL (BM25) LEG RETURNS THE TENANT'S MATCHING CONCEPTS.
 *
 * From the 2026-09-02 two-stage rewrite the lexical leg returned [] for every term, silently:
 * stage 2 re-applied `content @0@ 'term'` and search::score(0) over a record-id list, and on
 * SurrealDB 2.3.10 a match operator over a record-id list (no full-text index iterated)
 * evaluates false. Measured on the live node from the 10-10 boot: 0 lexical matches, 0 errors,
 * and no /health field, so every recall was dense-only. Reproduced on an in-memory 2.3.10 with
 * migration 004 (2026-10-17). Gap: concept-db-lexical-search-returns-nothing-because-its-second-
 * stage-re-matches-full-text-over-a-record-id-list.
 *
 * The test calls the REAL searchConcepts against a throwaway in-memory SurrealDB built from the
 * real schema (001) and the real full-text migration (004). MUST-FAIL at the parent: the search
 * returns no lexical match. Needs the `surreal` binary; if missing the suite FAILS, never skips.
 */

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
    await sql(readFileSync(ROOT + 'sql/core/001-concept-tables.surql', 'utf8'));
    await sql(readFileSync(ROOT + 'sql/core/004-bm25-search.surql', 'utf8'));
    // Three of this org's concepts carry the term (one twice, so it scores highest); one does not; another org's carries it too.
    await sql(`CREATE concept CONTENT { id: 'm1', pointer: {}, shape: 'x', source_type: 'goal', relevance: 0.5, org_id: '${ORG}', content: 'lexfixture lexfixture walk step', summary: 's1' };`);
    await sql(`CREATE concept CONTENT { id: 'm2', pointer: {}, shape: 'x', source_type: 'goal', relevance: 0.5, org_id: '${ORG}', content: 'a lexfixture in a longer sentence about other things entirely here', summary: 's2' };`);
    await sql(`CREATE concept CONTENT { id: 'm3', pointer: {}, shape: 'y', source_type: 'goal', relevance: 0.5, org_id: '${ORG}', content: 'unrelated text', summary: 'lexfixture digest' };`);
    await sql(`CREATE concept CONTENT { id: 'n1', pointer: {}, shape: 'x', source_type: 'goal', relevance: 0.5, org_id: '${ORG}', content: 'nothing to see', summary: 'none' };`);
    await sql(`CREATE concept CONTENT { id: 'o1', pointer: {}, shape: 'x', source_type: 'goal', relevance: 0.9, org_id: 'organizations:other', scope: 'org', content: 'lexfixture from another tenant', summary: 'other' };`);
    // The trusted shared scope: a global public concept written by the system org, and another org's private one, both matching.
    await sql(`CREATE concept CONTENT { id: 'g1', pointer: {}, shape: 'x', source_type: 'goal', relevance: 0.9, org_id: 'organizations:sys', scope: 'global', public: true, content: 'lexfixture shared vocabulary', summary: 'shared' };`);
    await sql(`CREATE concept CONTENT { id: 'p1', pointer: {}, shape: 'x', source_type: 'goal', relevance: 0.9, org_id: 'organizations:other', scope: 'org', public: false, content: 'lexfixture private to another tenant', summary: 'private' };`);
    // Prime the trusted system org as identity would validate it (the module's own test seam; reset in afterAll).
    const so = await import('../src/services/system-org');
    so.resetSystemOrgCache();
    await so.systemOrgId(async () => ({ orgId: 'organizations:sys' }), 'test-key');
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
  (await import('../src/services/system-org')).resetSystemOrgCache();
  // Hand the shared client back as found, so files that run after this one are not pointed at a dead server.
  await (await import('../src/db/surreal')).surrealDB.close();
  restoreSurrealConfig();
  proc?.kill();
});

describe('the lexical leg (BM25) of concept search', () => {
  it('the instrument is live: surreal started, migration 004 defined the full-text indexes, rows seeded', async () => {
    expect(startError).toBe('');
    const info = await sql('INFO FOR TABLE concept;');
    expect(Object.keys(info[0].result.indexes ?? {})).toEqual(expect.arrayContaining(['idx_concept_content_fts', 'idx_concept_summary_fts']));
    const direct = await sql(`SELECT id FROM concept WHERE content @0@ 'lexfixture';`);
    expect(direct[0].result.length).toBe(5); // m1, m2, the other tenant's o1 and p1, the shared g1: the index itself matches
  }, 60_000);

  it('MUST-FAIL: a term this tenant\'s concepts carry returns them, best match first, scored', async () => {
    const got = await searchConcepts({ query: 'lexfixture', limit: 10 }, ORG);
    const ids = got.map((r: any) => String(r.id).replace(/^concept:/, ''));
    expect(ids).toEqual(expect.arrayContaining(['m1', 'm2', 'm3']));
    expect(ids).not.toContain('n1');
  }, 60_000);

  it('tenant isolation holds: another org\'s matching concept is never returned', async () => {
    const got = await searchConcepts({ query: 'lexfixture', limit: 10 }, ORG);
    expect(got.map((r: any) => String(r.id).replace(/^concept:/, ''))).not.toContain('o1');
  }, 60_000);

  it('MUST-FAIL: with include_global, the tenant\'s rows AND the trusted shared concept come back; another tenant\'s private row never does', async () => {
    const got = await searchConcepts({ query: 'lexfixture', include_global: true, limit: 10 }, ORG);
    const ids = got.map((r: any) => String(r.id).replace(/^concept:/, ''));
    expect(ids).toEqual(expect.arrayContaining(['m1', 'g1']));
    expect(ids).not.toContain('p1');
    expect(ids).not.toContain('o1');
  }, 60_000);

  it('a scalar filter still applies in the hydrate (shape)', async () => {
    const got = await searchConcepts({ query: 'lexfixture', shape: 'y', limit: 10 }, ORG);
    expect(got.map((r: any) => String(r.id).replace(/^concept:/, ''))).toEqual(['m3']);
  }, 60_000);

  it('the leg is visible: /health lexical counters count the search as a hit', async () => {
    const t = (await import('../src/services/search-telemetry')) as { lexicalLegStats?: { snapshot(): { lexical_searches: number; lexical_hits: number } } };
    expect(t.lexicalLegStats).toBeDefined();
    const before = t.lexicalLegStats!.snapshot();
    await searchConcepts({ query: 'lexfixture', limit: 10 }, ORG);
    const after = t.lexicalLegStats!.snapshot();
    expect(after.lexical_searches).toBe(before.lexical_searches + 1);
    expect(after.lexical_hits).toBe(before.lexical_hits + 1);
  }, 60_000);

  it('control: a term nothing carries is counted empty, not as a hit', async () => {
    const t = (await import('../src/services/search-telemetry')) as { lexicalLegStats?: { snapshot(): { lexical_empty: number } } };
    expect(t.lexicalLegStats).toBeDefined();
    const before = t.lexicalLegStats!.snapshot().lexical_empty;
    await searchConcepts({ query: 'zzqqxxnomatch', limit: 5 }, ORG);
    expect(t.lexicalLegStats!.snapshot().lexical_empty).toBe(before + 1);
  }, 60_000);
});
