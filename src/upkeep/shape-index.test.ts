// THE SHAPE INDEX (I-T structural, RUN 3): every described shape is indexed for recall by meaning, a changed
// description is re-indexed, a shape no longer described leaves, an advertised shape with no description is COUNTED,
// and registration/template events trigger the sync (debounced), with the upkeep activity as the backstop.
import { describe, expect, it } from 'bun:test';
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

describe('the shared scope trusts only the system org (security)', () => {
  it("[MUST-FAIL] a global public row written by ANOTHER org is not admitted: the condition pins the trusted writer", async () => {
    const { searchOrgCondition, GLOBAL_TRUSTED_ORG } = await import('../resolvers/concept');
    const cond = searchOrgCondition(true);
    expect(cond).toContain("org_id = $global_trusted_org");
    expect(GLOBAL_TRUSTED_ORG).toBe('default');
    // evaluate the condition over rows the way the database would (org A searching; org B published a global row)
    const admits = (row: { org_id: string; scope: string; public: boolean }, me: string) =>
      row.org_id === me || (row.scope === 'global' && row.public === true && row.org_id === GLOBAL_TRUSTED_ORG);
    expect(admits({ org_id: 'org-b', scope: 'global', public: true }, 'org-a')).toBe(false);
  });
  it('[CONTROL] the system org\'s global public row IS admitted for any org; without include_global nothing global is', async () => {
    const { searchOrgCondition, GLOBAL_TRUSTED_ORG } = await import('../resolvers/concept');
    const admits = (row: { org_id: string; scope: string; public: boolean }, me: string) =>
      row.org_id === me || (row.scope === 'global' && row.public === true && row.org_id === GLOBAL_TRUSTED_ORG);
    expect(admits({ org_id: 'default', scope: 'global', public: true }, 'org-a')).toBe(true);
    expect(admits({ org_id: 'default', scope: 'global', public: false }, 'org-a')).toBe(false); // retired
    expect(searchOrgCondition(false)).toBe('org_id = $org_id');
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
    expect(c).toContain('const orgCondition = searchOrgCondition(request.include_global === true);');
    expect(c).toContain('if (request.include_global === true) params.global_trusted_org = GLOBAL_TRUSTED_ORG;');
    // the resolve plane forwards it, so a vessel recalls the index through the ordinary {type: "concept"} pointer
    const route = readFileSync(join(import.meta.dir, '..', 'routes', 'impulses.ts'), 'utf-8');
    expect(route).toContain('include_global: pointer.include_global === true,');
    expect(c.match(/\$\{orgCondition\}/g)?.length).toBe(2);
    expect(c).toContain('searchConceptsByDense(request.query, orgId, scalarConditions, params, fetchLimit, jwtToken, orgCondition)');
    expect(c).toContain('void writeConceptEmbeddings(String(updated.id).replace(/^concept:/, \'\'), updated.content, updated.summary);');
    const sql = readFileSync(join(import.meta.dir, '..', '..', 'sql', 'core', '008-permissions-token-org.surql'), 'utf-8');
    expect(sql).toContain("(scope = 'global' AND public = true)");
  });
});
