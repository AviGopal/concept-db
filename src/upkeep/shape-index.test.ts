// THE SHAPE INDEX (I-T structural, RUN 3): every described shape is indexed for recall by meaning, a changed
// description is re-indexed, a shape no longer described leaves, an advertised shape with no description is COUNTED,
// and registration/template events trigger the sync (debounced), with the upkeep activity as the backstop.
import { describe, expect, it, spyOn } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { debouncedSync, indexedContent, syncShapeIndex, type IndexedShape, type ShapeIndexDeps } from './shape-index';

type Row = IndexedShape & { usage: number };
function memDeps(descriptions: Record<string, string>, advertised: string[], seed: Row[] = []) {
  const rows: Row[] = [...seed];
  let n = 0;
  const deps: ShapeIndexDeps = {
    fetchDescriptions: async () => ({ ...descriptions }),
    fetchAdvertised: async () => [...advertised],
    listIndexed: async () => rows.map(({ usage: _u, ...r }) => ({ ...r })),
    create: async (_o, name, content) => { const id = `c${++n}`; rows.push({ id, name, content, active: true, usage: 0 }); return id; },
    update: async (_o, id, content) => { const r = rows.find((x) => x.id === id)!; r.content = content; },
    setActive: async (_o, id, active) => { rows.find((x) => x.id === id)!.active = active; },
  };
  return { deps, rows };
}
const sync = (m: ReturnType<typeof memDeps>) => syncShapeIndex('default', m.deps);

describe('syncShapeIndex', () => {
  it('[MUST-FAIL] every described shape is indexed with its name and description', async () => {
    const m = memDeps({ widgetLedger_tally: 'Counts widgets per category.', notice_post: 'Posts a notice.' }, ['widgetLedger_tally', 'notice_post']);
    const r = await sync(m);
    expect(r.created.sort()).toEqual(['notice_post', 'widgetLedger_tally']);
    expect(m.rows.map((x) => x.content).sort()).toEqual([indexedContent('notice_post', 'Posts a notice.'), indexedContent('widgetLedger_tally', 'Counts widgets per category.')]);
  });
  it('[MUST-FAIL] a shape that appears LATER is indexed by the next sync (one event), with no traces needed', async () => {
    const d: Record<string, string> = { a: 'A thing.' };
    const m = memDeps(d, ['a']);
    await sync(m);
    d['s_new9'] = 'Totals parcels held per destination region.';
    expect((await sync(m)).created).toEqual(['s_new9']);
  });
  it('[MUST-FAIL] a changed description is re-indexed IN PLACE: same id, its usage survives (never a reset of learning)', async () => {
    const d: Record<string, string> = { a: 'Old wording.', b: 'Stays.' };
    const m = memDeps(d, ['a', 'b']);
    await sync(m);
    const before = m.rows.find((x) => x.name === 'a')!;
    before.usage = 17;
    d['a'] = 'New wording.';
    const r = await sync(m);
    expect(r.reindexed).toEqual(['a']);
    expect(r.unchanged).toBe(1);
    const after = m.rows.filter((x) => x.name === 'a');
    expect(after.length).toBe(1);
    expect(after[0]!.id).toBe(before.id);
    expect(after[0]!.usage).toBe(17);
    expect(after[0]!.content).toBe(indexedContent('a', 'New wording.'));
  });
  it('[MUST-FAIL] retire is SOFT: an unclaimed shape leaves recall but keeps its row; described again it is restored on the SAME id, history intact', async () => {
    const d: Record<string, string> = { a: 'A.', gone: 'Will vanish.' };
    const m = memDeps(d, ['a', 'gone']);
    await sync(m);
    const row = m.rows.find((x) => x.name === 'gone')!;
    row.usage = 5;
    delete d['gone'];
    expect((await sync(m)).retired).toEqual(['gone']);
    expect(row.active).toBe(false);
    expect(m.rows.includes(row)).toBe(true);
    d['gone'] = 'Will vanish.';
    const r = await sync(m);
    expect(r.restored).toEqual(['gone']);
    expect(r.created).toEqual([]);
    expect(row.active).toBe(true);
    expect(row.usage).toBe(5);
  });
  it('[CONTROL] an advertised shape with no description is COUNTED and named, not silently skipped', async () => {
    const m = memDeps({ a: 'A.' }, ['a', 'undescribed_one', 'undescribed_two']);
    const r = await sync(m);
    expect(r.undescribed).toEqual(['undescribed_one', 'undescribed_two']);
    expect(m.rows.map((x) => x.name)).toEqual(['a']);
  });
  it('[HELD-OUT] duplicate rows for one shape: one stays active, the others are deactivated (kept, never deleted)', async () => {
    const m = memDeps({ a: 'A.' }, ['a'], [{ id: 'x1', name: 'a', content: indexedContent('a', 'A.'), active: true, usage: 3 }, { id: 'x2', name: 'a', content: 'stale', active: true, usage: 1 }]);
    await sync(m);
    expect(m.rows.length).toBe(2);
    expect(m.rows.filter((x) => x.active).map((x) => x.id)).toEqual(['x1']);
  });
});

