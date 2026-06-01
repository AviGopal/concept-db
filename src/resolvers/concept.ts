/**
 * Concept Resolver
 *
 * Handles concept CRUD operations and resolution with snapshots.
 * Resolution creates a snapshot capturing the state at resolution time.
 */

import { nanoid } from 'nanoid';
import { surrealDB, queryWithAuth } from '../db/surreal';
import { logger } from '../utils/logger';
import { lifecycleDispatcher } from '../lifecycle/dispatcher';
import { embeddingService } from '../services/embedding';
import { mergeByRRF } from '../utils/rrf';
import { normalizeConceptId } from '../services/passive-usage';
import type {
  Concept,
  CreateConceptRequest,
  ResolveConceptRequest,
  SearchConceptsRequest,
  GetNeighborsRequest,
  ConceptEdge,
  SourceType,
} from '../models/schemas';

/**
 * Infer shape from source type if not provided
 */
function inferShape(sourceType: SourceType, explicitShape?: string): string {
  if (explicitShape) return explicitShape;

  const shapeMap: Record<SourceType, string> = {
    goal: 'goal',
    memo: 'memo',
    human_input: 'user_request',
    search: 'search_result',
    llm: 'llm_response',
    metabob_annotation: 'code_annotation',
    write: 'file_content',
    read: 'file_content',
    cpg_embedding: 'code_pattern',
    extracted: 'extracted_data',
    impulse_signature: 'impulse_signature',
  };

  return shapeMap[sourceType] || 'unknown';
}

/**
 * Estimate token count for content
 */
function estimateTokens(content: string): number {
  // Rough estimate: ~4 characters per token
  return Math.ceil(content.length / 4);
}

/**
 * Compute content hash
 */
