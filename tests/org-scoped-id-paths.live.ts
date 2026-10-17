/**
 * LIVE half of tests/org-scoped-id-paths.test.ts: the same org boundary, against the REAL engine (run by
 * org-scoped-id-paths.check.sh against a throwaway in-memory SurrealDB with this repo's schema), so only the queries'
 * own predicates keep orgs apart. Exits non-zero, naming each breach, if any path crosses orgs; each has a control.
 */
import { surrealDB } from '../src/db/surreal';
import { getConceptById, resolveConcept, updateConcept } from '../src/resolvers/concept';
import { upsertEdge, getEdgesForConcept } from '../src/resolvers/edge';
import { getSequenceNeighbors } from '../src/resolvers/sequence';
import { recordUsage, getUsageStats } from '../src/resolvers/usage';
import { decontaminateCredit } from '../src/resolvers/decontaminate';
import { ownedIdsLive } from '../src/upkeep/run-redaction';

const A = 'org_alpha', B = 'org_beta';
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); if (!ok) failures.push(name); };
const throws = async (f: () => Promise<unknown>) => { try { await f(); return false; } catch { return true; } };

await surrealDB.connect();
const mk = async (id: string, org: string, content: string, loaded = 0) => surrealDB.query(
  `CREATE type::thing("concept", $id) SET pointer = { type: 'memo' }, content = $content, summary = $content, shape = 'lesson', source_type = 'memo', org_id = $org, scope = 'org', times_loaded = $tl, times_succeeded = 0, times_failed = 0, relevance = 0.5, priority = 0.5, budget = 1000, token_estimate = 10, created_at = time::now(), updated_at = time::now()`,
  { id, content, org, tl: loaded });
await mk('concept_alpha1', A, 'alpha private lesson', 60);
await mk('concept_alpha2', A, 'alpha second');
await surrealDB.query(`INSERT INTO concept_edge { id: type::thing("concept_edge", "edge_alpha1"), from_concept: type::thing("concept", "concept_alpha1"), to_concept: type::thing("concept", "concept_alpha2"), edge_type: 'sequence_next', description: 'alpha edge', weight: 0.4, times_traversed: 1, org_id: $org }`, { org: A });
const row = async () => (await surrealDB.query<Record<string, unknown>>(`SELECT * FROM type::thing("concept", "concept_alpha1")`))[0]!;
const edge = async () => (await surrealDB.query<Record<string, unknown>>(`SELECT * FROM type::thing("concept_edge", "edge_alpha1")`))[0]!;
if (!(await row())) { console.log('FAIL setup: the fixture concept was not created (schema mismatch?)'); process.exit(2); }

check('read: org B cannot get A\'s concept by id', (await getConceptById('concept_alpha1', B)) === null);
check('read CONTROL: org A gets it', (await getConceptById('concept_alpha1', A))?.content === 'alpha private lesson');
check('resolve: org B is refused', await throws(() => resolveConcept({ concept_id: 'concept_alpha1', include_neighbors: true } as never, B)));
check('resolve: org B bumped nothing', Number((await row()).times_loaded) === 60, String((await row()).times_loaded));
check('resolve CONTROL: org A resolves and bumps', !(await throws(() => resolveConcept({ concept_id: 'concept_alpha1' } as never, A))) && Number((await row()).times_loaded) === 61);
check('overwrite: org B is refused', await throws(() => updateConcept('concept_alpha1', { content: 'injected by beta' }, B)));
check('overwrite: A\'s content unchanged', (await row()).content === 'alpha private lesson', String((await row()).content));
await updateConcept('concept_alpha1', { content: 'alpha revised' }, A);
check('overwrite CONTROL: org A updates', (await row()).content === 'alpha revised');
check('edge write: org B is refused an edge between A\'s concepts', await throws(() => upsertEdge({ from_concept_id: 'concept_alpha1', to_concept_id: 'concept_alpha2', edge_type: 'sequence_next', weight: 0.9, description: 'beta says' } as never, B)));
const e1 = await edge();
check('edge write: A\'s edge untouched by B', e1.description === 'alpha edge' && Number(e1.weight) === 0.4, `${e1.description}/${e1.weight}`);
check('edge reads: B lists none of A\'s edges', (await getEdgesForConcept('concept_alpha1', 'both', undefined, B)).length === 0);
check('edge write CONTROL: org A\'s upsert applies to its edge', !(await throws(() => upsertEdge({ from_concept_id: 'concept_alpha1', to_concept_id: 'concept_alpha2', edge_type: 'sequence_next', weight: 0.9 } as never, A))) && Number((await edge()).weight) > 0.4);
check('edge reads CONTROL: A lists its edge', (await getEdgesForConcept('concept_alpha1', 'both', undefined, A)).length === 1);
check('sequence: B sees no A neighbour via A\'s edge', (await getSequenceNeighbors('concept_alpha1', 'next', 5, undefined, B)).length === 0);
check('sequence CONTROL: A sees its neighbour', (await getSequenceNeighbors('concept_alpha1', 'next', 5, undefined, A)).some((n) => n.concept_id.includes('concept_alpha2')));
check('credit: B\'s usage on A\'s concept refused', await throws(() => recordUsage({ concept_id: 'concept_alpha1', trace_id: 'exec_beta', outcome: 'success' } as never, B)));
check('credit CONTROL: A\'s usage recorded', !(await throws(() => recordUsage({ concept_id: 'concept_alpha1', trace_id: 'exec_alpha', outcome: 'success' } as never, A))));
check('usage stats: B counts none of A\'s usage', (await getUsageStats('concept_alpha1', undefined, B)).total_uses === 0);
check('usage stats CONTROL: A counts its usage', (await getUsageStats('concept_alpha1', undefined, A)).total_uses === 1);
const before = Number((await row()).times_loaded);
const rb = await decontaminateCredit({ dry_run: false, min_loads: 50 }, B);
check('repair: B examines none of A\'s concepts', rb.concepts_examined === 0 && Number((await row()).times_loaded) === before, JSON.stringify({ ex: rb.concepts_examined }));
const ra = await decontaminateCredit({ dry_run: true, min_loads: 50 }, A);
check('repair CONTROL: A examines its own', Number(ra.concepts_examined) === 1);
const ownB = await ownedIdsLive('concept', ['concept_alpha1', 'concept_alpha2', 'concept_gone'], B);
const ownA = await ownedIdsLive('concept', ['concept_alpha1', 'concept_alpha2', 'concept_gone'], A);
check('upkeep output: none of A\'s ids are B\'s', ownB.size === 0);
check('upkeep output CONTROL: A owns its two, not the missing one', ownA.size === 2 && !ownA.has('concept_gone'), [...ownA].join(','));
const eB = await ownedIdsLive('concept_edge', ['edge_alpha1'], B), eA = await ownedIdsLive('concept_edge', ['edge_alpha1'], A);
check('upkeep output: edges by org', eB.size === 0 && eA.size === 1);

console.log(failures.length === 0 ? 'ALL OK' : `BREACHES: ${failures.length}`);
process.exit(failures.length === 0 ? 0 : 1);
