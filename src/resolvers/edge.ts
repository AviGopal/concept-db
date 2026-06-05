/**
 * Edge Resolver
 *
 * Handles creation and management of edges between concepts.
 */

import { nanoid } from 'nanoid';
import { surrealDB, queryWithAuth } from '../db/surreal';
import { logger } from '../utils/logger';
import { lifecycleDispatcher } from '../lifecycle/dispatcher';
import { normalizeConceptId } from '../services/passive-usage';
import type { ConceptEdge, LinkConceptsRequest, EdgeType } from '../models/schemas';

/**
 * EMA smoothing factor used by `upsertEdge` when blending a newly observed
 * weight into an existing edge's weight. `alpha = 0.2` means each new
 * observation pulls the stored weight 20% toward the observed value, i.e.
 * `new_weight = 0.8 * old_weight + 0.2 * observed_weight`.
 */
export const EDGE_WEIGHT_EMA_ALPHA = 0.2;

export interface UpsertEdgeResult {
  id: string;
  created: boolean;
  previous_weight?: number;
  new_weight: number;
}

/**
 * Create an edge between two concepts.
 *
 * If `(from, to, edge_type)` already exists, the existing edge is returned
 * unchanged — this preserves the pre-existing "create if new" semantics for
 * callers that don't want EMA accumulation. Callers that want EMA on
 * repeated observations should use `upsertEdge` instead.
 */
export async function createEdge(
  request: LinkConceptsRequest,
  orgId: string,
  jwtToken?: string
): Promise<ConceptEdge> {
  const id = `edge_${nanoid(12)}`;
  // Normalize both endpoints at the resolver boundary so edges always point
  // to canonical concept records (e.g. "concept__SN64BnJ" not "_SN64BnJ").
  const fromId = normalizeConceptId(request.from_concept_id) ?? request.from_concept_id;
  const toId = normalizeConceptId(request.to_concept_id) ?? request.to_concept_id;

  const sql = `
    INSERT INTO concept_edge {
      id: type::thing("concept_edge", $id),
      from_concept: type::thing("concept", $from_concept_id),
      to_concept: type::thing("concept", $to_concept_id),
      edge_type: $edge_type,
      description: $description,
      weight: $weight,
      times_traversed: 0,
      org_id: $org_id
    }
  `;

  const params = {
    id,
    from_concept_id: fromId,
    to_concept_id: toId,
    edge_type: request.edge_type,
    description: request.description ?? undefined,
    weight: request.weight ?? 0.5,
    org_id: orgId,
  };

  const results = jwtToken
    ? await queryWithAuth<ConceptEdge>(jwtToken, sql, params)
    : await surrealDB.query<ConceptEdge>(sql, params);

  const edge = results[0];
  if (!edge) {
    throw new Error('Failed to create edge');
  }

  logger.info('Created edge', {
    id,
    from: request.from_concept_id,
    to: request.to_concept_id,
    type: request.edge_type,
  });

  // Emit lifecycle hook
  lifecycleDispatcher.emit('edge:created', {
    edge,
    orgId,
  });

  return edge;
}

/**
 * Upsert an edge between two concepts.
 *
 * Semantics:
 *   - If `(from, to, edge_type)` does not exist → create it with the given
 *     weight (default 0.5), times_traversed = 1, and the provided
 *     description. Return `{ created: true, new_weight }`.
 *   - If it already exists → apply EMA to the weight:
 *       `new_weight = (1 - alpha) * old_weight + alpha * observed_weight`
 *     with `alpha = EDGE_WEIGHT_EMA_ALPHA`. Increment `times_traversed` by 1.
 *     Replace `description` only when the call provides one. Return
 *     `{ created: false, previous_weight, new_weight }`.
 *
 * Used by the `learn-impulse-relationships` activity to accumulate
 * co-occurrence statistics between impulse-signature concepts.
 */
