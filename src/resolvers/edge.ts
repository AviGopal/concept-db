/**
 * Edge Resolver
 *
 * Handles creation and management of edges between concepts.
 */

import { nanoid } from 'nanoid';
import { surrealDB, queryWithAuth } from '../db/surreal';
import { logger } from '../utils/logger';
import { lifecycleDispatcher } from '../lifecycle/dispatcher';
import type { ConceptEdge, LinkConceptsRequest, EdgeType } from '../models/schemas';

/**
 * Create an edge between two concepts
 */
export async function createEdge(
  request: LinkConceptsRequest,
  orgId: string,
  jwtToken?: string
): Promise<ConceptEdge> {
  const id = `edge_${nanoid(12)}`;

  const sql = `
    CREATE type::record("concept_edge", $id) SET
      id = $id,
      from_concept = type::record("concept", $from_concept_id),
      to_concept = type::record("concept", $to_concept_id),
      edge_type = $edge_type,
      description = $description,
      weight = $weight,
      times_traversed = 0,
      org_id = $org_id
  `;

  const params = {
    id,
    from_concept_id: request.from_concept_id,
    to_concept_id: request.to_concept_id,
    edge_type: request.edge_type,
    description: request.description || null,
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
    conditions.push('from_concept = type::record("concept", $concept_id)');
  } else if (direction === 'incoming') {
    conditions.push('to_concept = type::record("concept", $concept_id)');
  } else {
    conditions.push('(from_concept = type::record("concept", $concept_id) OR to_concept = type::record("concept", $concept_id))');
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
  const sql = `UPDATE type::record("concept_edge", $edge_id) SET weight = $weight`;
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
  const sql = `UPDATE type::record("concept_edge", $edge_id) SET times_traversed = times_traversed + 1`;
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
  const sql = `DELETE type::record("concept_edge", $edge_id)`;
  jwtToken
    ? await queryWithAuth(jwtToken, sql, { edge_id: edgeId })
    : await surrealDB.query(sql, { edge_id: edgeId });

  logger.info('Deleted edge', { id: edgeId });
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
    WHERE from_concept = type::record("concept", $from_id)
      AND to_concept = type::record("concept", $to_id)
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
