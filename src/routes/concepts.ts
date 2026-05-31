/**
 * Concept REST Routes
 *
 * REST API endpoints for direct concept operations (in addition to MCP tools).
 */

import { Hono } from 'hono';
import { getJwtAuthFromContext } from '../middleware/jwtAuth';
import { logger } from '../utils/logger';
import { config } from '../config';
import {
  createConcept,
  resolveConcept,
  searchConcepts,
  getNeighbors,
  getConceptById,
  updateConcept,
  upsertBySignature,
} from '../resolvers/concept';
import { createEdge, getEdgesForConcept } from '../resolvers/edge';
import { recordUsage, getUsageHistory, getUsageStats } from '../resolvers/usage';
import { recordSequence, getSequenceNeighbors } from '../resolvers/sequence';
import { recordPassiveUsageForResults, normalizeConceptId } from '../services/passive-usage';
import type { Concept } from '../models/schemas';
import { createConceptFromSource } from '../sources/unified';
import {
  CreateConceptRequestSchema,
  ResolveConceptRequestSchema,
  SearchConceptsRequestSchema,
  GetNeighborsRequestSchema,
  LinkConceptsRequestSchema,
  RecordUsageRequestSchema,
  RecordSequenceRequestSchema,
} from '../models/schemas';

const concepts = new Hono();

/**
 * Create a concept
 * POST /concepts
 */
concepts.post('/', async (c) => {
  const jwtAuth = getJwtAuthFromContext(c);

  if (config.auth.requireAuth && !jwtAuth) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const orgId = jwtAuth?.orgId || 'default';

  try {
    const body = await c.req.json();
    const request = CreateConceptRequestSchema.parse(body);
    const concept = await createConcept(request, orgId, jwtAuth?.jwtToken);
    return c.json(concept, 201);
  } catch (error) {
    const err = error as Error;
    logger.error('Failed to create concept', { error: err.message });
    return c.json({ error: err.message }, 400);
  }
});

/**
 * Create concept from source (unified handler)
 * POST /concepts/from-source
 */
concepts.post('/from-source', async (c) => {
  const jwtAuth = getJwtAuthFromContext(c);

  if (config.auth.requireAuth && !jwtAuth) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const orgId = jwtAuth?.orgId || 'default';

  try {
    const body = await c.req.json();
    const concept = await createConceptFromSource(body, orgId, jwtAuth?.jwtToken);
    return c.json(concept, 201);
  } catch (error) {
    const err = error as Error;
    logger.error('Failed to create concept from source', { error: err.message });
    return c.json({ error: err.message }, 400);
  }
});

/**
 * Search concepts
 * GET /concepts/search
 *
 * Forge resolvers query this endpoint to look up vessel-construction and
 * impulse-activity concepts when scaffolding a new vessel. The query convention
 * is:
 *
 *   GET /concepts/search?source_type=vessel_construction_pattern&shape=typescript_vessel_template
 *   GET /concepts/search?source_type=vessel_construction_pattern&shape=vessel_discovery_probe
 *   GET /concepts/search?source_type=vessel_construction_pattern&shape=vessel_auth_blueprint
 *
 * These shape values correspond to the tag metadata written by the
 * `extract-concepts-from-docs` activity when seeding from
 * `docs/architecture/TYPESCRIPT_VESSEL_TEMPLATE.md` (tagPrefix=vessel-construction).
 * The `shape` query param filters on the concept's `shape` field, which is
 * derived from `source_type` in `createConceptFromSource` or set explicitly
 * in `metadata.tag` by the forge seeding workflow.
 *
 * For impulse-activity concepts (tagPrefix=impulse-activity), use:
 *   GET /concepts/search?source_type=impulse_activity_pattern&shape=impulse_activity_foundation
 */
