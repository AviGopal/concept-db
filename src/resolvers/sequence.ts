/**
 * Sequence Resolver
 *
 * Creates sequence edges between concepts that were resolved together.
 * This enables learning temporal patterns in concept usage.
 */

import { surrealDB, queryWithAuth } from '../db/surreal';
import { logger } from '../utils/logger';
import { createEdge, edgeExists } from './edge';
import type { RecordSequenceRequest, ConceptEdge } from '../models/schemas';

/**
 * Record a sequence of concepts and create sequence edges
 */
export async function recordSequence(
  request: RecordSequenceRequest,
  orgId: string,
  jwtToken?: string
): Promise<{ edges_created: number; edges_skipped: number }> {
  const { concept_ids, trace_id } = request;

  if (concept_ids.length < 2) {
    throw new Error('Sequence must contain at least 2 concepts');
  }

  let edgesCreated = 0;
  let edgesSkipped = 0;

  // Create sequence_next edges between consecutive concepts
  for (let i = 0; i < concept_ids.length - 1; i++) {
    const fromId = concept_ids[i];
    const toId = concept_ids[i + 1];

    // Check if edge already exists
    const exists = await edgeExists(fromId, toId, 'sequence_next', jwtToken);

    if (exists) {
      // Increment weight on existing edge (more frequently seen sequences get higher weight)
      await incrementSequenceWeight(fromId, toId, jwtToken);
      edgesSkipped++;
    } else {
      // Create new sequence edge
      await createEdge(
        {
          from_concept_id: fromId,
          to_concept_id: toId,
          edge_type: 'sequence_next',
          description: `Sequence from trace ${trace_id}`,
          weight: 0.5,
        },
        orgId,
        jwtToken
      );
      edgesCreated++;
    }
  }

  logger.info('Recorded concept sequence', {
    trace_id,
    sequence_length: concept_ids.length,
    edges_created: edgesCreated,
    edges_skipped: edgesSkipped,
  });

  return { edges_created: edgesCreated, edges_skipped: edgesSkipped };
}

/**
 * Increment weight on existing sequence edge
 * Uses EMA: new_weight = old_weight * 0.9 + 0.1
 * This gradually increases weight for frequently traversed sequences
 */
async function incrementSequenceWeight(
  fromConceptId: string,
  toConceptId: string,
  jwtToken?: string
): Promise<void> {
  const sql = `
    UPDATE concept_edge SET
      weight = math::min(1.0, weight * 0.9 + 0.1),
      times_traversed = times_traversed + 1
    WHERE from_concept = type::record("concept", $from_id)
      AND to_concept = type::record("concept", $to_id)
      AND edge_type = 'sequence_next'
  `;

  jwtToken
    ? await queryWithAuth(jwtToken, sql, { from_id: fromConceptId, to_id: toConceptId })
    : await surrealDB.query(sql, { from_id: fromConceptId, to_id: toConceptId });
}

/**
 * Get sequence neighbors for a concept (what typically comes next/before)
 */
export async function getSequenceNeighbors(
  conceptId: string,
  direction: 'next' | 'prev' | 'both' = 'next',
  limit: number = 5,
  jwtToken?: string
): Promise<{
  concept_id: string;
  weight: number;
  times_traversed: number;
}[]> {
  const conditions: string[] = [];

  if (direction === 'next' || direction === 'both') {
    conditions.push(`(from_concept = type::record("concept", $concept_id) AND edge_type = 'sequence_next')`);
  }
  if (direction === 'prev' || direction === 'both') {
    conditions.push(`(to_concept = type::record("concept", $concept_id) AND edge_type = 'sequence_next')`);
  }

  const sql = `
    SELECT
      IF(from_concept = type::record("concept", $concept_id), to_concept, from_concept) AS neighbor_id,
      weight,
      times_traversed
    FROM concept_edge
    WHERE ${conditions.join(' OR ')}
    ORDER BY weight DESC, times_traversed DESC
    LIMIT $limit
  `;

  const results = jwtToken
    ? await queryWithAuth<{ neighbor_id: string; weight: number; times_traversed: number }>(
        jwtToken, sql, { concept_id: conceptId, limit }
      )
    : await surrealDB.query<{ neighbor_id: string; weight: number; times_traversed: number }>(
        sql, { concept_id: conceptId, limit }
      );

  return results.map(r => ({
    concept_id: String(r.neighbor_id).replace(/^concept:/, ''),
    weight: r.weight,
    times_traversed: r.times_traversed,
  }));
}

/**
 * Find common sequences starting from a concept
 */
export async function findCommonSequences(
  startConceptId: string,
  maxDepth: number = 3,
  minWeight: number = 0.6,
  jwtToken?: string
): Promise<string[][]> {
  // BFS to find high-weight sequences
  const sequences: string[][] = [];
  const queue: { path: string[]; currentId: string }[] = [
    { path: [startConceptId], currentId: startConceptId }
  ];

  while (queue.length > 0) {
    const { path, currentId } = queue.shift()!;

    if (path.length >= maxDepth + 1) {
      sequences.push(path);
      continue;
    }

    const neighbors = await getSequenceNeighbors(currentId, 'next', 5, jwtToken);
    const highWeightNeighbors = neighbors.filter(n => n.weight >= minWeight);

    if (highWeightNeighbors.length === 0) {
      // End of sequence
      if (path.length > 1) {
        sequences.push(path);
      }
    } else {
      for (const neighbor of highWeightNeighbors) {
        // Avoid cycles
        if (!path.includes(neighbor.concept_id)) {
          queue.push({
            path: [...path, neighbor.concept_id],
            currentId: neighbor.concept_id,
          });
        }
      }
    }
  }

  return sequences;
}