describe('the shared scope trusts only the validated system org (security)', () => {
  // the database's reading of the search condition, given the params the search bound
  const admits = (sql: string, params: Record<string, unknown>, row: { org_id: string; scope: string; public: boolean }) =>
    row.org_id === params.org_id ||
    (sql.includes('org_id = $global_trusted_org') && row.scope === 'global' && row.public === true && row.org_id === params.global_trusted_org);
  const searchBinding = async (validated: string | null) => {
    const { surrealDB } = await import('../db/surreal');
    const so = await import('../services/system-org');
    so.resetSystemOrgCache();
    await so.systemOrgId(async () => (validated === null ? null : { orgId: validated }), 'own-key');
    const seen: Array<{ sql: string; params: Record<string, unknown> }> = [];
    const spy = spyOn(surrealDB, 'query').mockImplementation((async (sql: string, params?: Record<string, unknown>) => { seen.push({ sql, params: params ?? {} }); return []; }) as never);
    try {
      const { searchConcepts } = await import('../resolvers/concept');
      await searchConcepts({ shape: 'shape_description', include_global: true, limit: 5, offset: 0 } as never, 'org-a');
    } finally { spy.mockRestore(); so.resetSystemOrgCache(); }
    const q = seen.find((x) => /FROM concept/.test(x.sql))!;
    return q;
  };

  it("[MUST-FAIL] an unauthenticated caller's global public row (org 'default') is NOT recalled by another org", async () => {
    const q = await searchBinding('organizations:substrate');
    expect(admits(q.sql, q.params, { org_id: 'default', scope: 'global', public: true })).toBe(false);
  });
  it("[MUST-FAIL] another tenant's global public row is not recalled either", async () => {
    const q = await searchBinding('organizations:substrate');
    expect(admits(q.sql, q.params, { org_id: 'org-b', scope: 'global', public: true })).toBe(false);
  });
  it("[CONTROL] the validated system org's global public row IS recalled; a retired one (public false) is not; the caller's own rows are", async () => {
    const q = await searchBinding('organizations:substrate');
    expect(admits(q.sql, q.params, { org_id: 'organizations:substrate', scope: 'global', public: true })).toBe(true);
    expect(admits(q.sql, q.params, { org_id: 'organizations:substrate', scope: 'global', public: false })).toBe(false);
    expect(admits(q.sql, q.params, { org_id: 'org-a', scope: 'org', public: false })).toBe(true);
  });
  it("[MUST-FAIL] FAIL CLOSED: with no validated system org, nothing global is recalled (not a guessed org)", async () => {
    const q = await searchBinding(null);
    expect(q.sql).not.toContain('$global_trusted_org');
    expect(admits(q.sql, q.params, { org_id: 'organizations:substrate', scope: 'global', public: true })).toBe(false);
    expect(admits(q.sql, q.params, { org_id: 'org-a', scope: 'org', public: false })).toBe(true);
  });
  it("[MUST-FAIL] identity answering 'default' (or empty) never makes it trusted", async () => {
    const so = await import('../services/system-org');
    for (const bad of ['default', '']) {
      so.resetSystemOrgCache();
      expect(await so.systemOrgId(async () => ({ orgId: bad }), 'own-key')).toBeNull();
    }
    so.resetSystemOrgCache();
    expect(await so.systemOrgId(async () => { throw new Error('identity down'); }, 'own-key')).toBeNull();
    so.resetSystemOrgCache();
    expect(await so.systemOrgId(async () => ({ orgId: 'x' }), '')).toBeNull();
    so.resetSystemOrgCache();
  });
  it('[MUST-FAIL] the index is written under the system org, and with none it is not written at all', async () => {
    const { runShapeIndexSync } = await import('./shape-index-live');
    const m = memDeps({ a: 'A thing.' }, ['a']);
    const wrote: string[] = [];
    const deps = { ...m.deps, create: async (org: string, n: string, c: string) => { wrote.push(org); return m.deps.create(org, n, c); } };
    expect(await runShapeIndexSync('test', deps, async () => null)).toBeNull();
    expect(wrote).toEqual([]);
    await runShapeIndexSync('test', deps, async () => 'organizations:substrate');
    expect(new Set(wrote)).toEqual(new Set(['organizations:substrate']));
  });
});