concepts.get('/search', async (c) => {
  const jwtAuth = getJwtAuthFromContext(c);

  if (config.auth.requireAuth && !jwtAuth) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const orgId = jwtAuth?.orgId || 'default';

  try {
    const query = c.req.query('query');
    const shape = c.req.query('shape');
    const sourceType = c.req.query('source_type');
    const minRelevance = c.req.query('min_relevance');
    const limit = c.req.query('limit');
    const offset = c.req.query('offset');

    // F26: split comma-separated source_type into an array. Single value
    // (no comma) passes through unchanged; multiple values become an array.
    const parsedSourceType = sourceType?.includes(',')
      ? sourceType.split(',').map((s) => s.trim()).filter(Boolean)
      : sourceType;

    const request = SearchConceptsRequestSchema.parse({
      query,
      shape,
      source_type: parsedSourceType,
      min_relevance: minRelevance ? parseFloat(minRelevance) : undefined,
      limit: limit ? parseInt(limit) : undefined,
      offset: offset ? parseInt(offset) : undefined,
    });

    const results = await searchConcepts(request, orgId, jwtAuth?.jwtToken);
    // Passive load event: every surfaced concept was loaded into the
    // consumer's reasoning context. Fire-and-forget; never blocks the
    // response. See `services/passive-usage.ts` for rationale.
    recordPassiveUsageForResults('rest_search', results, orgId, jwtAuth?.jwtToken);

    // F27 (2026-05-30): strip embedding vectors from REST responses by
    // default. Each 384-dim float vector serializes to ~8KB; concepts carry
    // both content_embedding and summary_embedding (~16KB/concept). With a
    // limit of 15 this added ~240KB of pure noise per response, which the
    // drafter chain (draft-gap-closing-activity) blew up to 200K+ LLM tokens
    // via {{prime_substrate_concepts_text}} interpolation in two prompts.
    // Embeddings are only meaningful for similarity math (already executed
    // server-side); no REST consumer needs them. Set `embeddings=1` to opt in.
    const includeEmbeddings = c.req.query('embeddings') === '1';
    const projected = includeEmbeddings
      ? results
      : results.map((r) => {
          const { content_embedding: _ce, summary_embedding: _se, ...rest } = r as Concept & {
            content_embedding?: unknown;
            summary_embedding?: unknown;
          };
          return rest;
        });
    return c.json({ concepts: projected, count: projected.length });
  } catch (error) {
    const err = error as Error;
    logger.error('Search failed', { error: err.message });
    return c.json({ error: err.message }, 400);
  }
});

/**
 * Idempotently upsert a concept keyed on an impulse signature.
 * POST /concepts/upsert-by-signature
 *
 * Body: { pointer_type: string, shape: string }
 * Response: { id: string, created: boolean }
 */
