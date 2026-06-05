#!/usr/bin/env bun
/**
 * Migration: fix concept_edge records with denormalized concept IDs.
 *
 * Before fix fa62a2d, edges were created with bare nanoid IDs (e.g.
 * `_SN64BnJ_NMc`) passed directly to type::record("concept", $id).
 * That produced edge records whose from_concept / to_concept pointed to
 * `concept:_SN64BnJ_NMc` — a non-existent record.  The actual concept
 * was stored as `concept:concept__SN64BnJ_NMc` (with the canonical
 * `concept_` prefix).
 *
 * This migration:
 *   1. Queries all concept_edge records.
 *   2. For each edge, checks whether from_concept and to_concept resolve
 *      to real concepts (i.e. the concept record exists).
 *   3. For any endpoint that does NOT resolve: tries adding the
 *      `concept_` prefix to the bare id and checks if THAT resolves.
 *   4. If yes: UPDATE the edge to use the corrected record reference.
 *   5. Reports counts: fixed / not-fixable / already-correct.
 *
 * Run inside the substrate container:
 *   docker exec substrate-live bash -c "
 *     cd /vessels/concept-db
 *     SURREALDB_URL=http://127.0.0.1:8000 \
 *     SURREALDB_USERNAME=root \
 *     SURREALDB_PASSWORD=... \
 *     SURREALDB_NAMESPACE=activity-system \
 *     SURREALDB_DATABASE=learning_loop \
 *     bun run scripts/migrate-edge-ids.ts
 *   "
 */

import { Surreal } from 'surrealdb';

const SURREAL_URL = process.env.SURREALDB_URL || 'http://localhost:8000';
const SURREAL_NS = process.env.SURREALDB_NAMESPACE || 'activity-system';
const SURREAL_DB = process.env.SURREALDB_DATABASE || 'learning_loop';
const SURREAL_USER = process.env.SURREALDB_USERNAME || 'root';
const SURREAL_PASS = process.env.SURREALDB_PASSWORD || 'changeme';

// Batch size for SELECT pagination — avoids loading the full table at once.
const BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// HTTP SQL helper — used for UPDATE statements because the SurrealDB JS
// client v2.x rejects `UPDATE <record_id> SET …` syntax that the HTTP /sql
// endpoint accepts fine.
// ---------------------------------------------------------------------------

