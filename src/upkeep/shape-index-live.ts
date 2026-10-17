/**
 * The shape index's live dependencies (shape-index.ts): discovery's descriptions and advertised shapes, and the
 * concept store through concept-db's own create/delete (so embeddings are written exactly as for any concept).
 */
import { config } from '../config';
import { systemOrgId } from '../services/system-org';
import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';
import { createConcept, updateConcept } from '../resolvers/concept';
import { SHAPE_CONCEPT_SHAPE, listIndexedWith, syncShapeIndex, type ShapeIndexDeps, type ShapeIndexResult, type IndexedShape } from './shape-index';

const discoveryUrl = () => config.discovery.endpoint.replace(/\/$/, '');

export const liveShapeIndexDeps: ShapeIndexDeps = {
  // the index is fleet vocabulary written once by the system org, so it reads the whole registry
  async fetchDescriptions(_orgId) {
    const r = await fetch(`${discoveryUrl()}/registry/shape-descriptions`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`discovery shape-descriptions HTTP ${r.status}`);
    const j = (await r.json()) as { shape_descriptions?: Record<string, unknown> };
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(j.shape_descriptions ?? {})) {
      const d = typeof v === 'string' ? v : String((v as { description?: unknown })?.description ?? '');
      if (d.trim()) out[k] = d;
    }
    return out;
  },
  async fetchAdvertised(_orgId) {
    const r = await fetch(`${discoveryUrl()}/registry/shapes`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return [];
    const j = (await r.json()) as Record<string, unknown>;
    const raw = (j['shapes'] ?? j) as unknown;
    if (Array.isArray(raw)) return raw.map((x) => (typeof x === 'string' ? x : String((x as { shape?: unknown; name?: unknown })?.shape ?? (x as { name?: unknown })?.name ?? ''))).filter(Boolean);
    return raw && typeof raw === 'object' ? Object.keys(raw as object) : [];
  },
  async listIndexed(orgId) {
    return listIndexedWith((sql, params) => surrealDB.query(sql, params), orgId);
  },
  async create(orgId, name, content) {
    // Written ONCE, in the shared scope every org may read (the table's own PERMISSIONS: scope 'global' AND public).
    const c = await createConcept({ source_type: SHAPE_CONCEPT_SHAPE, shape: SHAPE_CONCEPT_SHAPE, content, summary: content.slice(0, 300), scope: 'global', public: true, pointer: { type: SHAPE_CONCEPT_SHAPE, name } }, orgId);
    return c.id;
  },
  async update(orgId, id, content) {
    // updateConcept re-embeds a changed content/summary in place (writeConceptEmbeddings): same id, same history.
    await updateConcept(id, { content, summary: content.slice(0, 300) }, orgId);
  },
  async setActive(orgId, id, active) {
    await surrealDB.query('UPDATE type::thing("concept", $id) SET public = $active WHERE org_id = $org_id AND shape = $shape', { id, active, org_id: orgId, shape: SHAPE_CONCEPT_SHAPE });
  },
};

/**
 * One sync, written under the SYSTEM ORG (services/system-org.ts), logged with its counts (the undescribed shapes named,
 * so an unindexable shape is visible). With no validated system org it does not write, and says so (returns null).
 */
export async function runShapeIndexSync(trigger: string, deps: ShapeIndexDeps = liveShapeIndexDeps, resolveOrg: () => Promise<string | null> = () => systemOrgId()): Promise<ShapeIndexResult | null> {
  const orgId = await resolveOrg();
  if (!orgId) { logger.warn('[shape-index] sync skipped: no validated system org to write under', { trigger }); return null; }
  const r = await syncShapeIndex(orgId, deps);
  logger.info('[shape-index] sync', { org_id: orgId, trigger, created: r.created.length, reindexed: r.reindexed.length, retired: r.retired.length, unchanged: r.unchanged, unnamed: r.unnamed ?? 0, undescribed: r.undescribed.length, undescribed_shapes: r.undescribed.slice(0, 50) });
  return r;
}
