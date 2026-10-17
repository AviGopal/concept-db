/**
 * ORG SCOPING ON THE UPKEEP TRIGGER'S OUTPUT. Upkeep is system maintenance and runs over every org's concepts; the
 * runs it returns name the concepts and edges it changed. A caller of POST /upkeep/trigger is shown only the ids that
 * belong to ITS org: any other id (another org's, or one that no longer exists, so its org cannot be shown to be the
 * caller's) is removed and counted, never listed.
 */
import { surrealDB } from '../db/surreal';

export interface RunChange { type: string; entity: string; id: string }
export interface RedactableRun { changes?: RunChange[] }

/** entity name in a run's changes -> the table its id lives in */
const TABLE_OF: Record<string, string> = { concept: 'concept', edge: 'concept_edge' };
const KNOWN_TABLES = new Set(Object.values(TABLE_OF));

export type OwnedIds = (table: string, ids: string[], orgId: string) => Promise<Set<string>>;

const bare = (id: string, table: string) => String(id).replace(new RegExp(`^${table}:`), '').replace(/[⟨⟩`]/g, '');

/** The subset of `ids` (bare record ids in `table`) whose row belongs to `orgId`. */
export const ownedIdsLive: OwnedIds = async (table, ids, orgId) => {
  if (ids.length === 0 || !KNOWN_TABLES.has(table)) return new Set();
  // record-id lookups (the `$ids.map(type::thing)` form the dense hydrate uses), filtered by org. The table is a literal
  // from the fixed set above: measured on 2.3.10, a bound `$tb` inside the closure resolves to nothing, so every id read
  // as not owned.
  const rows = await surrealDB.query<string>(
    `SELECT VALUE meta::id(id) FROM $ids.map(|$i| type::thing("${table}", $i)) WHERE org_id = $org_id`,
    { ids, org_id: orgId },
  );
  return new Set((rows ?? []).map(String));
};

export async function redactRunsToOrg<R extends RedactableRun>(runs: R[], orgId: string, owned: OwnedIds = ownedIdsLive): Promise<{ runs: R[]; withheld: number }> {
  const want = new Map<string, Set<string>>();
  for (const r of runs) for (const ch of r.changes ?? []) {
    const tb = TABLE_OF[ch.entity];
    if (tb) (want.get(tb) ?? want.set(tb, new Set()).get(tb)!).add(bare(ch.id, tb));
  }
  const keep = new Map<string, Set<string>>();
  for (const [tb, ids] of want) keep.set(tb, await owned(tb, [...ids], orgId));
  let withheld = 0;
  const out = runs.map((r) => {
    if (!r.changes) return r;
    const changes = r.changes.filter((ch) => {
      const tb = TABLE_OF[ch.entity];
      const ok = !!tb && !!keep.get(tb)?.has(bare(ch.id, tb));
      if (!ok) withheld++;
      return ok;
    });
    return { ...r, changes };
  });
  return { runs: out, withheld };
}