async function computeHash(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/**
 * Create a new concept
 */
export async function createConcept(
  request: CreateConceptRequest,
  orgId: string,
  jwtToken?: string
): Promise<Concept> {
  const id = `concept_${nanoid(12)}`;
  const shape = inferShape(request.source_type, request.shape);
  const tokenEstimate = estimateTokens(request.content);

  // Prefer caller-supplied pointer (preserves path/section/etc); fall back to
  // the legacy synthesized envelope so existing callers that pass `metadata`
  // continue to work unchanged.
  const pointer = request.pointer
    ? { ...request.pointer, ...(request.metadata ? { metadata: { ...((request.pointer as { metadata?: Record<string, unknown> }).metadata ?? {}), ...request.metadata } } : {}) }
    : {
        type: 'memo',
        metadata: request.metadata || {},
      };

  const params: Record<string, unknown> = {
    id,
    pointer,
    shape,
    summary: request.summary || request.content.slice(0, 200),
    content: request.content,
    token_estimate: tokenEstimate,
    budget: request.budget || 2000,
    source_type: request.source_type,
    priority: request.priority || 0.5,
    relevance: 0.5,
    scope: request.scope || 'org',
    public: request.public || false,
    org_id: orgId,
  };

  // Only add project_id if it's provided
  const projectIdClause = request.project_id
    ? ', project_id = $project_id'
    : '';
  if (request.project_id) {
    params.project_id = request.project_id;
  }

  const sql = `
    CREATE type::thing("concept", $id) SET
      id = $id,
      pointer = $pointer,
      shape = $shape,
      summary = $summary,
      content = $content,
      token_estimate = $token_estimate,
      budget = $budget,
      source_type = $source_type,
      priority = $priority,
      relevance = $relevance,
      times_loaded = 0,
      times_succeeded = 0,
      times_failed = 0,
      resolution_snapshot = NONE,
      scope = $scope,
      public = $public,
      org_id = $org_id${projectIdClause}
  `;

  const results = jwtToken
    ? await queryWithAuth<Concept>(jwtToken, sql, params)
    : await surrealDB.query<Concept>(sql, params);

  const created = results[0];
  if (!created) {
    throw new Error('Failed to create concept');
  }

  logger.info('Created concept', { id, shape, source_type: request.source_type, org_id: orgId });

  // Emit lifecycle hook
  lifecycleDispatcher.emit('concept:created', {
    concept: created,
    orgId,
  });

  // Fire-and-forget: generate dense embeddings for the new concept
  Promise.resolve().then(async () => {
    if (!embeddingService.isReady()) return;
    try {
      const updates: Record<string, unknown> = {};
      if (request.content) {
        const vec = await embeddingService.embed(request.content.slice(0, 2000));
        updates.content_embedding = Array.from(vec);
      }
      const summaryText = request.summary || request.content?.slice(0, 200);
      if (summaryText) {
        const vec = await embeddingService.embed(summaryText);
        updates.summary_embedding = Array.from(vec);
      }
      if (Object.keys(updates).length === 0) return;
      const setClause = Object.keys(updates).map((k) => `${k} = $${k}`).join(', ');
      await surrealDB.query(
        `UPDATE type::thing("concept", $id) SET ${setClause}`,
        { id, ...updates }
      );
      logger.debug('[embedding] Wrote embeddings for new concept', { id });
    } catch (err) {
      logger.warn('[embedding] Failed to write embeddings for new concept', {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }).catch(() => { /* swallow */ });

  return created;
}

/**
 * Resolve a concept and create resolution snapshot
 */
export async function resolveConcept(
  request: ResolveConceptRequest,
  orgId: string,
  jwtToken?: string
): Promise<{ concept: Concept; neighbors?: Concept[] }> {
  // Normalize id so callers may pass any of: `X`, `concept_X`,
  // `concept:concept_X`, or `concept:⟨concept_X⟩`. The downstream
  // `type::thing("concept", $id)` requires the bare canonical
  // `concept_<nanoid>` form; otherwise the lookup misses and yields
  // a spurious "Concept not found" / wrapped-null response.
  const normalizedId = normalizeConceptId(request.concept_id) ?? request.concept_id;

  // Fetch the concept
  const fetchSql = `SELECT * FROM type::thing("concept", $concept_id)`;
  const concepts = jwtToken
    ? await queryWithAuth<Concept>(jwtToken, fetchSql, { concept_id: normalizedId })
    : await surrealDB.query<Concept>(fetchSql, { concept_id: normalizedId });

  const concept = concepts[0];
  if (!concept) {
    throw new Error(`Concept not found: ${request.concept_id}`);
  }

  // Get neighbor IDs - query concept_edge table directly
  const outgoingSql = `SELECT to_concept FROM concept_edge WHERE from_concept = type::thing("concept", $concept_id)`;
  const incomingSql = `SELECT from_concept FROM concept_edge WHERE to_concept = type::thing("concept", $concept_id)`;

  const [outgoingResults, incomingResults] = await Promise.all([
    jwtToken
      ? queryWithAuth<{ to_concept: string }>(jwtToken, outgoingSql, { concept_id: normalizedId })
      : surrealDB.query<{ to_concept: string }>(outgoingSql, { concept_id: normalizedId }),
    jwtToken
      ? queryWithAuth<{ from_concept: string }>(jwtToken, incomingSql, { concept_id: normalizedId })
      : surrealDB.query<{ from_concept: string }>(incomingSql, { concept_id: normalizedId }),
  ]);

  const neighborIds = [
    ...outgoingResults.map(r => String(r.to_concept).replace(/^concept:/, '')),
    ...incomingResults.map(r => String(r.from_concept).replace(/^concept:/, '')),
  ];

  // Create resolution snapshot
  const contentHash = concept.content ? await computeHash(concept.content) : '';
  const resolutionSnapshot = {
    resolved_at: new Date().toISOString(),
    content_hash: contentHash,
    neighbor_ids: neighborIds,
    token_count: concept.token_estimate || 0,
  };

  // Update concept with snapshot and increment times_loaded
  const updateSql = `
    UPDATE type::thing("concept", $concept_id) SET
      resolution_snapshot = $snapshot,
      times_loaded = times_loaded + 1
  `;

  const updateResults = jwtToken
    ? await queryWithAuth<Concept>(jwtToken, updateSql, {
        concept_id: normalizedId,
        snapshot: resolutionSnapshot,
      })
    : await surrealDB.query<Concept>(updateSql, {
        concept_id: normalizedId,
        snapshot: resolutionSnapshot,
      });

  const resolved = updateResults[0] || { ...concept, resolution_snapshot: resolutionSnapshot };

  logger.info('Resolved concept', {
    id: request.concept_id,
    neighbor_count: neighborIds.length,
    times_loaded: resolved.times_loaded,
  });

  // Emit lifecycle hook
  lifecycleDispatcher.emit('concept:resolved', {
    concept: resolved,
    snapshot: resolutionSnapshot,
    orgId,
  });

  // Fetch neighbors if requested
  let neighbors: Concept[] | undefined;
  if (request.include_neighbors && neighborIds.length > 0) {
    const neighborFetchSql = `SELECT * FROM concept WHERE id IN $ids`;
    neighbors = jwtToken
      ? await queryWithAuth<Concept>(jwtToken, neighborFetchSql, { ids: neighborIds })
      : await surrealDB.query<Concept>(neighborFetchSql, { ids: neighborIds });
  }

  return { concept: resolved, neighbors };
}

/**
 * Search for concepts
 *
 * When `request.query` is non-empty:
 * - Runs BM25 full-text search (idx_concept_content_fts / idx_concept_summary_fts)
 * - If LocalEmbeddingService is ready, also runs dense cosine search
 * - Results merged via Reciprocal Rank Fusion (k=60) when both succeed
 * - Falls back to BM25-only when model is not loaded
 *
 * When `request.query` is absent the original scalar-filter path is preserved,
 * ordered by relevance DESC, created_at DESC.
 */
export async function searchConcepts(
  request: SearchConceptsRequest,
  orgId: string,
  jwtToken?: string,
  _decayWeights?: Map<string, number>
): Promise<Concept[]> {
  const limit = request.limit || 20;
  const offset = request.offset || 0;

  const params: Record<string, unknown> = {
    org_id: orgId,
    limit,
    offset,
  };

  // Scalar filters shared by both code paths
  const scalarConditions: string[] = [];

  if (request.shape) {
    scalarConditions.push('shape = $shape');
    params.shape = request.shape;
  }

  if (request.source_type) {
    // F26: source_type may be a single value or an array (per F26 schema
    // extension). Use IN for arrays of >1, equality for single values.
    if (Array.isArray(request.source_type)) {
      if (request.source_type.length === 1) {
        scalarConditions.push('source_type = $source_type');
        params.source_type = request.source_type[0];
      } else if (request.source_type.length > 1) {
        scalarConditions.push('source_type IN $source_types');
        params.source_types = request.source_type;
      }
    } else {
      scalarConditions.push('source_type = $source_type');
      params.source_type = request.source_type;
    }
  }

  if (request.min_relevance !== undefined) {
    scalarConditions.push('relevance >= $min_relevance');
    params.min_relevance = request.min_relevance;
  }

  if (!request.query) {
    // Scalar-only path (no query term) — unchanged behaviour
    const allConditions = ['org_id = $org_id', ...scalarConditions];
    const whereClause = `WHERE ${allConditions.join(' AND ')}`;
    const sql = `
      SELECT * FROM concept
      ${whereClause}
      ORDER BY relevance DESC, created_at DESC
      LIMIT $limit
      START $offset
    `;
    const results = jwtToken
      ? await queryWithAuth<Concept>(jwtToken, sql, params)
      : await surrealDB.query<Concept>(sql, params);
    return results;
  }

  // --------------------------------------------------------------------------
  // Full-text search (BM25) path
  // --------------------------------------------------------------------------
  params.query = request.query;

  const scalarWhere =
    scalarConditions.length > 0
      ? ` AND ${scalarConditions.join(' AND ')}`
      : '';

  // Fetch more than `limit` so RRF has enough candidates from both lists.
  const fetchLimit = Math.max(limit * 3, 60);
  const ftsParams = { ...params, limit: fetchLimit, offset: 0 };

  // SurrealDB 3.x: search::score(N) does not work when the search term is a
  // bound parameter ($query). With bound params, the planner reports "no MATCHES
  // clause found in WHERE condition" regardless of clause ordering. The term must
  // be inlined as a string literal. We sanitize the term (strip quotes, limit
  // length) before interpolation to prevent injection through the SurrealDB
  // query layer (access is already auth-gated at the HTTP level).
  //
  // Two separate queries (one per field) because OR'd @@ expressions also fail.
  //   Query A (content, weight 1×): search::score(0) references the single @@
  //   Query B (summary, weight 2×): search::score(0) references the single @@
  const safeQueryTerm = request.query
    .replace(/['"\\]/g, ' ')  // strip quotes and backslashes
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);           // cap length

  const contentSql = `
    SELECT *, search::score(0) AS fts_score
    FROM concept
    WHERE content @@ '${safeQueryTerm}' AND org_id = $org_id${scalarWhere}
    ORDER BY fts_score DESC
    LIMIT $limit
    START $offset
  `;

  const summarySql = `
    SELECT *, search::score(0) AS fts_score
    FROM concept
    WHERE summary @@ '${safeQueryTerm}' AND org_id = $org_id${scalarWhere}
    ORDER BY fts_score DESC
    LIMIT $limit
    START $offset
  `;

  // Drop the 'query' key — it is now inlined in the SQL literal, not bound.
  const { query: _discardedQuery, ...ftsOnlyParams } = ftsParams as typeof ftsParams & { query?: string };

  const runQuery = (sql: string): Promise<Concept[]> =>
    (jwtToken
      ? queryWithAuth<Concept>(jwtToken, sql, ftsOnlyParams)
      : surrealDB.query<Concept>(sql, ftsOnlyParams)
    ).catch((err) => {
      logger.warn('[searchConcepts] BM25 query failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [] as Concept[];
    });

  const [contentRaw, summaryRaw, denseResults] = await Promise.all([
    runQuery(contentSql),
    runQuery(summarySql),
    searchConceptsByDense(request.query, orgId, scalarConditions, params, fetchLimit, jwtToken),
  ]);

  // Merge content and summary BM25 results: summary matches weighted 2×.
  // Deduplicate by ID, combining scores for concepts that match both fields.
  const normId = (c: Concept) => String(c.id).replace(/^concept:/, '');
  const scoreMap = new Map<string, { concept: Concept; score: number }>();

  for (const c of contentRaw as any[]) {
    const id = normId(c as Concept);
    const existing = scoreMap.get(id);
    const s = Number((c as any).fts_score ?? 0);
    if (existing) {
      existing.score += s;
    } else {
      scoreMap.set(id, { concept: { ...c, fts_score: s }, score: s });
    }
  }

  for (const c of summaryRaw as any[]) {
    const id = normId(c as Concept);
    const existing = scoreMap.get(id);
    const s = Number((c as any).fts_score ?? 0) * 2.0;
    if (existing) {
      existing.score += s;
      (existing.concept as any).fts_score = existing.score;
    } else {
      scoreMap.set(id, { concept: { ...c, fts_score: s }, score: s });
    }
  }

  // SurrealDB 3.0 known issue: BM25 IDF statistics are computed in-memory during
  // index writes but are not persisted to disk. After a server restart or when
  // queried via a fresh connection, search::score(N) returns 0.0 for all rows even
  // though the @@ operator still matches correctly. REBUILD INDEX re-indexes the
  // text but does not restore the in-memory IDF state.
  //
  // Workaround: detect the all-zeros case and substitute a term-frequency proxy
  // score computed in TypeScript. The proxy counts occurrences of each query token
  // in the content (weight 1×) and summary (weight 2×), normalised by document
  // length to approximate TF. This gives meaningful ordering when BM25 IDF is
  // unavailable while preserving the real BM25 scores whenever they are non-zero.
  const allScoresZero =
    scoreMap.size > 0 && Array.from(scoreMap.values()).every(e => e.score === 0);

  if (allScoresZero) {
    logger.warn(
      '[searchConcepts] BM25 scores all zero (SurrealDB 3.0 IDF not persisted) — ' +
      'applying term-frequency proxy ranking',
      { term: safeQueryTerm, matchCount: scoreMap.size },
    );

    const tokens = safeQueryTerm
      .toLowerCase()
      .split(/\s+/)
      .filter(t => t.length > 1);

    const countOccurrences = (text: string | null | undefined, tokens: string[]): number => {
      if (!text) return 0;
      const lower = text.toLowerCase();
      let count = 0;
      for (const token of tokens) {
        let idx = 0;
        while ((idx = lower.indexOf(token, idx)) !== -1) {
          count++;
          idx += token.length;
        }
      }
      return count;
    };

    for (const [id, entry] of scoreMap) {
      const c = entry.concept as any;
      const contentLen = Math.max(1, String(c.content ?? '').length);
      const summaryLen = Math.max(1, String(c.summary ?? '').length);
      const contentTf = countOccurrences(c.content, tokens) / contentLen * 1000;
      const summaryTf = countOccurrences(c.summary, tokens) / summaryLen * 1000 * 2.0;
      const proxyScore = contentTf + summaryTf;
      entry.score = proxyScore;
      c.fts_score = proxyScore;
      scoreMap.set(id, entry);
    }
  }

  const ftsRaw = Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .map((e) => e.concept)
    .slice(0, fetchLimit);

  const ftsResults: (Concept & { id: string })[] = (ftsRaw as any[]).map((c) => ({
    ...c,
    id: normId(c as Concept),
  }));
  const denseNorm: (Concept & { id: string })[] = denseResults.map((c) => ({
    ...c,
    id: normId(c),
  }));

  let merged: (Concept & { id: string })[];
  if (denseNorm.length > 0) {
    merged = mergeByRRF(ftsResults, denseNorm);
    logger.info('[searchConcepts] RRF hybrid merge', {
      ftsCount: ftsResults.length,
      denseCount: denseNorm.length,
      mergedCount: merged.length,
    });
  } else {
    merged = ftsResults;
  }

  // Apply original offset + limit to merged list
  return merged.slice(offset, offset + limit);
}

/**
 * Dense semantic search for concepts using LocalEmbeddingService.
 * Returns empty array when model is not ready.
 */
async function searchConceptsByDense(
  query: string,
  orgId: string,
  scalarConditions: string[],
  scalarParams: Record<string, unknown>,
  limit: number,
  jwtToken?: string
): Promise<Concept[]> {
  if (!embeddingService.isReady()) return [];

  let queryVec: Float32Array;
  try {
    queryVec = await embeddingService.embed(query);
  } catch (err) {
    logger.warn('[searchConceptsByDense] embed failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  try {
    const whereClauses = [
      'org_id = $org_id',
      '(content_embedding IS NOT NONE OR summary_embedding IS NOT NONE)',
      ...scalarConditions,
    ];
    const candidateSql = `
      SELECT *, content_embedding, summary_embedding
      FROM concept
      WHERE ${whereClauses.join(' AND ')}
    `;

    const rows: any[] = jwtToken
      ? await queryWithAuth<any>(jwtToken, candidateSql, scalarParams)
      : await surrealDB.query<any>(candidateSql, scalarParams);

    if (!rows || rows.length === 0) return [];

    // Score in-process
    const cosine = (a: Float32Array, b: number[]): number => {
      let dot = 0;
      for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
      return dot;
    };

    const scored = rows
      .map((row) => {
        let score = 0;
        if (row.content_embedding?.length === 384) {
          score = Math.max(score, cosine(queryVec, row.content_embedding));
        }
        if (row.summary_embedding?.length === 384) {
          score = Math.max(score, cosine(queryVec, row.summary_embedding));
        }
        return { ...row, _dense_score: score };
      })
      .sort((a, b) => b._dense_score - a._dense_score)
      .slice(0, limit);

    logger.debug('[searchConceptsByDense] completed', {
      candidateCount: rows.length,
      resultCount: scored.length,
      topScore: scored[0]?._dense_score ?? null,
    });

    return scored as Concept[];
  } catch (err) {
    logger.warn('[searchConceptsByDense] query failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Get neighbors of a concept
 */
export async function getNeighbors(
  request: GetNeighborsRequest,
  orgId: string,
  jwtToken?: string
): Promise<{ concept: Concept; edge: ConceptEdge }[]> {
  const { concept_id, direction = 'both', edge_types, limit = 10 } = request;

  const params: Record<string, unknown> = {
    concept_id,
    limit,
  };

  let edgeTypeFilter = '';
  if (edge_types && edge_types.length > 0) {
    edgeTypeFilter = 'AND edge_type IN $edge_types';
    params.edge_types = edge_types;
  }

  // SurrealDB doesn't support SQL UNION; assemble a single SELECT with the
  // appropriate WHERE clause and project `neighbor_id` as the opposite endpoint.
  // For direction=both we compute neighbor_id via a conditional expression.
  let whereClause: string;
  let neighborProjection: string;
  if (direction === 'outgoing') {
    whereClause = `from_concept = type::thing("concept", $concept_id)`;
    neighborProjection = 'to_concept AS neighbor_id';
  } else if (direction === 'incoming') {
    whereClause = `to_concept = type::thing("concept", $concept_id)`;
    neighborProjection = 'from_concept AS neighbor_id';
  } else {
    // both — pick neighbor_id as whichever endpoint isn't the caller's concept
    whereClause = `(from_concept = type::thing("concept", $concept_id) OR to_concept = type::thing("concept", $concept_id))`;
    neighborProjection =
      `(IF from_concept = type::thing("concept", $concept_id) THEN to_concept ELSE from_concept END) AS neighbor_id`;
  }

  const sql = `
    SELECT ${neighborProjection}, * FROM concept_edge
    WHERE ${whereClause} ${edgeTypeFilter}
    LIMIT $limit
  `;

  const edges = jwtToken
    ? await queryWithAuth<ConceptEdge & { neighbor_id: string }>(jwtToken, sql, params)
    : await surrealDB.query<ConceptEdge & { neighbor_id: string }>(sql, params);

  // Fetch the actual neighbor concepts
  const neighborIds = edges.map(e => String(e.neighbor_id).replace(/^concept:/, ''));
  if (neighborIds.length === 0) {
    return [];
  }

  // `id` on concept is a record link; equality against a plain string never matches.
  // Compare via meta::id() so the bare ids from neighborIds line up.
  const conceptsSql = `SELECT * FROM concept WHERE meta::id(id) IN $ids`;
  const concepts = jwtToken
    ? await queryWithAuth<Concept>(jwtToken, conceptsSql, { ids: neighborIds })
    : await surrealDB.query<Concept>(conceptsSql, { ids: neighborIds });

  // Key the map by bare id (stripped of the "concept:" prefix and any wrapping)
  const conceptMap = new Map(concepts.map(c => [String(c.id).replace(/^concept:/, '').replace(/^⟨|⟩$/g, ''), c]));

  const result: { concept: Concept; edge: ConceptEdge }[] = [];

  for (const edge of edges) {
    const neighborId = String(edge.neighbor_id).replace(/^concept:/, '').replace(/^⟨|⟩$/g, '');
    const concept = conceptMap.get(neighborId);
    if (concept) {
      // Extract just the ConceptEdge fields, excluding neighbor_id
      const { neighbor_id: _, ...edgeOnly } = edge;
      result.push({ concept, edge: edgeOnly as ConceptEdge });
    }
  }

  return result;
}

/**
 * Get a concept by ID
 */
export async function getConceptById(
  conceptId: string,
  orgId: string,
  jwtToken?: string
): Promise<Concept | null> {
  // Normalize at the resolver boundary — accept any of `X`, `concept_X`,
  // `concept:concept_X`, `concept:⟨concept_X⟩`. See normalizeConceptId.
  const id = normalizeConceptId(conceptId) ?? conceptId;
  const sql = `SELECT * FROM type::thing("concept", $concept_id)`;
  const results = jwtToken
    ? await queryWithAuth<Concept>(jwtToken, sql, { concept_id: id })
    : await surrealDB.query<Concept>(sql, { concept_id: id });

  return results[0] || null;
}

/**
 * Idempotent upsert of a concept keyed on a (pointer_type, shape) impulse
 * signature. Used by the `learn-impulse-relationships` activity to materialise
 * one concept per unique impulse signature seen in traces. Subsequent calls
 * with the same signature return the existing concept with `created: false`.
 *
 * The query filters on (source_type='impulse_signature', pointer.type=pointerType,
 * shape=shape, org_id=orgId). Signatures are scoped per-org; there is no
 * global/public signature concept in v1.
 */
export async function upsertBySignature(
  params: { pointerType: string; shape: string; orgId: string },
  jwtToken?: string,
): Promise<{ id: string; created: boolean }> {
  const { pointerType, shape, orgId } = params;

  const findSql = `
    SELECT id FROM concept
    WHERE source_type = 'impulse_signature'
      AND pointer.type = $pointer_type
      AND shape = $shape
      AND org_id = $org_id
    LIMIT 1
  `;

  const existing = jwtToken
    ? await queryWithAuth<{ id: string }>(jwtToken, findSql, {
        pointer_type: pointerType,
        shape,
        org_id: orgId,
      })
    : await surrealDB.query<{ id: string }>(findSql, {
        pointer_type: pointerType,
        shape,
        org_id: orgId,
      });

  if (existing[0]?.id) {
    return { id: String(existing[0].id).replace(/^concept:/, ''), created: false };
  }

  const id = `concept_${nanoid(12)}`;
  const summary = `\`${pointerType}:${shape}\` impulse signature`;
  const pointer = {
    type: pointerType,
    metadata: { signature_shape: shape },
  };

  const createSql = `
    CREATE type::thing("concept", $id) SET
      id = $id,
      pointer = $pointer,
      shape = $shape,
      summary = $summary,
      content = NONE,
      token_estimate = 0,
      budget = 500,
      source_type = 'impulse_signature',
      priority = 0.5,
      relevance = 0.5,
      times_loaded = 0,
      times_succeeded = 0,
      times_failed = 0,
      resolution_snapshot = NONE,
      scope = 'org',
      public = false,
      org_id = $org_id
  `;

  const createParams = {
    id,
    pointer,
    shape,
    summary,
    org_id: orgId,
  };

  const created = jwtToken
    ? await queryWithAuth<Concept>(jwtToken, createSql, createParams)
    : await surrealDB.query<Concept>(createSql, createParams);

  const createdRow = created[0];
  if (!createdRow) {
    throw new Error('Failed to upsert impulse_signature concept');
  }

  logger.info('Upserted impulse_signature concept', {
    id,
    pointer_type: pointerType,
    shape,
    org_id: orgId,
  });

  lifecycleDispatcher.emit('concept:created', {
    concept: createdRow,
    orgId,
  });

  return { id, created: true };
}

/**
 * Update concept fields
 */
export async function updateConcept(
  conceptId: string,
  updates: Partial<Pick<Concept, 'summary' | 'content' | 'priority' | 'relevance' | 'budget'>>,
  orgId: string,
  jwtToken?: string
): Promise<Concept> {
  const setClauses: string[] = [];
  const params: Record<string, unknown> = { concept_id: conceptId };

  if (updates.summary !== undefined) {
    setClauses.push('summary = $summary');
    params.summary = updates.summary;
  }
  if (updates.content !== undefined) {
    setClauses.push('content = $content');
    setClauses.push('token_estimate = $token_estimate');
    params.content = updates.content;
    params.token_estimate = updates.content ? estimateTokens(updates.content) : 0;
  }
  if (updates.priority !== undefined) {
    setClauses.push('priority = $priority');
    params.priority = updates.priority;
  }
  if (updates.relevance !== undefined) {
    setClauses.push('relevance = $relevance');
    params.relevance = updates.relevance;
  }
  if (updates.budget !== undefined) {
    setClauses.push('budget = $budget');
    params.budget = updates.budget;
  }

  if (setClauses.length === 0) {
    const existing = await getConceptById(conceptId, orgId, jwtToken);
    if (!existing) throw new Error(`Concept not found: ${conceptId}`);
    return existing;
  }

  const sql = `UPDATE type::thing("concept", $concept_id) SET ${setClauses.join(', ')}`;
  const results = jwtToken
    ? await queryWithAuth<Concept>(jwtToken, sql, params)
    : await surrealDB.query<Concept>(sql, params);

  const updated = results[0];
  if (!updated) {
    throw new Error(`Failed to update concept: ${conceptId}`);
  }

  // Emit lifecycle hook
  lifecycleDispatcher.emit('concept:updated', {
    concept: updated,
    updates,
    orgId,
  });

  return updated;
}