describe('triggers', () => {
  it('[UNIT] a burst of events becomes one sync (debounced)', async () => {
    let runs = 0;
    const fire = debouncedSync(async () => { runs++; }, 30);
    for (let i = 0; i < 5; i++) fire();
    await Bun.sleep(120);
    expect(runs).toBe(1);
  });
  it('[WIRING] the observer forwards registration and template events (not heartbeats); startup and upkeep both sync', () => {
    const obs = readFileSync(join(import.meta.dir, '..', 'services', 'execution-observer.ts'), 'utf-8');
    for (const t of ["case 'vessel.registered':", "case 'vessel.deregistered':", "case 'vessel.expired':", "case 'template_created':"]) expect(obs).toContain(t);
    expect(obs).not.toContain("case 'vessel.heartbeat':");
    expect(obs).toContain('this.onShapeRegistryChange?.(event.type);');
    const idx = readFileSync(join(import.meta.dir, '..', 'index.ts'), 'utf-8');
    expect(idx).toContain('new ExecutionObserver({ onShapeRegistryChange: () => shapeIndexOnChange() })');
    const acts = readFileSync(join(import.meta.dir, 'activities.ts'), 'utf-8');
    expect(acts).toContain("id: 'index-shape-descriptions',");
    expect(acts).toContain('  indexShapeDescriptions,');
  });
  it('[WIRING] the index lives in the SHARED scope the table grants every org, recalled with include_global; an update re-embeds in place', () => {
    const live = readFileSync(join(import.meta.dir, 'shape-index-live.ts'), 'utf-8');
    expect(live).toContain("scope: 'global', public: true");
    expect(live).toContain('SET public = $active');
    expect(live).not.toContain('deleteConcept');
    const c = readFileSync(join(import.meta.dir, '..', 'resolvers', 'concept.ts'), 'utf-8');
    expect(c).toContain('const orgCondition = searchOrgCondition(trustedOrg !== null);');
    expect(c).toContain('if (trustedOrg !== null) params.global_trusted_org = trustedOrg;');
    // the resolve plane forwards it, so a vessel recalls the index through the ordinary {type: "concept"} pointer
    const route = readFileSync(join(import.meta.dir, '..', 'routes', 'impulses.ts'), 'utf-8');
    expect(route).toContain('include_global: pointer.include_global === true,');
    // the lexical leg's two field queries share ONE filtered hydrate (848ce6a: stage 2 no longer re-matches), so the tenant
    // condition appears once there, and the hydrate is where it is applied
    expect(c.match(/\$\{orgCondition\}/g)?.length).toBe(1);
    expect(c).toContain('type::thing("concept", $i)) WHERE ${orgCondition}${scalarWhere}`;');
    expect(c).toContain('searchConceptsByDense(request.query, orgId, scalarConditions, params, fetchLimit, jwtToken, orgCondition)');
    expect(c).toContain('void writeConceptEmbeddings(String(updated.id).replace(/^concept:/, \'\'), updated.content, updated.summary);');
    const sql = readFileSync(join(import.meta.dir, '..', '..', 'sql', 'core', '008-permissions-token-org.surql'), 'utf-8');
    expect(sql).toContain("(scope = 'global' AND public = true)");
  });
});
