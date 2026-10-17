/**
 * THE SHAPE INDEX: every described shape, recallable by MEANING (I-T structural; user statement 2026-10-17T01:11:12Z
 * "We must consider how many shapes there will be in the future"; RUN 3).
 *
 * Goal-target inference must choose among the shapes that could answer a goal without putting every shape in every
 * prompt (O(shapes) per call fails by design at 10x today's registry). The architecture's way: concept-db owns dense
 * semantic search (SUBSTRATE_AS_SOFTWARE §2, "recall priors"), and a goal recalls the top-k shapes whose DESCRIPTIONS
 * match its meaning. This module keeps that index: one concept per described shape (concept.shape = "shape_description",
 * pointer {type: "shape_description", name}), its content the shape's description, so the existing search
 * (searchConcepts with shape = "shape_description", KNN over the content and summary embeddings) is the recall. Nothing
 * new is searched; only what is indexed is new.
 *
 * SOURCE: discovery's /registry/shape-descriptions, the one place descriptions live (vessel-advertised, and learned ones
 * written there by the minting path for shapes a template produces). An advertised shape with NO description is
 * unindexable: it is COUNTED and named in the result, never silently skipped (a recorded gap, not an omission).
 * CHANGE: a changed description is updated IN PLACE and re-embedded (writeConceptEmbeddings), so the concept's id, usage
 * and any learning keyed on it survive (a rotation of text is never a reset of learning).
 * RETIREMENT is SOFT: a shape discovery no longer describes (no live vessel lists it and no template produces it: the
 * foundation's "pruned when no resolver claims them") is excluded from recall, not deleted; described again, it is
 * restored on the same id with its history.
 * TRIGGERS: event-driven (the execution observer calls syncShapeIndex on vessel.registered / deregistered / expired and
 * template_created, debounced), with this upkeep activity's periodic run only as the backstop sweep.
 * PLACEMENT (law 11): each concept-db indexes the descriptions ITS discovery serves; on a spoke whose concept-db is the
 * hub's, the hub's index is the one recalled. SCOPE: shapes are fleet vocabulary, not tenant data, so the index is written
 * ONCE in the shared scope the concept table's PERMISSIONS already grant every org (scope 'global' AND public), and
 * recalled with searchConcepts({include_global: true}); retirement clears public, which takes it out of every org's recall.
 */

export const SHAPE_CONCEPT_SHAPE = "shape_description";

export interface IndexedShape { id: string; name: string; content: string; active: boolean }

export interface ShapeIndexDeps {
  /** shape -> description, as discovery serves it (claimed shapes only: a live vessel lists it, or a template produces it). */
  fetchDescriptions(orgId: string): Promise<Record<string, string>>;
  /** the advertised shape names (to count the undescribed ones). */
  fetchAdvertised(orgId: string): Promise<string[]>;
  listIndexed(orgId: string): Promise<IndexedShape[]>;
  create(orgId: string, name: string, content: string): Promise<string>;
  /** replace content IN PLACE (same id, so the concept's usage and any recall learning keyed on it survive), re-embedded */
  update(orgId: string, id: string, content: string): Promise<void>;
  /** soft state: an inactive shape concept is excluded from recall but keeps its id and history */
  setActive(orgId: string, id: string, active: boolean): Promise<void>;
}

export interface ShapeIndexResult {
  created: string[];
  reindexed: string[];
  /** retired shapes (soft: excluded from recall, history kept) */
  retired: string[];
  /** previously retired shapes that are described again: restored on the same id */
  restored: string[];
  unchanged: number;
  /** advertised shapes with no description: unindexable, recorded */
  undescribed: string[];
  /** indexed rows whose shape name could not be read back from their content (left untouched, never re-created) */
  unnamed?: number;
}

/** The indexed content for a shape: its name and description (the name is part of the meaning a goal may carry). */
export function indexedContent(name: string, description: string): string {
  return `${name}: ${description.trim()}`;
}
/** The shape name an indexed concept carries, read back from its content: the single reader of indexedContent's format
 *  (the name is NOT read from pointer.name: concept is SCHEMAFULL and `pointer` is a plain object, so SurrealDB drops its
 *  nested fields on write). null when the content is not in that format (counted by the caller, never re-created). */
