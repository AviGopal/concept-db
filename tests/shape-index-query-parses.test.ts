import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { spawn, type Subprocess } from 'bun';

/**
 * THE SHAPE INDEXER RUNS ON THE REAL ENGINE, AND A SECOND PASS CREATES NOTHING (qa ruling 2026-10-17 ~11:5xZ).
 *
 * After 156802c went live, the upkeep `index-shape-descriptions` failed EVERY cycle on node1 with
 * `Parse error: Missing order idiom created_at in statement selection` (listIndexed ordered by an unprojected field).
 * Fixing only that would have FLOODED the index. `concept` is SCHEMAFULL and `pointer` is a plain object, so the
 * `pointer.name` the indexer wrote is dropped on write, every listed row's name is null, and syncShapeIndex would
 * re-create every described shape on every cycle. The name is now read back from the indexed content (indexedName,
 * the single reader of indexedContent's format).
 *
 * Runs the REAL listIndexed statement and name mapping (listIndexedWith) and the real syncShapeIndex on a throwaway
 * in-memory SurrealDB built from every core migration, through a query function straight to that engine (a module mock
 * of the shared client that another file installs in a whole-suite run cannot stand in). Concepts are written with the
 * fields the live create writes. MUST-FAIL at the parent (41131b5): (a) the statement does not parse (the live error);
 * (b)/(c) the seam does not exist there. Needs the `surreal` binary; if missing the suite FAILS, never skips.
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

async function sql(text: string): Promise<any[]> {
  const r = await fetch(`${URL_}/sql`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'surreal-ns': NS, 'surreal-db': DB, Authorization: 'Basic ' + btoa(`root:${PASS}`) },
    body: text,
  });
  return (await r.json()) as any[];
}

/** A query function straight to the throwaway engine (params bound with LET), so a module mock another test file
 *  installed on the shared client in a whole-suite run cannot stand in for the engine. */
async function realQuery(text: string, params: Record<string, unknown>): Promise<unknown[]> {
  const lets = Object.entries(params).map(([k, v]) => `LET $${k} = ${JSON.stringify(v)};`).join(' ');
  const res = await sql(`${lets} ${text};`);
  const last = res[res.length - 1];
  if (last?.status !== 'OK') throw new Error(String(last?.result ?? 'query failed'));
  return last.result as unknown[];
}
/** A shape concept written with the fields the live create (createConcept) writes, including pointer {type, name}. */
async function createAsLive(name: string, content: string): Promise<void> {
  const { SHAPE_CONCEPT_SHAPE } = await import('../src/upkeep/shape-index');
  const r = await sql(`CREATE concept CONTENT ${JSON.stringify({ id: 'si_' + crypto.randomUUID().slice(0, 8), pointer: { type: SHAPE_CONCEPT_SHAPE, name }, shape: SHAPE_CONCEPT_SHAPE, source_type: SHAPE_CONCEPT_SHAPE, org_id: ORG, scope: 'global', public: true, content, summary: content.slice(0, 300) })};`);
  if (r[r.length - 1]?.status !== 'OK') throw new Error(`create failed: ${JSON.stringify(r).slice(0, 300)}`);
}

/** The listIndexed statement, exactly as listIndexedWith (src/upkeep/shape-index.ts) issues it. */
function listIndexedSql(): string {
  const src = readFileSync(ROOT + 'src/upkeep/shape-index.ts', 'utf8');
  const m = src.match(/'(SELECT [^']*FROM concept WHERE shape = \$shape AND org_id = \$org_id[^']*)'/);
  if (!m) throw new Error('listIndexed statement not found in shape-index.ts');
  return m[1]!;
}

beforeAll(async () => {
  const hardStop = setTimeout(() => proc?.kill(), 150_000);
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
  } catch (e) {
    startError = `cannot spawn surreal: ${e instanceof Error ? e.message : String(e)}`;
    proc?.kill();
  }
}, 120_000);

afterAll(() => { proc?.kill(); });

describe('the shape indexer on the real engine', () => {
  it('[MUST-FAIL] (a) the listIndexed statement parses (no "Missing order idiom")', async () => {
    expect(startError).toBe('');
    const { SHAPE_CONCEPT_SHAPE } = await import('../src/upkeep/shape-index');
    const res = await sql(`LET $shape = '${SHAPE_CONCEPT_SHAPE}'; LET $org_id = '${ORG}'; ${listIndexedSql()};`);
    const last = res[res.length - 1];
    expect(String(last?.result ?? '')).not.toContain('Missing order idiom');
    expect(last?.status).toBe('OK');
  }, 60_000);

  it('[MUST-FAIL] (b) a shape concept written by the LIVE create lists back with its name', async () => {
    const { listIndexedWith } = await import('../src/upkeep/shape-index');
    await createAsLive('fileContent', 'fileContent: the contents of a file');
    const raw = await realQuery('SELECT pointer FROM concept', {});
    expect(JSON.stringify(raw)).not.toContain('"name":"fileContent"'); // the engine DROPPED pointer.name (SCHEMAFULL)
    const rows = await listIndexedWith(realQuery, ORG);
    expect(rows.map((r) => r.name)).toEqual(['fileContent']);
  }, 60_000);

  it('[MUST-FAIL] (c) NO FLOOD: a second sync over the same descriptions creates nothing', async () => {
    // Only the pure module is imported (the live one pulls config, the system-org cache and the concept resolver into
    // the shared registry, which changed another file's outcome in a whole-suite run). Nothing here may update or
    // deactivate: a call to either would mean the second pass is not a no-op.
    const { listIndexedWith, syncShapeIndex } = await import('../src/upkeep/shape-index');
    const refuse = async () => { throw new Error('unexpected update/setActive in a no-change sync'); };
    const deps = { listIndexed: (o: string) => listIndexedWith(realQuery, o), create: async (_o: string, name: string, content: string) => { await createAsLive(name, content); return name; }, update: refuse, setActive: refuse, fetchDescriptions: async () => ({ fileContent: 'the contents of a file', codeSearchResult: 'matches of a code search' }), fetchAdvertised: async () => ['fileContent', 'codeSearchResult'] };
    const first = await syncShapeIndex(ORG, deps);
    const second = await syncShapeIndex(ORG, deps);
    expect(first.created).toEqual(['codeSearchResult']); // fileContent already exists from (b)
    expect(second.created).toEqual([]);
    expect(second.unchanged).toBe(2);
    const count = await sql(`SELECT count() AS n FROM concept WHERE shape = 'shape_description' GROUP ALL;`);
    expect(count[count.length - 1].result[0].n).toBe(2);
  }, 60_000);
});

describe('indexedName round-trips every shape name indexedContent writes', () => {
  it('[CONTROL] plain, dotted, colon-namespaced and underscore names round-trip; text without the format is null', async () => {
    const { indexedContent, indexedName } = await import('../src/upkeep/shape-index');
    for (const n of ['fileContent', 'gapLearningCredit_write', 'development-vessel:feature_compose', 'a.b', 'x@y']) {
      expect(indexedName(indexedContent(n, 'some description: with a colon inside'))).toBe(n);
    }
    expect(indexedName('no separator here')).toBeNull();
    expect(indexedName(': starts with separator')).toBeNull();
    expect(indexedName('has space: description')).toBeNull(); // a name with whitespace is unreadable -> counted, never re-created
    expect(indexedName(null)).toBeNull();
  });
});
