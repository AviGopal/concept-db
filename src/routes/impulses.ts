/**
 * Impulse Resolution Routes
 *
 * Implements `POST /v2/impulses/resolve` — the canonical entrypoint for
 * impulse resolution against concept-db. Dispatches by pointer shape to the
 * existing resolver modules (src/resolvers/*.ts), so this file is thin glue;
 * no business logic lives here.
 *
 * Advertised shapes (must match `config.discovery.shapes`):
 *   - concept            — a single concept, optionally with neighbors
 *   - conceptGraph       — full neighbor graph (concepts + edges) for a root
 *   - relatedConcepts    — graph-walk neighbors, filtered/sorted
 *   - conceptUsageStats  — aggregated usage stats for a concept
 *   - conceptSequence    — sequence neighbors (what typically comes next/before)
 *
 * Unknown shapes return 400 with a clear error listing the supported set.
 */

import { Hono } from 'hono';
import { getJwtAuthFromContext } from '../middleware/jwtAuth';
import { logger } from '../utils/logger';
import {
  resolveConcept,
  getNeighbors,
  getConceptById,
} from '../resolvers/concept';
import { getUsageStats } from '../resolvers/usage';
import { getSequenceNeighbors } from '../resolvers/sequence';
import type { EdgeType } from '../models/schemas';

const impulses = new Hono();

const SUPPORTED_SHAPES = [
  'concept',
  'conceptGraph',
  'relatedConcepts',
  'conceptUsageStats',
  'conceptSequence',
] as const;

interface ResolveResponse {
  content: unknown;
  metadata: Record<string, unknown>;
}

/**
 * Resolve an impulse pointer.
 *
 * Request body:
 *   { pointer: { type: <shape>, ...shape-specific fields } }
 *
 * Response (200):
 *   { content: <resolved data>, metadata: { shape, ... } }
 *
 * Response (400): unknown shape
 * Response (500): resolver error
 */
impulses.post('/resolve', async (c) => {
  const jwtAuth = getJwtAuthFromContext(c);
  const orgId = jwtAuth?.orgId || 'default';
  const jwtToken = jwtAuth?.jwtToken;

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const pointer = body?.pointer;
  if (!pointer || typeof pointer !== 'object') {
    return c.json({ error: 'Missing required field: pointer' }, 400);
  }

  const shape = pointer.type;
  if (typeof shape !== 'string') {
    return c.json({ error: 'Missing or invalid pointer.type' }, 400);
  }

  try {
    let result: ResolveResponse;

    switch (shape) {
      case 'concept': {
        if (!pointer.concept_id) {
          return c.json(
            { error: 'pointer.concept_id is required for shape "concept"' },
            400,
          );
        }
        const resolved = await resolveConcept(
          {
            concept_id: pointer.concept_id,
            include_neighbors: pointer.include_neighbors ?? false,
            neighbor_depth: pointer.neighbor_depth ?? 1,
          },
          orgId,
          jwtToken,
        );
        result = {
          content: resolved.concept.content,
          metadata: {
            shape: 'concept',
            concept_shape: resolved.concept.shape,
            summary: resolved.concept.summary,
            source_type: resolved.concept.source_type,
            token_estimate: resolved.concept.token_estimate,
            relevance: resolved.concept.relevance,
            neighbors: resolved.neighbors,
          },
        };
        break;
      }

      case 'conceptGraph': {
        if (!pointer.concept_id) {
          return c.json(
            { error: 'pointer.concept_id is required for shape "conceptGraph"' },
            400,
          );
        }
        const root = await getConceptById(pointer.concept_id, orgId, jwtToken);
        if (!root) {
          return c.json(
            { error: `Concept not found: ${pointer.concept_id}` },
            404,
          );
        }
        const edges = await getNeighbors(
          {
            concept_id: pointer.concept_id,
            direction: pointer.direction ?? 'both',
            edge_types: pointer.edge_types as EdgeType[] | undefined,
            limit: pointer.limit ?? 25,
          },
          orgId,
          jwtToken,
        );
        result = {
          content: {
            root,
            edges: edges.map((e) => ({
              edge: e.edge,
              neighbor: e.concept,
            })),
          },
          metadata: {
            shape: 'conceptGraph',
            root_id: pointer.concept_id,
            neighbor_count: edges.length,
          },
        };
        break;
      }

      case 'relatedConcepts': {
        if (!pointer.concept_id) {
          return c.json(
            { error: 'pointer.concept_id is required for shape "relatedConcepts"' },
            400,
          );
        }
        const related = await getNeighbors(
          {
            concept_id: pointer.concept_id,
            direction: pointer.direction ?? 'both',
            edge_types: pointer.edge_types as EdgeType[] | undefined,
            limit: pointer.limit ?? 10,
          },
          orgId,
          jwtToken,
        );
        result = {
          content: related.map((r) => ({
            concept_id: r.concept.id,
            shape: r.concept.shape,
            summary: r.concept.summary,
            relevance: r.concept.relevance,
            edge_type: r.edge.edge_type,
            edge_weight: r.edge.weight,
          })),
          metadata: {
            shape: 'relatedConcepts',
            root_id: pointer.concept_id,
            count: related.length,
          },
        };
        break;
      }

      case 'conceptUsageStats': {
        if (!pointer.concept_id) {
          return c.json(
            { error: 'pointer.concept_id is required for shape "conceptUsageStats"' },
            400,
          );
        }
        const stats = await getUsageStats(pointer.concept_id, jwtToken);
        result = {
          content: stats,
          metadata: {
            shape: 'conceptUsageStats',
            concept_id: pointer.concept_id,
          },
        };
        break;
      }

      case 'conceptSequence': {
        if (!pointer.concept_id) {
          return c.json(
            { error: 'pointer.concept_id is required for shape "conceptSequence"' },
            400,
          );
        }
        const neighbors = await getSequenceNeighbors(
          pointer.concept_id,
          pointer.direction ?? 'next',
          pointer.limit ?? 5,
          jwtToken,
        );
        result = {
          content: neighbors,
          metadata: {
            shape: 'conceptSequence',
            concept_id: pointer.concept_id,
            direction: pointer.direction ?? 'next',
            count: neighbors.length,
          },
        };
        break;
      }

      default:
        return c.json(
          {
            error: `Unknown impulse shape: "${shape}"`,
            supported_shapes: SUPPORTED_SHAPES,
          },
          400,
        );
    }

    return c.json(result);
  } catch (error) {
    const err = error as Error;
    logger.error('Impulse resolution failed', {
      shape,
      error: err.message,
    });
    return c.json(
      {
        error: 'Resolution failed',
        shape,
        message: err.message,
      },
      500,
    );
  }
});

export { impulses };
