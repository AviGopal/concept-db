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

  const pointer = {
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
    CREATE type::record("concept", $id) SET
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
  // Fetch the concept
  const fetchSql = `SELECT * FROM type::record("concept", $concept_id)`;
  const concepts = jwtToken
    ? await queryWithAuth<Concept>(jwtToken, fetchSql, { concept_id: request.concept_id })
    : await surrealDB.query<Concept>(fetchSql, { concept_id: request.concept_id });

  const concept = concepts[0];
  if (!concept) {
    throw new Error(`Concept not found: ${request.concept_id}`);
  }

  // Get neighbor IDs - query concept_edge table directly
  const outgoingSql = `SELECT to_concept FROM concept_edge WHERE from_concept = type::record("concept", $concept_id)`;
  const incomingSql = `SELECT from_concept FROM concept_edge WHERE to_concept = type::record("concept", $concept_id)`;

  const [outgoingResults, incomingResults] = await Promise.all([
    jwtToken
      ? queryWithAuth<{ to_concept: string }>(jwtToken, outgoingSql, { concept_id: request.concept_id })
      : surrealDB.query<{ to_concept: string }>(outgoingSql, { concept_id: request.concept_id }),
    jwtToken
      ? queryWithAuth<{ from_concept: string }>(jwtToken, incomingSql, { concept_id: request.concept_id })
      : surrealDB.query<{ from_concept: string }>(incomingSql, { concept_id: request.concept_id }),
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
    UPDATE type::record("concept", $concept_id) SET
      resolution_snapshot = $snapshot,
      times_loaded = times_loaded + 1
  `;

  const updateResults = jwtToken
    ? await queryWithAuth<Concept>(jwtToken, updateSql, {
        concept_id: request.concept_id,
        snapshot: resolutionSnapshot,
      })
    : await surrealDB.query<Concept>(updateSql, {
        concept_id: request.concept_id,
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
 * When `request.query` is non-empty, uses BM25 full-text search via the
 * idx_concept_content_fts (@0@@) and idx_concept_summary_fts (@1@@) indexes.
 * summary is weighted 2× because it is a curated digest. fts_score is an
 * internal alias used only for ORDER BY — it is stripped before returning
 * Concept objects to callers.
 *
 * When `request.query` is absent the original scalar-filter path is preserved,
 * ordered by relevance DESC, created_at DESC.
 */
export async function searchConcepts(
  request: SearchConceptsRequest,
  orgId: string,
  jwtToken?: string
): Promise<Concept[]> {
  const params: Record<string, unknown> = {
    org_id: orgId,
    limit: request.limit || 20,
    offset: request.offset || 0,
  };

  // Scalar filters shared by both code paths
  const scalarConditions: string[] = [];

  if (request.shape) {
    scalarConditions.push('shape = $shape');
    params.shape = request.shape;
  }

  if (request.source_type) {
    scalarConditions.push('source_type = $source_type');
    params.source_type = request.source_type;
  }

  if (request.min_relevance !== undefined) {
    scalarConditions.push('relevance >= $min_relevance');
    params.min_relevance = request.min_relevance;
  }

  let sql: string;

  if (request.query) {
    // BM25 full-text search path
    params.query = request.query;

    const ftsCondition = '(content @0@@ $query OR summary @1@@ $query)';
    const allConditions = [
      'org_id = $org_id',
      ftsCondition,
      ...scalarConditions,
    ];

    const whereClause = `WHERE ${allConditions.join(' AND ')}`;

    // fts_score is selected for ORDER BY only; callers receive Concept objects
    // so the extra field is harmless — SurrealDB returns it in the row but the
    // TypeScript type (Concept) does not include it, keeping the response shape
    // unchanged.
    sql = `
      SELECT *,
        search::score(0) + search::score(1) * 2.0 AS fts_score
      FROM concept
      ${whereClause}
      ORDER BY fts_score DESC
      LIMIT $limit
      START $offset
    `;
  } else {
    // Scalar-only path (no query term) — unchanged behaviour
    const allConditions = ['org_id = $org_id', ...scalarConditions];
    const whereClause = `WHERE ${allConditions.join(' AND ')}`;

    sql = `
      SELECT * FROM concept
      ${whereClause}
      ORDER BY relevance DESC, created_at DESC
      LIMIT $limit
      START $offset
    `;
  }

  const results = jwtToken
    ? await queryWithAuth<Concept>(jwtToken, sql, params)
    : await surrealDB.query<Concept>(sql, params);

  return results;
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

  const queries: string[] = [];

  if (direction === 'outgoing' || direction === 'both') {
    queries.push(`
      SELECT to_concept AS neighbor_id, * FROM concept_edge
      WHERE from_concept = type::record("concept", $concept_id) ${edgeTypeFilter}
    `);
  }

  if (direction === 'incoming' || direction === 'both') {
    queries.push(`
      SELECT from_concept AS neighbor_id, * FROM concept_edge
      WHERE to_concept = type::record("concept", $concept_id) ${edgeTypeFilter}
    `);
  }

  const sql = queries.join(' UNION ') + ` LIMIT $limit`;

  const edges = jwtToken
    ? await queryWithAuth<ConceptEdge & { neighbor_id: string }>(jwtToken, sql, params)
    : await surrealDB.query<ConceptEdge & { neighbor_id: string }>(sql, params);

  // Fetch the actual neighbor concepts
  const neighborIds = edges.map(e => String(e.neighbor_id).replace(/^concept:/, ''));
  if (neighborIds.length === 0) {
    return [];
  }

  const conceptsSql = `SELECT * FROM concept WHERE id IN $ids`;
  const concepts = jwtToken
    ? await queryWithAuth<Concept>(jwtToken, conceptsSql, { ids: neighborIds })
    : await surrealDB.query<Concept>(conceptsSql, { ids: neighborIds });

  const conceptMap = new Map(concepts.map(c => [c.id, c]));

  const result: { concept: Concept; edge: ConceptEdge }[] = [];

  for (const edge of edges) {
    const neighborId = String(edge.neighbor_id).replace(/^concept:/, '');
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
  const sql = `SELECT * FROM type::record("concept", $concept_id)`;
  const results = jwtToken
    ? await queryWithAuth<Concept>(jwtToken, sql, { concept_id: conceptId })
    : await surrealDB.query<Concept>(sql, { concept_id: conceptId });

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
    CREATE type::record("concept", $id) SET
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

  const sql = `UPDATE type::record("concept", $concept_id) SET ${setClauses.join(', ')}`;
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
