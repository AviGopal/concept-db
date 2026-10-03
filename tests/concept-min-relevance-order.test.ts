import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { spawn, type Subprocess } from 'bun';

/**
 * A MIN-RELEVANCE CONCEPT SEARCH MUST RETURN THE MOST RELEVANT CONCEPTS, NOT THE LEAST.
 *
 * searchConcepts() without a query term builds
 *   SELECT * FROM concept WHERE org_id = $org_id AND relevance >= $min_relevance
 *   ORDER BY relevance DESC, created_at DESC LIMIT $limit START $offset
 * On SurrealDB 2.3.10 (also 2.4.1 and 2.5.0; 2.3.3 is correct) a range on an indexed field
 * (idx_concept_relevance) combined with ORDER BY that field DESC and LIMIT returns the LOWEST
 * rows of the range: the limit is applied to the ascending index scan before the sort.
 * Measured live on node 1 2026-10-03 (60,068 qualifying): the search returned relevance 0.5
 * where the true top is 0.9958, so recall and prompt-build lessons got the least relevant
 * concepts. Gap: surrealdb-2-3-10-returns-the-lowest-rows-for-an-indexed-range-ordered-desc-with-a-limit.
 *
 * The test calls the REAL searchConcepts against a throwaway in-memory SurrealDB built from the
 * real schema (sql/core/001-concept-tables.surql), and compares with a WITH NOINDEX run of the same
 * filter, which the planner cannot get wrong. Any fix shape passes that returns the same rows
 * (e.g. the filtered rows in a subquery, sorted outside it).
 *
 * Needs the `surreal` binary (present in the substrate image). If it is missing the suite FAILS
 * rather than skipping: a silent skip reads as a pass.
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
    // 400 concepts (SurrealQL ranges exclude the end: 0..400 is 400 values), relevance spread over (0, 1], half of them >= 0.5; plus another org's top rows.
    await sql(`FOR $i IN 0..400 { CREATE concept CONTENT { id: 'c' + <string>$i, pointer: {}, shape: 'x', source_type: 'goal', relevance: <float>($i + 1) / 400.0, org_id: '${ORG}', scope: 'org' } };`);
    await sql(`FOR $i IN 0..20 { CREATE concept CONTENT { id: 'o' + <string>$i, pointer: {}, shape: 'x', source_type: 'goal', relevance: 1.0, org_id: 'organizations:other', scope: 'org' } };`);
    // Stale-relevance upkeep candidates (times_loaded > 10, success rate < 0.3), in their own org.
    await sql(`FOR $i IN 0..30 { CREATE concept CONTENT { id: 'u' + <string>$i, pointer: {}, shape: 'x', source_type: 'goal', relevance: 0.51 + <float>$i / 100.0, times_loaded: 20, times_succeeded: 1, org_id: 'organizations:upkeep', scope: 'org' } };`);
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
    Object.assign(config.surrealdb, { url: URL_, namespace: NS, database: DB, username: 'root', password: PASS });
    await (await import('../src/db/surreal')).surrealDB.close();
    ({ searchConcepts } = await import('../src/resolvers/concept'));
  } catch (e) {
    startError = `cannot spawn surreal: ${e instanceof Error ? e.message : String(e)}`;
    proc?.kill();
  }
}, 120_000);

afterAll(() => { proc?.kill(); });

describe('concept search with min_relevance', () => {
  it('the instrument is live: surreal started, the real schema defined idx_concept_relevance, rows seeded', async () => {
    expect(startError).toBe('');
    const info = await sql('INFO FOR TABLE concept;');
    expect(Object.keys(info[0].result.indexes ?? {})).toContain('idx_concept_relevance');
    const n = await sql(`SELECT count() AS n FROM concept WITH NOINDEX WHERE org_id = '${ORG}' GROUP ALL;`);
    expect(n[0].result[0].n).toBe(400);
  }, 60_000);

  it('CONTROL: the fixture is sensitive to the engine defect where the engine has it', async () => {
    const direct = await sql(`SELECT id, relevance FROM concept WHERE relevance >= 0.5 ORDER BY relevance DESC LIMIT 10;`);
    const scan = await sql(`SELECT id, relevance FROM concept WITH NOINDEX WHERE relevance >= 0.5 ORDER BY relevance DESC LIMIT 10;`);
    const same = JSON.stringify(direct[0].result.map((r: any) => r.id)) === JSON.stringify(scan[0].result.map((r: any) => r.id));
    const [maj, min, pat] = await engineVersion();
    const affected = !(maj === 2 && min === 3 && pat < 8); // measured: 2.3.3 correct; 2.3.10, 2.4.1, 2.5.0 wrong
    expect(same).toBe(!affected);
  }, 60_000);

  it('THE DEFECT: min_relevance returns the most relevant concepts of the org, in order', async () => {
    const got = (await searchConcepts({ min_relevance: 0.5, limit: 10 }, ORG)).map((r: any) => String(r.id));
    expect(got).toEqual(await truth(0.5, 10));
  }, 60_000);

  it('THE DEFECT: a later page with min_relevance is the next slice of the same order', async () => {
    const got = (await searchConcepts({ min_relevance: 0.5, limit: 10, offset: 10 }, ORG)).map((r: any) => String(r.id));
    const all = await truth(0.5, 20);
    expect(got).toEqual(all.slice(10, 20));
  }, 60_000);

  it('without min_relevance the scalar path is already correct and must stay so', async () => {
    const got = (await searchConcepts({ limit: 10 }, ORG)).map((r: any) => String(r.id));
    expect(got).toEqual(await truth(0, 10));
  }, 60_000);

  // The scalar path tries relevance floors 0.9, 0.75, 0.6 before the caller's minimum and accepts a
  // floor only when it fills the page. In this fixture 41 rows are >= 0.9, 101 >= 0.75, 161 >= 0.6.
  it('a page past the high floors falls through to the next floor and is still exact', async () => {
    const got = (await searchConcepts({ min_relevance: 0.5, limit: 10, offset: 100 }, ORG)).map((r: any) => String(r.id));
    const all = await truth(0.5, 110);
    expect(got).toEqual(all.slice(100, 110));
  }, 60_000);

  it('a limit larger than every floor returns the whole qualifying set in order', async () => {
    const got = (await searchConcepts({ min_relevance: 0.5, limit: 300 }, ORG)).map((r: any) => String(r.id));
    const all = await truth(0.5, 300);
    expect(all.length).toBe(201);
    expect(got).toEqual(all);
  }, 60_000);

  it('a minimum above every floor is used directly', async () => {
    const got = (await searchConcepts({ min_relevance: 0.95, limit: 10 }, ORG)).map((r: any) => String(r.id));
    expect(got).toEqual(await truth(0.95, 10));
  }, 60_000);

  it('without min_relevance a deep page falls through to the unfiltered order', async () => {
    const got = (await searchConcepts({ limit: 10, offset: 395 }, ORG)).map((r: any) => String(r.id));
    const all = await truth(0, 405);
    expect(got).toEqual(all.slice(395, 405));
    expect(got.length).toBe(5);
  }, 60_000);

  it('the stale-relevance upkeep candidates are the most relevant stale concepts, not the least', async () => {
    const { getUpkeepActivity } = await import('../src/upkeep/activities');
    const q = getUpkeepActivity('decay-stale-relevance')!.candidateQuery;
    const got = ((await sql(q))[0].result as any[]).map((r) => String(r.id));
    const res = await sql(`SELECT id, relevance FROM concept WITH NOINDEX WHERE times_loaded > 10 AND relevance > 0.5 AND (times_succeeded / times_loaded) < 0.3 ORDER BY relevance DESC LIMIT 10;`);
    const want = (res[0].result as any[]).map((r) => String(r.id));
    expect(want.length).toBe(10);
    expect(got).toEqual(want);
  }, 60_000);

  it('tenant scope holds: another org never appears', async () => {
    const got = await searchConcepts({ min_relevance: 0.9, limit: 50 }, ORG);
    for (const r of got) expect(String(r.org_id)).toBe(ORG);
  }, 60_000);
});