export async function upsertEdge(
  request: LinkConceptsRequest,
  orgId: string,
  jwtToken?: string,
): Promise<UpsertEdgeResult> {
  const observedWeight = request.weight ?? 0.5;
  // Normalize both endpoints at the resolver boundary so edges always point
  // to canonical concept records (e.g. "concept__SN64BnJ" not "_SN64BnJ").
  const fromId = normalizeConceptId(request.from_concept_id) ?? request.from_concept_id;
  const toId = normalizeConceptId(request.to_concept_id) ?? request.to_concept_id;

  // Look up existing edge (if any).
  const findSql = `
    SELECT id, weight FROM concept_edge
    WHERE from_concept = type::thing("concept", $from_id)
      AND to_concept = type::thing("concept", $to_id)
      AND edge_type = $edge_type
    LIMIT 1
  `;

  const existing = jwtToken
    ? await queryWithAuth<{ id: string; weight: number }>(jwtToken, findSql, {
        from_id: fromId,
        to_id: toId,
        edge_type: request.edge_type,
      })
    : await surrealDB.query<{ id: string; weight: number }>(findSql, {
        from_id: fromId,
        to_id: toId,
        edge_type: request.edge_type,
      });

  if (existing[0]) {
    const row = existing[0];
    const previousWeight = Number(row.weight);
    const newWeight =
      (1 - EDGE_WEIGHT_EMA_ALPHA) * previousWeight +
      EDGE_WEIGHT_EMA_ALPHA * observedWeight;

    const edgeRecordId = String(row.id).replace(/^concept_edge:/, '');

    const setClauses: string[] = [
      'weight = $weight',
      'times_traversed = times_traversed + 1',
    ];
    const params: Record<string, unknown> = {
      edge_id: edgeRecordId,
      weight: newWeight,
    };
    if (request.description !== undefined && request.description !== null) {
      setClauses.push('description = $description');
      params.description = request.description;
    }

    const updateSql = `UPDATE type::thing("concept_edge", $edge_id) SET ${setClauses.join(', ')}`;

    jwtToken
      ? await queryWithAuth(jwtToken, updateSql, params)
      : await surrealDB.query(updateSql, params);

    logger.info('Upserted edge (EMA applied)', {
      id: edgeRecordId,
      previous_weight: previousWeight,
      observed_weight: observedWeight,
      new_weight: newWeight,
    });

    return {
      id: edgeRecordId,
      created: false,
      previous_weight: previousWeight,
      new_weight: newWeight,
    };
  }

  // No existing edge — create with times_traversed=1 (the current observation).
  const id = `edge_${nanoid(12)}`;
  const createSql = `
    INSERT INTO concept_edge {
      id: type::thing("concept_edge", $id),
      from_concept: type::thing("concept", $from_concept_id),
      to_concept: type::thing("concept", $to_concept_id),
      edge_type: $edge_type,
      description: $description,
      weight: $weight,
      times_traversed: 1,
      org_id: $org_id
    }
  `;

  const createParams = {
    id,
    from_concept_id: fromId,
    to_concept_id: toId,
    edge_type: request.edge_type,
    description: request.description ?? undefined,
    weight: observedWeight,
    org_id: orgId,
  };

  const created = jwtToken
    ? await queryWithAuth<ConceptEdge>(jwtToken, createSql, createParams)
    : await surrealDB.query<ConceptEdge>(createSql, createParams);

  const edge = created[0];
  if (!edge) {
    throw new Error('Failed to upsert edge');
  }

  logger.info('Upserted edge (created)', {
    id,
    from: request.from_concept_id,
    to: request.to_concept_id,
    type: request.edge_type,
    weight: observedWeight,
  });

  lifecycleDispatcher.emit('edge:created', { edge, orgId });

  return { id, created: true, new_weight: observedWeight };
}

/**
 * Get edges for a concept
 */
export async function getEdgesForConcept(
  conceptId: string,
  direction: 'outgoing' | 'incoming' | 'both' = 'both',
  edgeTypes?: EdgeType[],
  jwtToken?: string
): Promise<ConceptEdge[]> {
  const params: Record<string, unknown> = { concept_id: conceptId };
  const conditions: string[] = [];

  if (direction === 'outgoing') {
    conditions.push('from_concept = type::thing("concept", $concept_id)');
  } else if (direction === 'incoming') {
    conditions.push('to_concept = type::thing("concept", $concept_id)');
  } else {
    conditions.push('(from_concept = type::thing("concept", $concept_id) OR to_concept = type::thing("concept", $concept_id))');
  }

  if (edgeTypes && edgeTypes.length > 0) {
    conditions.push('edge_type IN $edge_types');
    params.edge_types = edgeTypes;
  }

  const sql = `SELECT * FROM concept_edge WHERE ${conditions.join(' AND ')}`;

  return jwtToken
    ? await queryWithAuth<ConceptEdge>(jwtToken, sql, params)
    : await surrealDB.query<ConceptEdge>(sql, params);
}

/**
 * Update edge weight
 */
export async function updateEdgeWeight(
  edgeId: string,
  weight: number,
  jwtToken?: string
): Promise<ConceptEdge> {
  const sql = `UPDATE type::thing("concept_edge", $edge_id) SET weight = $weight`;
  const results = jwtToken
    ? await queryWithAuth<ConceptEdge>(jwtToken, sql, { edge_id: edgeId, weight })
    : await surrealDB.query<ConceptEdge>(sql, { edge_id: edgeId, weight });

  const updated = results[0];
  if (!updated) {
    throw new Error(`Failed to update edge: ${edgeId}`);
  }

  return updated;
}

/**
 * Increment edge traversal count
 */
export async function incrementTraversal(
  edgeId: string,
  jwtToken?: string
): Promise<void> {
  const sql = `UPDATE type::thing("concept_edge", $edge_id) SET times_traversed = times_traversed + 1`;
  jwtToken
    ? await queryWithAuth(jwtToken, sql, { edge_id: edgeId })
    : await surrealDB.query(sql, { edge_id: edgeId });
}