export function indexedName(content: string | null | undefined): string | null {
  if (typeof content !== "string") return null;
  const i = content.indexOf(": ");
  if (i <= 0) return null;
  const name = content.slice(0, i);
  return /^[A-Za-z0-9_.:@-]+$/.test(name) && !name.includes(": ") ? name : null;
}

/** The indexed shapes for one org, through the given query function (the live deps pass the shared client).
 *  The name is read back from the content (indexedName, the single reader of indexedContent's format), not from
 *  pointer.name, which SCHEMAFULL drops on write. */
export async function listIndexedWith(query: (sql: string, params: Record<string, unknown>) => Promise<unknown[]>, orgId: string): Promise<IndexedShape[]> {
  const rows = (await query(
    // created_at is projected because SurrealDB requires an ORDER BY field in the selection (else: "Missing order idiom").
    'SELECT meta::id(id) AS id, pointer.name AS name, content, (public = true) AS active, created_at FROM concept WHERE shape = $shape AND org_id = $org_id ORDER BY created_at ASC',
    { shape: SHAPE_CONCEPT_SHAPE, org_id: orgId },
  )) as Array<IndexedShape & { created_at?: unknown }>;
  return rows.map((r) => ({ id: r.id, name: indexedName(r.content) ?? '', content: r.content, active: r.active }));
}

/**
 * Reconcile the index with discovery's descriptions for one org.
 * NEVER A RESET OF LEARNING: a shape keeps ONE concept for life. A changed description updates it in place (re-embedded);
 * a shape no longer claimed is RETIRED softly (excluded from recall); a retired shape described again is RESTORED on the
 * same id. Extra rows for one shape are deactivated, never deleted.
 */
export async function syncShapeIndex(orgId: string, deps: ShapeIndexDeps): Promise<ShapeIndexResult> {
  const descriptions = await deps.fetchDescriptions(orgId);
  const described = new Map(Object.entries(descriptions).filter(([k, v]) => k && typeof v === "string" && v.trim()));
  const advertised = await deps.fetchAdvertised(orgId).catch(() => [] as string[]);
  const indexed = await deps.listIndexed(orgId);
  const byName = new Map<string, IndexedShape[]>();
  const out: ShapeIndexResult = { created: [], reindexed: [], retired: [], restored: [], unchanged: 0, undescribed: [], unnamed: 0 };
  // A row whose name cannot be read back is COUNTED and left alone: never keyed as "missing", so never re-created
  // (a name that did not round-trip would otherwise re-create its shape on every cycle).
  for (const c of indexed) { if (!c.name) { out.unnamed!++; continue; } byName.set(c.name, [...(byName.get(c.name) ?? []), c]); }

  for (const [name, desc] of described) {
    const want = indexedContent(name, desc);
    const rows = byName.get(name) ?? [];
    if (rows.length === 0) { await deps.create(orgId, name, want); out.created.push(name); continue; }
    // the keeper: an active row first, then the oldest; every other row is deactivated (kept, not deleted)
    const keeper = rows.find((r) => r.active) ?? rows[0]!;
    for (const extra of rows) if (extra !== keeper && extra.active) await deps.setActive(orgId, extra.id, false);
    let touched = false;
    if (keeper.content !== want) { await deps.update(orgId, keeper.id, want); out.reindexed.push(name); touched = true; }
    if (!keeper.active) { await deps.setActive(orgId, keeper.id, true); out.restored.push(name); touched = true; }
    if (!touched) out.unchanged++;
  }
  for (const [name, rows] of byName) {
    if (described.has(name)) continue;
    const active = rows.filter((r) => r.active);
    if (active.length === 0) continue;
    for (const r of active) await deps.setActive(orgId, r.id, false);
    out.retired.push(name);
  }
  out.undescribed = advertised.filter((s) => !described.has(s)).sort();
  return out;
}

/** Event-driven trigger with a debounce: many registrations in a burst (a vessel restarting) become one sync. */
export function debouncedSync(run: () => Promise<unknown>, waitMs: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let again = false;
  const fire = async () => {
    timer = null;
    if (running) { again = true; return; }
    running = true;
    try { await run(); } catch { /* the sweep reports its own failures */ } finally {
      running = false;
      if (again) { again = false; timer = setTimeout(fire, waitMs); }
    }
  };
  return () => { if (timer) clearTimeout(timer); timer = setTimeout(fire, waitMs); };
}
