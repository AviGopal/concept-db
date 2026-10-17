/**
 * ORG SCOPING ON ID PATHS: a concept id names a record, not a permission.
 *
 * The org boundary on an id-addressed path is the query's own predicate. Searches always carried it; the id paths did
 * not, so they now do: another org's concept is not read, overwritten, bumped, edged or credited by naming its id.
 *
 * The store below is a stand-in for the database with ONE semantic: a statement is filtered by org if and only if it
 * says `org_id = $org_id`. So each must-fail is red exactly when the code omits the predicate (or binds the wrong org),
 * and green when it carries the caller's. The semantics against the real engine are proved by the live check
 * (tests/org-scoped-id-paths.check.sh, run in-container against a throwaway in-memory SurrealDB).
 *
 * Every must-fail has its CONTROL: the owning org, through the same call, still reads, updates, edges and credits.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as db from '../src/db/surreal';
import { getConceptById, resolveConcept, updateConcept } from '../src/resolvers/concept';
import { upsertEdge, getEdgesForConcept } from '../src/resolvers/edge';
import { getSequenceNeighbors } from '../src/resolvers/sequence';
import { recordUsage, getUsageStats } from '../src/resolvers/usage';
import { decontaminateCredit } from '../src/resolvers/decontaminate';
import { redactRunsToOrg } from '../src/upkeep/run-redaction';

type Row = Record<string, unknown> & { id: string; org_id: string };
const A = 'org_alpha';
const B = 'org_beta';
const CA = 'concept_alphaconcept1';
const CA2 = 'concept_alphaconcept2';

let concepts: Map<string, Row>;
let edges: Row[];
let usages: Row[];
let writes: string[];

function orgOk(sql: string, params: Record<string, unknown>, row: Row): boolean {
  return !/\borg_id\s*=\s*\$org_id\b/.test(sql) || row.org_id === params.org_id;
}
const idParam = (sql: string, p: Record<string, unknown>) => {
  const m = sql.match(/type::thing\("concept",\s*\$(\w+)\)/);
  return m ? String(p[m[1]!] ?? '') : '';
};

function query(sqlIn: string, params: Record<string, unknown> = {}): unknown[] {
  const sql = sqlIn.replace(/\s+/g, ' ').trim();
  // concept by record id (read or write)
  if (/^(SELECT .*? FROM|UPDATE) type::thing\("concept", \$\w+\)/.test(sql) || /^SELECT id FROM concept WHERE id = type::thing\("concept", \$cid\)/.test(sql)) {
    const row = concepts.get(idParam(sql, params));
    if (!row || !orgOk(sql, params, row)) return [];
    if (sql.startsWith('UPDATE')) {
      writes.push(`concept:${row.id}`);
      if ('content' in params) row.content = params.content;
      if (/times_loaded = times_loaded \+ 1/.test(sql)) row.times_loaded = Number(row.times_loaded ?? 0) + 1;
      if ('tl' in params) row.times_loaded = params.tl;
    }
    return [row];
  }
  if (/^SELECT VALUE meta::id\(id\) FROM \[type::thing\("concept", \$from_id\), type::thing\("concept", \$to_id\)\]/.test(sql)) {
    return [params.from_id, params.to_id].map(String).filter((id) => { const r = concepts.get(id); return !!r && orgOk(sql, params, r); });
  }
  if (/^SELECT \* FROM concept WHERE id IN \$ids/.test(sql)) {
    const ids = (params.ids as string[]) ?? [];
    return [...concepts.values()].filter((r) => ids.includes(r.id) && orgOk(sql, params, r));
  }
  if (/^SELECT id, times_loaded, times_succeeded FROM concept WHERE times_loaded >= \$min/.test(sql)) {
    return [...concepts.values()].filter((r) => Number(r.times_loaded ?? 0) >= Number(params.min) && orgOk(sql, params, r));
  }
  if (/^SELECT trace_id, outcome FROM concept_usage/.test(sql)) return [];
  // edges
  if (/^INSERT INTO concept_edge/.test(sql)) {
    const e: Row = { id: String(params.id), from: String(params.from_concept_id), to: String(params.to_concept_id), edge_type: params.edge_type, weight: params.weight, times_traversed: 1, description: params.description, org_id: String(params.org_id) };
    edges.push(e);
    return [e];
  }
  if (/^UPDATE type::thing\("concept_edge", \$edge_id\)/.test(sql)) {
    const e = edges.find((x) => x.id === params.edge_id);
    if (!e || !orgOk(sql, params, e)) return [];
    writes.push(`edge:${e.id}`);
    if ('weight' in params) e.weight = params.weight;
    if ('description' in params) e.description = params.description;
    return [e];
  }
  if (/FROM concept_edge/.test(sql)) {
    const cid = String(params.concept_id ?? '');
    const sel = edges.filter((e) => {
      if (!orgOk(sql, params, e)) return false;
      if (params.edge_type !== undefined && e.edge_type !== params.edge_type) return false;
      if (params.from_id !== undefined) return e.from === params.from_id && e.to === params.to_id;
      if (/^SELECT to_concept/.test(sql)) return e.from === cid;
      if (/^SELECT from_concept/.test(sql)) return e.to === cid;
      return e.from === cid || e.to === cid;
    });
    if (/^SELECT id, weight/.test(sql)) return sel.slice(0, 1).map((e) => ({ id: e.id, weight: e.weight }));
    if (/^SELECT to_concept/.test(sql)) return sel.map((e) => ({ to_concept: `concept:${e.to}` }));
    if (/^SELECT from_concept/.test(sql)) return sel.map((e) => ({ from_concept: `concept:${e.from}` }));
    if (/neighbor_id/.test(sql)) return sel.map((e) => ({ neighbor_id: `concept:${e.from === cid ? e.to : e.from}`, weight: e.weight, times_traversed: e.times_traversed }));
    if (/count\(\) as cnt/.test(sql)) return [{ cnt: sel.length }];
    return sel;
  }
  // usage
  if (/^CREATE type::thing\("concept_usage"/.test(sql)) {
    const u: Row = { id: String(params.id), concept: String(params.concept_id ?? ''), org_id: String(params.org_id), outcome: params.outcome };
    usages.push(u);
    return [u];
  }
  if (/FROM concept_usage/.test(sql)) {
    const sel = usages.filter((u) => orgOk(sql, params, u));
    return [{ total: sel.length, successes: 0, failures: 0, neutrals: 0 }];
  }
  return [];
}

let spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  concepts = new Map([
    [CA, { id: CA, org_id: A, content: 'alpha private lesson', times_loaded: 60, times_succeeded: 1, relevance: 0.5 }],
    [CA2, { id: CA2, org_id: A, content: 'alpha second', times_loaded: 0 }],
  ]);
  edges = [{ id: 'edge_alpha1', from: CA, to: CA2, edge_type: 'sequence_next', weight: 0.4, times_traversed: 1, description: 'alpha edge', org_id: A }];
  usages = [{ id: 'usage_alpha1', concept: CA, org_id: A, outcome: 'success' }];
  writes = [];
  spies = [
    spyOn(db.surrealDB, 'query').mockImplementation((async (sql: string, params?: Record<string, unknown>) => query(sql, params)) as never),
    spyOn(globalThis, 'fetch').mockImplementation((async () => new Response('{}', { status: 200 })) as never),
  ];
});
afterEach(() => { for (const s of spies) s.mockRestore(); spies = []; });

describe('another org cannot reach a concept by naming its id', () => {
  test('MF read: getConceptById as org B finds nothing; CONTROL: org A reads it', async () => {
    expect(await getConceptById(CA, B)).toBeNull();
    expect((await getConceptById(CA, A))?.content).toBe('alpha private lesson');
  });

  test('MF resolve: resolveConcept as org B is "not found" and bumps nothing; CONTROL: org A resolves with its edge', async () => {
    await expect(resolveConcept({ concept_id: CA, include_neighbors: true } as never, B)).rejects.toThrow(/not found/i);
    expect(concepts.get(CA)!.times_loaded).toBe(60);
    expect(writes).toEqual([]);
    const r = await resolveConcept({ concept_id: CA, include_neighbors: true } as never, A);
    expect(concepts.get(CA)!.times_loaded).toBe(61);
    expect(r.concept.id).toBe(CA);
  });

  test('MF overwrite: updateConcept as org B changes nothing and reports not found; CONTROL: org A updates', async () => {
    await expect(updateConcept(CA, { content: 'injected by beta' }, B)).rejects.toThrow(/not found/i);
    expect(concepts.get(CA)!.content).toBe('alpha private lesson');
    await updateConcept(CA, { content: 'alpha revised' }, A);
    expect(concepts.get(CA)!.content).toBe('alpha revised');
  });

  test("MF edge write: upsertEdge as org B between org A's concepts is refused and leaves A's edge as it was; CONTROL: org A's upsert applies to its edge", async () => {
    await expect(upsertEdge({ from_concept_id: CA, to_concept_id: CA2, edge_type: 'sequence_next', weight: 0.9, description: 'beta says' } as never, B)).rejects.toThrow(/not found/i);
    const alpha = edges.find((e) => e.id === 'edge_alpha1')!;
    expect(alpha.description).toBe('alpha edge');
    expect(alpha.weight).toBe(0.4);
    expect(edges.filter((e) => e.org_id === B)).toHaveLength(0);
    await upsertEdge({ from_concept_id: CA, to_concept_id: CA2, edge_type: 'sequence_next', weight: 0.9 } as never, A);
    expect(Number(alpha.weight)).toBeGreaterThan(0.4);
  });

  test("MF edge/sequence reads: org B lists none of org A's edges or neighbours; CONTROL: org A does", async () => {
    expect(await getEdgesForConcept(CA, 'both', undefined, B)).toHaveLength(0);
    expect(await getSequenceNeighbors(CA, 'next', 5, undefined, B)).toHaveLength(0);
    expect(await getEdgesForConcept(CA, 'both', undefined, A)).toHaveLength(1);
    expect((await getSequenceNeighbors(CA, 'next', 5, undefined, A)).map((n) => n.concept_id)).toEqual([CA2]);
  });

  test("MF credit: recordUsage as org B against org A's concept is refused; CONTROL: org A's usage is recorded", async () => {
    await expect(recordUsage({ concept_id: CA, trace_id: 'exec_beta', outcome: 'success' } as never, B)).rejects.toThrow(/not found/i);
    expect(usages.filter((u) => u.org_id === B)).toHaveLength(0);
    await recordUsage({ concept_id: CA, trace_id: 'exec_alpha', outcome: 'success' } as never, A);
    expect(usages.filter((u) => u.org_id === A)).toHaveLength(2);
  });

  test("MF usage stats: org B's stats for org A's concept count none of A's usage; CONTROL: org A's count it", async () => {
    expect((await getUsageStats(CA, undefined, B)).total_uses).toBe(0);
    expect((await getUsageStats(CA, undefined, A)).total_uses).toBe(1);
  });

  test("MF repair: decontaminateCredit run by org B examines and rewrites none of org A's concepts; CONTROL: org A's run does", async () => {
    const rb = await decontaminateCredit({ dry_run: false, min_loads: 50 }, B);
    expect(rb.concepts_examined).toBe(0);
    expect(concepts.get(CA)!.times_loaded).toBe(60);
    const ra = await decontaminateCredit({ dry_run: false, min_loads: 50 }, A);
    expect(ra.concepts_examined).toBe(1);
    expect(concepts.get(CA)!.times_loaded).toBe(0);
  });
});

describe("the upkeep trigger's output lists only the caller's org's ids", () => {
  const runs = [
    { activity_id: 'x', changes: [{ type: 'updated', entity: 'concept', id: `concept:${CA}` }, { type: 'created', entity: 'edge', id: 'edge_alpha1' }] },
    { activity_id: 'y', changes: [{ type: 'updated', entity: 'concept', id: 'concept_betaconcept1' }, { type: 'deleted', entity: 'concept', id: 'concept_gone' }] },
    { activity_id: 'z' },
  ];
  const owned = async (table: string, ids: string[], org: string) => {
    const own: Record<string, Record<string, string[]>> = { [A]: { concept: [CA], concept_edge: ['edge_alpha1'] }, [B]: { concept: ['concept_betaconcept1'], concept_edge: [] } };
    return new Set(ids.filter((i) => own[org]?.[table]?.includes(i)));
  };

  test("MF: org B sees only its own concept id; A's ids and the deleted one are withheld and counted", async () => {
    const { runs: out, withheld } = await redactRunsToOrg(runs, B, owned);
    expect(out.flatMap((r) => r.changes ?? []).map((c) => c.id)).toEqual(['concept_betaconcept1']);
    expect(withheld).toBe(3);
    expect(out[2]).toEqual(runs[2]!);
  });

  test("CONTROL: org A sees its concept and edge", async () => {
    const { runs: out, withheld } = await redactRunsToOrg(runs, A, owned);
    expect(out.flatMap((r) => r.changes ?? []).map((c) => c.id)).toEqual([`concept:${CA}`, 'edge_alpha1']);
    expect(withheld).toBe(2);
  });
});