concepts.post('/upsert-by-signature', async (c) => {
  const jwtAuth = getJwtAuthFromContext(c);

  if (config.auth.requireAuth && !jwtAuth) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const orgId = jwtAuth?.orgId || 'default';

  let body: { pointer_type?: unknown; shape?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const pointerType = body?.pointer_type;
  const shape = body?.shape;

  if (typeof pointerType !== 'string' || typeof shape !== 'string') {
    return c.json(
      { error: 'pointer_type and shape are required (string)' },
      400,
    );
  }

  try {
    const result = await upsertBySignature(
      { pointerType, shape, orgId },
      jwtAuth?.jwtToken,
    );
    return c.json(result, result.created ? 201 : 200);
  } catch (error) {
    const err = error as Error;
    logger.error('Failed to upsert impulse_signature concept', {
      error: err.message,
    });
    return c.json({ error: err.message }, 400);
  }
});

/**
 * Get concept by ID
 * GET /concepts/:id
 */
concepts.get('/:id', async (c) => {
  const jwtAuth = getJwtAuthFromContext(c);

  if (config.auth.requireAuth && !jwtAuth) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const orgId = jwtAuth?.orgId || 'default';
  const conceptId = normalizeConceptId(c.req.param('id')) ?? c.req.param('id');

  try {
    const concept = await getConceptById(conceptId, orgId, jwtAuth?.jwtToken);
    if (!concept) {
      return c.json({ error: 'Concept not found' }, 404);
    }
    return c.json(concept);
  } catch (error) {
    const err = error as Error;
    logger.error('Failed to get concept', { error: err.message });
    return c.json({ error: err.message }, 400);
  }
});

/**
 * Resolve concept
 * POST /concepts/:id/resolve
 */
concepts.post('/:id/resolve', async (c) => {
  const jwtAuth = getJwtAuthFromContext(c);

  if (config.auth.requireAuth && !jwtAuth) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const orgId = jwtAuth?.orgId || 'default';
  const conceptId = normalizeConceptId(c.req.param('id')) ?? c.req.param('id');

  try {
    const body = await c.req.json().catch(() => ({}));
    const request = ResolveConceptRequestSchema.parse({
      concept_id: conceptId,
      ...body,
    });

    const result = await resolveConcept(request, orgId, jwtAuth?.jwtToken);
    return c.json(result);
  } catch (error) {
    const err = error as Error;
    logger.error('Failed to resolve concept', { error: err.message });
    return c.json({ error: err.message }, 400);
  }
});

/**
 * Update concept
 * PATCH /concepts/:id
 */
concepts.patch('/:id', async (c) => {
  const jwtAuth = getJwtAuthFromContext(c);

  if (config.auth.requireAuth && !jwtAuth) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const orgId = jwtAuth?.orgId || 'default';
  const conceptId = normalizeConceptId(c.req.param('id')) ?? c.req.param('id');

  try {
    const body = await c.req.json();
    const concept = await updateConcept(conceptId, body, orgId, jwtAuth?.jwtToken);
    return c.json(concept);
  } catch (error) {
    const err = error as Error;
    logger.error('Failed to update concept', { error: err.message });
    return c.json({ error: err.message }, 400);
  }
});

/**
 * Get neighbors
 * GET /concepts/:id/neighbors
 */
concepts.get('/:id/neighbors', async (c) => {
  const jwtAuth = getJwtAuthFromContext(c);

  if (config.auth.requireAuth && !jwtAuth) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const orgId = jwtAuth?.orgId || 'default';
  const conceptId = normalizeConceptId(c.req.param('id')) ?? c.req.param('id');

  try {
    const direction = c.req.query('direction') || 'both';
    const edgeTypes = c.req.query('edge_types')?.split(',');
    const limit = c.req.query('limit');

    const request = GetNeighborsRequestSchema.parse({
      concept_id: conceptId,
      direction,
      edge_types: edgeTypes,
      limit: limit ? parseInt(limit) : undefined,
    });

    const neighbors = await getNeighbors(request, orgId, jwtAuth?.jwtToken);
    // Passive load event for each surfaced neighbor concept. Mirrors the
    // search path; see `services/passive-usage.ts`.
    const neighborConcepts = (neighbors as Array<{ concept?: Concept }>)
      .map((n) => n?.concept)
      .filter((c): c is Concept => Boolean(c));
    recordPassiveUsageForResults('rest_neighbors', neighborConcepts, orgId, jwtAuth?.jwtToken);
    return c.json({ neighbors });
  } catch (error) {
    const err = error as Error;
    logger.error('Failed to get neighbors', { error: err.message });
    return c.json({ error: err.message }, 400);
  }
});

/**
 * Get edges for concept
 * GET /concepts/:id/edges
 */
concepts.get('/:id/edges', async (c) => {
  const jwtAuth = getJwtAuthFromContext(c);

  if (config.auth.requireAuth && !jwtAuth) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const conceptId = normalizeConceptId(c.req.param('id')) ?? c.req.param('id');
  const direction = (c.req.query('direction') || 'both') as 'outgoing' | 'incoming' | 'both';

  try {
    const edges = await getEdgesForConcept(conceptId, direction, undefined, jwtAuth?.jwtToken);
    return c.json({ edges });
  } catch (error) {
    const err = error as Error;
    logger.error('Failed to get edges', { error: err.message });
    return c.json({ error: err.message }, 400);
  }
});

/**
 * Create edge between concepts
 * POST /concepts/:id/link
 */
concepts.post('/:id/link', async (c) => {
  const jwtAuth = getJwtAuthFromContext(c);

  if (config.auth.requireAuth && !jwtAuth) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const orgId = jwtAuth?.orgId || 'default';
  const rawFromId = c.req.param('id');
  const fromConceptId = normalizeConceptId(rawFromId) ?? rawFromId;

  try {
    const body = await c.req.json();
    const request = LinkConceptsRequestSchema.parse({
      from_concept_id: fromConceptId,
      ...body,
    });

    const edge = await createEdge(request, orgId, jwtAuth?.jwtToken);
    return c.json(edge, 201);
  } catch (error) {
    const err = error as Error;
    logger.error('Failed to create edge', { error: err.message });
    return c.json({ error: err.message }, 400);
  }
});

/**
 * Record concept usage
 * POST /concepts/:id/usage
 */
concepts.post('/:id/usage', async (c) => {
  const jwtAuth = getJwtAuthFromContext(c);

  if (config.auth.requireAuth && !jwtAuth) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const orgId = jwtAuth?.orgId || 'default';
  const conceptId = normalizeConceptId(c.req.param('id')) ?? c.req.param('id');

  try {
    const body = await c.req.json();
    const request = RecordUsageRequestSchema.parse({
      concept_id: conceptId,
      ...body,
    });

    const usage = await recordUsage(request, orgId, jwtAuth?.jwtToken);
    return c.json(usage, 201);
  } catch (error) {
    const err = error as Error;
    logger.error('Failed to record usage', { error: err.message });
    return c.json({ error: err.message }, 400);
  }
});

/**
 * Get usage history
 * GET /concepts/:id/usage
 */
concepts.get('/:id/usage', async (c) => {
  const jwtAuth = getJwtAuthFromContext(c);

  if (config.auth.requireAuth && !jwtAuth) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const conceptId = normalizeConceptId(c.req.param('id')) ?? c.req.param('id');
  const limit = c.req.query('limit');

  try {
    const history = await getUsageHistory(conceptId, limit ? parseInt(limit) : undefined, jwtAuth?.jwtToken);
    return c.json({ usage: history });
  } catch (error) {
    const err = error as Error;
    logger.error('Failed to get usage history', { error: err.message });
    return c.json({ error: err.message }, 400);
  }
});

/**
 * Get usage stats
 * GET /concepts/:id/stats
 */
concepts.get('/:id/stats', async (c) => {
  const jwtAuth = getJwtAuthFromContext(c);

  if (config.auth.requireAuth && !jwtAuth) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const conceptId = normalizeConceptId(c.req.param('id')) ?? c.req.param('id');

  try {
    const stats = await getUsageStats(conceptId, jwtAuth?.jwtToken);
    return c.json(stats);
  } catch (error) {
    const err = error as Error;
    logger.error('Failed to get usage stats', { error: err.message });
    return c.json({ error: err.message }, 400);
  }
});

/**
 * Get sequence neighbors
 * GET /concepts/:id/sequence
 */
concepts.get('/:id/sequence', async (c) => {
  const jwtAuth = getJwtAuthFromContext(c);

  if (config.auth.requireAuth && !jwtAuth) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const conceptId = normalizeConceptId(c.req.param('id')) ?? c.req.param('id');
  const direction = (c.req.query('direction') || 'next') as 'next' | 'prev' | 'both';
  const limit = c.req.query('limit');

  try {
    const neighbors = await getSequenceNeighbors(
      conceptId,
      direction,
      limit ? parseInt(limit) : undefined,
      jwtAuth?.jwtToken
    );
    return c.json({ sequence: neighbors });
  } catch (error) {
    const err = error as Error;
    logger.error('Failed to get sequence neighbors', { error: err.message });
    return c.json({ error: err.message }, 400);
  }
});

/**
 * Record sequence
 * POST /sequences
 */
concepts.post('/sequences', async (c) => {
  const jwtAuth = getJwtAuthFromContext(c);

  if (config.auth.requireAuth && !jwtAuth) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const orgId = jwtAuth?.orgId || 'default';

  try {
    const body = await c.req.json();
    const request = RecordSequenceRequestSchema.parse(body);
    const result = await recordSequence(request, orgId, jwtAuth?.jwtToken);
    return c.json(result, 201);
  } catch (error) {
    const err = error as Error;
    logger.error('Failed to record sequence', { error: err.message });
    return c.json({ error: err.message }, 400);
  }
});

export { concepts };