async function httpSql(sql: string): Promise<unknown[]> {
  const creds = btoa(`${SURREAL_USER}:${SURREAL_PASS}`);
  const resp = await fetch(`${SURREAL_URL}/sql`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'text/plain',
      'Authorization': `Basic ${creds}`,
      'surreal-ns': SURREAL_NS,
      'surreal-db': SURREAL_DB,
    },
    body: sql,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP SQL failed (${resp.status}): ${text}`);
  }
  const json = await resp.json() as Array<{ status: string; result: unknown; time: string }>;
  // Each statement returns one entry; return the result of the first.
  if (!Array.isArray(json) || json.length === 0) return [];
  const first = json[0];
  if (first.status !== 'OK') {
    throw new Error(`SurrealDB query error: ${String(first.result)}`);
  }
  return Array.isArray(first.result) ? first.result as unknown[] : [first.result];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip SurrealDB unicode angle-bracket wrapping (`⟨…⟩`) from an id string.
 * These are added by SurrealDB when serialising record ids that contain
 * non-alphanumeric characters.
 */
function stripBrackets(s: string): string {
  return s.replace(/^⟨|⟩$/g, '');
}

/**
 * Normalize a concept id that came from meta::id(from_concept) /
 * meta::id(to_concept).
 *
 * SurrealDB's meta::id() strips the table name and may wrap special chars.
 * After stripping brackets, canonical ids start with `concept_`. If the
 * bare id does NOT start with `concept_` we prepend it.
 *
 * Returns null if rawId is empty or not a string.
 */
function normalizeConceptId(rawId: unknown): string | null {
  if (typeof rawId !== 'string' || rawId.length === 0) return null;
  const s = stripBrackets(rawId);
  if (s.length === 0) return null;
  return s.startsWith('concept_') ? s : `concept_${s}`;
}

/**
 * Execute a SurrealDB query and return rows from the first result set.
 */
async function query<T = unknown>(
  db: Surreal,
  sql: string,
  params?: Record<string, unknown>,
): Promise<T[]> {
  const result = await db.query(sql, params);
  const first = Array.isArray(result) && result.length > 0 ? result[0] : [];
  return first as T[];
}

// ---------------------------------------------------------------------------
// Main migration
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== migrate-edge-ids: normalise concept_edge record references ===\n');
  console.log(`  SurrealDB : ${SURREAL_URL}`);
  console.log(`  Namespace : ${SURREAL_NS}`);
  console.log(`  Database  : ${SURREAL_DB}\n`);

  const db = new Surreal();

  try {
    await db.connect(SURREAL_URL);
    await db.signin({ username: SURREAL_USER, password: SURREAL_PASS });
    await db.use({ namespace: SURREAL_NS, database: SURREAL_DB });
    console.log('Connected to SurrealDB.\n');
  } catch (err) {
    console.error('Failed to connect:', (err as Error).message);
    process.exit(1);
  }

  // ------------------------------------------------------------------
  // Step 1: build a set of all real concept ids for O(1) lookup.
  //
  // We use meta::id(id) which returns the raw id portion after stripping
  // the table name. For ids with special chars SurrealDB wraps them in
  // ⟨…⟩; we strip that too.
  // ------------------------------------------------------------------
  console.log('Loading all concept IDs…');

  const allConceptIds = new Set<string>();
  let conceptOffset = 0;
  while (true) {
    const batch = await query<{ raw_id: string }>(
      db,
      'SELECT meta::id(id) AS raw_id FROM concept LIMIT $limit START $offset',
      { limit: BATCH_SIZE, offset: conceptOffset },
    );
    if (batch.length === 0) break;
    for (const row of batch) {
      if (row.raw_id) allConceptIds.add(stripBrackets(String(row.raw_id)));
    }
    conceptOffset += batch.length;
    if (batch.length < BATCH_SIZE) break;
  }
  console.log(`  Found ${allConceptIds.size} concept records.\n`);

  // ------------------------------------------------------------------
  // Step 2: iterate all concept_edge records and collect those with
  //         non-normalized endpoint IDs.
  //
  // We pull: the full SurrealDB record id (for UPDATE targeting), plus
  // meta::id(from_concept) and meta::id(to_concept) so we can inspect
  // the stored concept record ids without table-prefix noise.
  // ------------------------------------------------------------------
  console.log('Scanning concept_edge records…');

  type EdgeRow = { full_id: string; from_raw: string; to_raw: string };

  let totalEdges = 0;
  let alreadyCorrect = 0;
  let fixed = 0;
  let notFixable = 0;

  let edgeOffset = 0;
  while (true) {
    const edges = await query<EdgeRow>(
      db,
      // full_id = the complete SurrealDB record reference string, e.g.
      //   "concept_edge:⟨edge_-0LGwvJEDuNL⟩"
      // We use string::concat to reconstruct it so we can pass it back
      // to UPDATE … (where id = $full_id) without going through
      // type::record() which would double-encode the id.
      `SELECT
         string::concat("concept_edge:", string::concat(meta::tb(id), ":")) AS _unused,
         id AS full_id,
         meta::id(from_concept) AS from_raw,
         meta::id(to_concept)   AS to_raw
       FROM concept_edge
       LIMIT $limit START $offset`,
      { limit: BATCH_SIZE, offset: edgeOffset },
    );

    if (edges.length === 0) break;
    totalEdges += edges.length;

    for (const edge of edges) {
      // full_id from the JS client comes back as a SurrealDB RecordId object
      // in surrealdb 2.x.  Coerce to string; the client serialises it as
      // "concept_edge:⟨edge_…⟩" or "concept_edge:edge_…".
      const fullId = String(edge.full_id);
      const fromRaw = stripBrackets(String(edge.from_raw ?? ''));
      const toRaw = stripBrackets(String(edge.to_raw ?? ''));

      // Check which endpoints already point to real concepts.
      const fromOk = allConceptIds.has(fromRaw);
      const toOk = allConceptIds.has(toRaw);

      if (fromOk && toOk) {
        alreadyCorrect++;
        continue;
      }

      // Try normalizing broken endpoints.
      const fixedFromId = fromOk ? fromRaw : normalizeConceptId(fromRaw);
      const fixedToId = toOk ? toRaw : normalizeConceptId(toRaw);

      // Verify fixed candidates actually exist.
      const fixedFromOk = fromOk || (fixedFromId !== null && allConceptIds.has(fixedFromId));
      const fixedToOk = toOk || (fixedToId !== null && allConceptIds.has(fixedToId));

      if (!fixedFromOk || !fixedToOk) {
        const parts: string[] = [`  NOT FIXABLE  edge ${fullId}:`];
        if (!fromOk) {
          parts.push(`    from="${fromRaw}"  candidate="${fixedFromId}"  found=${fixedFromOk}`);
        }
        if (!toOk) {
          parts.push(`    to  ="${toRaw}"  candidate="${fixedToId}"  found=${fixedToOk}`);
        }
        console.warn(parts.join('\n'));
        notFixable++;
        continue;
      }

      // Build UPDATE via the HTTP /sql endpoint.
      //
      // We use `UPDATE <record_id> SET …` with literal SurrealDB record
      // references. The JS client v2.x rejects this syntax, but the HTTP
      // /sql endpoint in SurrealDB 3.x handles it fine.
      //
      // Edge ids may contain special chars (dashes, underscores) so we wrap
      // them in ⟨…⟩ inside the record reference literal to avoid parse
      // errors. Concept ids also may contain specials, so same treatment.
      //
      // We use type::thing("concept", "<id>") which is the alias for
      // type::record in SurrealDB 3.x and works over HTTP.

      const wrapId = (id: string) =>
        /^[A-Za-z0-9_]+$/.test(id) ? id : `⟨${id}⟩`;

      const setClauses: string[] = [];

      if (!fromOk) {
        setClauses.push(`from_concept = type::thing("concept", "${fixedFromId}")`);
      }
      if (!toOk) {
        setClauses.push(`to_concept = type::thing("concept", "${fixedToId}")`);
      }

      // Reconstruct the full record id for the UPDATE target.
      // full_id is a RecordId object from the JS client; coerce to string
      // then parse out table and id parts.
      const fullIdStr = String(edge.full_id); // "concept_edge:edge_..." or "concept_edge:⟨edge_...⟩"
      const colonIdx = fullIdStr.indexOf(':');
      const edgeIdPart = colonIdx >= 0 ? fullIdStr.slice(colonIdx + 1) : fullIdStr;
      // edgeIdPart may be "edge_XXX" or "⟨edge_XXX⟩"
      const edgeIdBare = stripBrackets(edgeIdPart);
      const edgeIdWrapped = wrapId(edgeIdBare);

      try {
        await httpSql(
          `UPDATE concept_edge:${edgeIdWrapped} SET ${setClauses.join(', ')}`,
        );
        const lines = [`  FIXED  ${fullId}:`];
        if (!fromOk) lines.push(`    from  "${fromRaw}"  →  concept:${fixedFromId}`);
        if (!toOk)   lines.push(`    to    "${toRaw}"  →  concept:${fixedToId}`);
        console.log(lines.join('\n'));
        fixed++;
      } catch (err) {
        console.error(`  ERROR  ${fullId}: ${(err as Error).message}`);
        notFixable++;
      }
    }

    edgeOffset += edges.length;
    if (edges.length < BATCH_SIZE) break;
  }

  // ------------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------------
  console.log('\n=== Migration complete ===');
  console.log(`  Total edges scanned : ${totalEdges}`);
  console.log(`  Already correct     : ${alreadyCorrect}`);
  console.log(`  Fixed               : ${fixed}`);
  console.log(`  Not fixable         : ${notFixable}`);

  await db.close();
  process.exit(notFixable > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