/**
 * Delete an edge
 */
export async function deleteEdge(
  edgeId: string,
  jwtToken?: string
): Promise<void> {
  const sql = `DELETE type::thing("concept_edge", $edge_id)`;
  jwtToken
    ? await queryWithAuth(jwtToken, sql, { edge_id: edgeId })
    : await surrealDB.query(sql, { edge_id: edgeId });

  logger.info('Deleted edge', { id: edgeId });
}

/**
 * Get co-occurrence edges over impulse-signature concepts.
 *
 * Signature concepts have `source_type = 'impulse_signature'` and carry
 * `pointer.type = <pointer_type>` plus `shape = <shape>`. This query joins
 * `concept_edge` rows whose endpoints are both signature concepts and returns
 * the edge plus both signature tuples. Results are scoped to `orgId`.
 *
 * Filters:
 *   - pointerType/shape: if provided, keep only edges where at least one
 *     endpoint matches the signature (either `from` or `to` side).
 *   - minWeight: keep edges whose weight is >= minWeight.
 *   - limit: default 100, ordered by weight DESC.
 */
export async function getImpulseCooccurrenceEdges(
  params: {
    pointerType?: string;
    shape?: string;
    minWeight?: number;
    limit?: number;
    orgId: string;
  },
  jwtToken?: string,
): Promise<
  Array<{
    from_signature: { pointer_type: string; shape: string };
    to_signature: { pointer_type: string; shape: string };
    edge_type: string;
    weight: number;
    times_traversed: number;
  }>
> {
  const limit = params.limit ?? 100;
  const queryParams: Record<string, unknown> = {
    org_id: params.orgId,
    limit,
  };

  const conditions: string[] = [
    "from_concept.source_type = 'impulse_signature'",
    "to_concept.source_type = 'impulse_signature'",
    'org_id = $org_id',
  ];

  if (params.minWeight !== undefined) {
    conditions.push('weight >= $min_weight');
    queryParams.min_weight = params.minWeight;
  }

  if (params.pointerType !== undefined && params.shape !== undefined) {
    conditions.push(
      '((from_concept.pointer.type = $pointer_type AND from_concept.shape = $sig_shape)' +
        ' OR (to_concept.pointer.type = $pointer_type AND to_concept.shape = $sig_shape))',
    );
    queryParams.pointer_type = params.pointerType;
    queryParams.sig_shape = params.shape;
  } else if (params.pointerType !== undefined) {
    conditions.push(
      '(from_concept.pointer.type = $pointer_type OR to_concept.pointer.type = $pointer_type)',
    );
    queryParams.pointer_type = params.pointerType;
  } else if (params.shape !== undefined) {
    conditions.push(
      '(from_concept.shape = $sig_shape OR to_concept.shape = $sig_shape)',
    );
    queryParams.sig_shape = params.shape;
  }

  const sql = `
    SELECT
      from_concept.pointer.type AS from_pointer_type,
      from_concept.shape        AS from_shape,
      to_concept.pointer.type   AS to_pointer_type,
      to_concept.shape          AS to_shape,
      edge_type,
      weight,
      times_traversed
    FROM concept_edge
    WHERE ${conditions.join(' AND ')}
    ORDER BY weight DESC
    LIMIT $limit
  `;

  type Row = {
    from_pointer_type: string;
    from_shape: string;
    to_pointer_type: string;
    to_shape: string;
    edge_type: string;
    weight: number;
    times_traversed: number;
  };

  const rows = jwtToken
    ? await queryWithAuth<Row>(jwtToken, sql, queryParams)
    : await surrealDB.query<Row>(sql, queryParams);

  return rows.map((r) => ({
    from_signature: { pointer_type: r.from_pointer_type, shape: r.from_shape },
    to_signature: { pointer_type: r.to_pointer_type, shape: r.to_shape },
    edge_type: r.edge_type,
    weight: Number(r.weight),
    times_traversed: Number(r.times_traversed),
  }));
}

/**
 * Check if an edge exists between two concepts
 */
export async function edgeExists(
  fromConceptId: string,
  toConceptId: string,
  edgeType: EdgeType,
  jwtToken?: string
): Promise<boolean> {
  const sql = `
    SELECT count() as cnt FROM concept_edge
    WHERE from_concept = type::thing("concept", $from_id)
      AND to_concept = type::thing("concept", $to_id)
      AND edge_type = $edge_type
    GROUP ALL
  `;

  const results = jwtToken
    ? await queryWithAuth<{ cnt: number }>(jwtToken, sql, {
        from_id: fromConceptId,
        to_id: toConceptId,
        edge_type: edgeType,
      })
    : await surrealDB.query<{ cnt: number }>(sql, {
        from_id: fromConceptId,
        to_id: toConceptId,
        edge_type: edgeType,
      });

  return (results[0]?.cnt || 0) > 0;
}
