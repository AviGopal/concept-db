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
import { config } from '../config';
import {
  resolveConcept,
  getNeighbors,
  getConceptById,
  upsertBySignature,
  createConcept,
} from '../resolvers/concept';
import { getImpulseCooccurrenceEdges, upsertEdge } from '../resolvers/edge';
import { getUsageStats, recordUsage } from '../resolvers/usage';
import { getSequenceNeighbors, recordSequence } from '../resolvers/sequence';
import { createImpulse } from '../resolvers/impulse';
import { conceptTools, type MCPTool } from '../tools/definitions';
import {
  CreateConceptRequestSchema,
  LinkConceptsRequestSchema,
  RecordUsageRequestSchema,
  RecordSequenceRequestSchema,
} from '../models/schemas';
import type { EdgeType } from '../models/schemas';
import { createConceptFromSource } from '../sources/unified';

const impulses = new Hono();

const SUPPORTED_SHAPES = [
  'concept',
  'conceptGraph',
  'relatedConcepts',
  'conceptUsageStats',
  'conceptSequence',
  'impulseSignatureConcept',
  'impulseCooccurrenceEdges',
  // Write shapes — emit a `conceptUpkeepAuditLog` impulse alongside the
  // underlying mutation. See docs/specs/impulse-write-resolver.md.
  // concept_write: unified from-source path (wraps POST /concepts/from-source).
  // Pointer payload: { type: 'concept_write', source_type, content, summary?,
  //   priority?, budget?, scope?, public?, project_id?, metadata? }
  'concept_write',
  'concept_create_write',
  'conceptLink_write',
  'conceptSignatureUpsert_write',
  'conceptUsage_write',
  'conceptSequence_write',
  // mcpTool: discovery-to-tools bridge. Returns a ranked list of tools the
  // vessel exposes, scored against the request's task context. See
  // docs/specs/discovery-to-tools-bridge.md.
  'mcpTool',
] as const;

/**
 * Emit a `conceptUpkeepAuditLog` impulse for a write resolver call.
 * Non-blocking — a failed audit logs but does not roll back the mutation.
 *
 * Returns the audit impulse id (or null on failure) so the response envelope
 * can embed it under `auditImpulseId`.
 */
async function emitWriteAudit(opts: {
  resolverId: string;
  operation: string;
  targetTable: string;
  requestBody: unknown;
  resultId?: string;
  performedBy: string;
  orgId: string;
  jwtToken?: string;
}): Promise<string | null> {
  try {
    const impulse = await createImpulse(
      {
        shape: 'conceptUpkeepAuditLog',
        pointer: {
          operation: opts.operation,
          target_table: opts.targetTable,
          target_ids: opts.resultId ? [opts.resultId] : [],
          request_body: opts.requestBody,
          result_id: opts.resultId ?? null,
          performed_by: opts.performedBy,
          org_id: opts.orgId,
          performed_at: new Date().toISOString(),
        },
        summary: `${opts.resolverId} → ${opts.targetTable}${opts.resultId ? ` (${opts.resultId})` : ''}`,
        created_by_resolver_id: opts.resolverId,
      },
      opts.orgId,
      { jwtToken: opts.jwtToken },
    );
    return impulse.id;
  } catch (err) {
    logger.warn('Failed to emit write-audit impulse (non-blocking)', {
      resolver_id: opts.resolverId,
      error: (err as Error).message,
    });
    return null;
  }
}

interface ResolveResponse {
  content: unknown;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// mcpTool resolver helpers (discovery-to-tools bridge).
// See docs/specs/discovery-to-tools-bridge.md § "Resolver scoring (vessel-side)".
// ---------------------------------------------------------------------------

/**
 * This vessel's externally-reachable base URL. Mirrors the logic in
 * services/discovery-client.ts:getEndpoint() so the tool impulses we emit
 * carry the same endpoint the discovery registration advertises.
 */
function getSelfEndpoint(): string {
  if (process.env.VESSEL_ENDPOINT) return process.env.VESSEL_ENDPOINT;
  const namespace = process.env.SURREALDB_NAMESPACE || 'activity-system';
  const serviceName = process.env.SERVICE_NAME || 'concept-db';
  return `http://${serviceName}.${namespace}.svc.cluster.local:${config.port}`;
}

/**
 * Tokenize a string into lowercase keyword tokens. Splits on non-alphanumeric
 * characters so `concept_link` → ["concept", "link"], `from_concept_id` →
 * ["from", "concept", "id"]. Empty tokens are dropped.
 */
function tokenize(input: string | undefined | null): string[] {
  if (!input) return [];
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * Bag-of-words overlap as a normalized score in [0, 1]. Defined as the
 * fraction of `needle` tokens that appear in `haystack` tokens. Returns 0
 * when `needle` is empty (no signal → no contribution).
 */
function keywordMatchScore(needle: string[], haystack: string[]): number {
  if (needle.length === 0) return 0;
  const haystackSet = new Set(haystack);
  let hits = 0;
  for (const tok of needle) {
    if (haystackSet.has(tok)) hits++;
  }
  return hits / needle.length;
}

/**
 * Per-tool relevance EMA. The full spec calls for tracking per-tool success
 * rate from past usage; concept-db today doesn't have a per-tool-name usage
 * counter (`concept_usage` is keyed on concept_id, not tool name). Default
 * to the uninformed prior 0.5 across the board until that signal exists.
 *
 * TODO(discovery-to-tools-bridge): wire to per-tool EMA once a `tool_usage`
 * table or equivalent is added. See docs/specs/discovery-to-tools-bridge.md
 * § "Resolver scoring (vessel-side)".
 */
function relevanceEmaForTool(_tool: MCPTool): number {
  return 0.5;
}

/**
 * Scoring function per docs/specs/discovery-to-tools-bridge.md:
 *   score = 0.4 * shape_match
 *         + 0.3 * keyword_match
 *         + 0.3 * (relevance_ema ?? 0.5)
 *
 * shape_match: today MCPTool definitions don't declare input/output shapes
 * (the spec calls this a future small extension). We treat the shape-match
 * term as a soft keyword match between requested shapes and the tool's
 * name+description tokens — rough but better than 0 for cold-start.
 *
 * keyword_match: bag-of-words overlap between the request's goal_keywords +
 * tokens(task_description) and the tool's name+description tokens.
 */
function scoreToolForContext(
  tool: MCPTool,
  context: {
    goal_keywords?: string[];
    input_shapes?: string[];
    output_shapes?: string[];
    task_description?: string;
  },
): { score: number; matched_input_shapes: string[]; matched_output_shapes: string[] } {
  const toolTokens = [...tokenize(tool.name), ...tokenize(tool.description)];
  const toolTokenSet = new Set(toolTokens);

  const requestedInputShapes = context.input_shapes ?? [];
  const requestedOutputShapes = context.output_shapes ?? [];
  const allShapes = [...requestedInputShapes, ...requestedOutputShapes];

  // shape_match: tokens of each requested shape against the tool's tokens.
  // Score per shape: 1 if all of its tokens are present in the tool, else
  // proportional. Average across requested shapes.
  let shapeScore = 0;
  if (allShapes.length > 0) {
    let shapeAccum = 0;
    for (const shape of allShapes) {
      const shapeToks = tokenize(shape);
      shapeAccum += keywordMatchScore(shapeToks, toolTokens);
    }
    shapeScore = shapeAccum / allShapes.length;
  }

  // matched_*_shapes: surface which requested shapes had >0 token overlap.
  // Cheap signal for the consumer to disambiguate.
  const matched_input_shapes = requestedInputShapes.filter(
    (s) => tokenize(s).some((t) => toolTokenSet.has(t)),
  );
  const matched_output_shapes = requestedOutputShapes.filter(
    (s) => tokenize(s).some((t) => toolTokenSet.has(t)),
  );

  // keyword_match: goal_keywords + task_description tokens against tool tokens.
  const goalTokens = (context.goal_keywords ?? []).flatMap((k) => tokenize(k));
  const descTokens = tokenize(context.task_description);
  const queryTokens = [...goalTokens, ...descTokens];
  const keywordScore = keywordMatchScore(queryTokens, toolTokens);

  const emaScore = relevanceEmaForTool(tool);

  const score =
    0.4 * shapeScore + 0.3 * keywordScore + 0.3 * emaScore;

  return { score, matched_input_shapes, matched_output_shapes };
}

interface McpToolImpulse {
  shape: 'mcpTool';
  vessel_id: string;
  vessel_endpoint: string;
  tool_name: string;
  description: string;
  input_schema: MCPTool['inputSchema'];
  resolve_endpoint: string;
  resolve_request_format: 'mcp-tool';
  auth_scheme: 'ApiKey' | 'Bearer' | 'none';
  relevance_score: number;
  matched_input_shapes: string[];
  matched_output_shapes: string[];
}

/**
 * Build the response envelope for an mcpTool resolution. Returns matching
 * tools sorted by relevance_score descending, capped at `limit` (default 20).
 *
 * Anthropic's tool-name regex is `^[a-zA-Z0-9_-]{1,64}$`; concept-db's tool
 * names already comply, so no name rewriting needed.
 */
function buildMcpToolResponse(
  pointer: {
    context?: {
      goal_keywords?: string[];
      input_shapes?: string[];
      output_shapes?: string[];
      task_description?: string;
    };
    // The spec's pointer envelope nests the context under `context`, but
    // accepts top-level fields too for callers that flatten. Both are
    // handled below.
    goal_keywords?: string[];
    input_shapes?: string[];
    output_shapes?: string[];
    task_description?: string;
    limit?: number;
    min_relevance?: number;
  },
): ResolveResponse {
  const ctx = {
    goal_keywords: pointer.context?.goal_keywords ?? pointer.goal_keywords,
    input_shapes: pointer.context?.input_shapes ?? pointer.input_shapes,
    output_shapes: pointer.context?.output_shapes ?? pointer.output_shapes,
    task_description:
      pointer.context?.task_description ?? pointer.task_description,
  };

  const limit =
    typeof pointer.limit === 'number' && pointer.limit > 0
      ? Math.floor(pointer.limit)
      : 20;
  const minRelevance =
    typeof pointer.min_relevance === 'number' ? pointer.min_relevance : 0;

  const vesselId = config.discovery.vesselId;
  const vesselEndpoint = getSelfEndpoint();

  // Detect "uninformed" pointer — no context fields at all. In that case
  // every tool scores identically (0.4*0 + 0.3*0 + 0.3*0.5 = 0.15) which
  // ranks them all equal; we surface the full catalog (capped at limit).
  const hasContextSignal =
    (ctx.goal_keywords && ctx.goal_keywords.length > 0) ||
    (ctx.input_shapes && ctx.input_shapes.length > 0) ||
    (ctx.output_shapes && ctx.output_shapes.length > 0) ||
    (ctx.task_description && ctx.task_description.length > 0);

  const scored: McpToolImpulse[] = conceptTools
    .map((tool): McpToolImpulse => {
      const { score, matched_input_shapes, matched_output_shapes } =
        scoreToolForContext(tool, ctx);
      return {
        shape: 'mcpTool',
        vessel_id: vesselId,
        vessel_endpoint: vesselEndpoint,
        tool_name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
        resolve_endpoint: '/mcp/tools/call',
        resolve_request_format: 'mcp-tool',
        auth_scheme: 'ApiKey',
        relevance_score: score,
        matched_input_shapes,
        matched_output_shapes,
      };
    })
    .filter((t) => t.relevance_score >= minRelevance);

  // Stable sort: score desc, then name asc for deterministic ordering when
  // scores tie (matters for cold-start, where everything is 0.15).
  scored.sort((a, b) => {
    if (b.relevance_score !== a.relevance_score) {
      return b.relevance_score - a.relevance_score;
    }
    return a.tool_name.localeCompare(b.tool_name);
  });

  const trimmed = scored.slice(0, limit);

  // Annotate the summary so the caller sees whether the resolver had context
  // to score against; useful for debugging cold-start ranking issues.
  const summary = hasContextSignal
    ? `${trimmed.length} tool(s) matching context (of ${conceptTools.length} total)`
    : `${trimmed.length} tool(s) (no context — uninformed prior)`;

  return {
    content: trimmed,
    metadata: {
      shape: 'mcpTool',
      summary,
      rowCount: trimmed.length,
      vessel_id: vesselId,
    },
  };
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

      case 'impulseSignatureConcept': {
        const pointerType = pointer.pointer_type;
        const sigShape = pointer.shape;
        if (typeof pointerType !== 'string' || typeof sigShape !== 'string') {
          return c.json(
            {
              error:
                'pointer.pointer_type and pointer.shape are required for shape "impulseSignatureConcept"',
            },
            400,
          );
        }
        const { id, created } = await upsertBySignature(
          { pointerType, shape: sigShape, orgId },
          jwtToken,
        );
        // Return as a `concept`-shaped response so activities can consume it
        // with the same handling as the normal `concept` shape.
        const concept = await getConceptById(id, orgId, jwtToken);
        if (!concept) {
          throw new Error(`Upserted concept not found: ${id}`);
        }
        result = {
          content: concept.content,
          metadata: {
            shape: 'concept',
            signature_shape: 'impulseSignatureConcept',
            created,
            concept_id: id,
            pointer_type: pointerType,
            impulse_shape: sigShape,
            concept_shape: concept.shape,
            summary: concept.summary,
            source_type: concept.source_type,
            token_estimate: concept.token_estimate,
            relevance: concept.relevance,
          },
        };
        break;
      }

      case 'impulseCooccurrenceEdges': {
        const pointerType =
          typeof pointer.pointer_type === 'string' ? pointer.pointer_type : undefined;
        const sigShape =
          typeof pointer.shape === 'string' ? pointer.shape : undefined;
        const minWeight =
          typeof pointer.min_weight === 'number' ? pointer.min_weight : undefined;
        const limit = typeof pointer.limit === 'number' ? pointer.limit : 100;

        const edges = await getImpulseCooccurrenceEdges(
          { pointerType, shape: sigShape, minWeight, limit, orgId },
          jwtToken,
        );
        result = {
          content: { edges },
          metadata: {
            shape: 'impulseCooccurrenceEdges',
            count: edges.length,
            filter: {
              pointer_type: pointerType,
              shape: sigShape,
              min_weight: minWeight,
              limit,
            },
          },
        };
        break;
      }

      // ---------------------------------------------------------------
      // mcpTool: discovery-to-tools bridge.
      // ---------------------------------------------------------------
      // Returns the list of tools concept-db exposes, scored against the
      // request's task context (goal_keywords, input/output shapes, free-text
      // task description). Each entry carries enough metadata for the
      // consumer to dispatch the tool without per-vessel client code:
      // vessel_endpoint + resolve_endpoint + resolve_request_format +
      // auth_scheme. Read-only — does not mutate any tool state.

      case 'mcpTool': {
        result = buildMcpToolResponse(pointer as Parameters<typeof buildMcpToolResponse>[0]);
        break;
      }

      // ---------------------------------------------------------------
      // Write shapes
      // ---------------------------------------------------------------
      // Per docs/specs/impulse-write-resolver.md → "Mirror the activity-api
      // _write pattern in concept-db. No contract changes. Add *_write cases
      // to ... impulses.ts. Each case validates the required payload field,
      // calls the corresponding resolver function ... and wraps the result
      // in the standard impulse-resolve envelope with metadata.shape =
      // <type>_result". Each emits a conceptUpkeepAuditLog impulse.

      // concept_write — unified from-source path. Mirrors POST /concepts/from-source.
      // Pointer: { type: 'concept_write', source_type, content, summary?,
      //            priority?, budget?, scope?, public?, project_id?, metadata? }
      case 'concept_write': {
        if (config.auth.requireAuth && !jwtAuth) {
          return c.json({ success: false, error: 'Authentication required' }, 401);
        }
        const wp = pointer as {
          source_type?: unknown;
          content?: unknown;
          summary?: unknown;
          priority?: unknown;
          budget?: unknown;
          scope?: unknown;
          public?: unknown;
          project_id?: unknown;
          metadata?: unknown;
        };
        if (typeof wp.source_type !== 'string' || typeof wp.content !== 'string') {
          return c.json(
            {
              success: false,
              error:
                'source_type (string) and content (string) are required for concept_write',
            },
            400,
          );
        }
        try {
          const concept = await createConceptFromSource(
            {
              source_type: wp.source_type as Parameters<typeof createConceptFromSource>[0]['source_type'],
              content: wp.content,
              summary: typeof wp.summary === 'string' ? wp.summary : undefined,
              priority: typeof wp.priority === 'number' ? wp.priority : undefined,
              budget: typeof wp.budget === 'number' ? wp.budget : undefined,
              scope: wp.scope as Parameters<typeof createConceptFromSource>[0]['scope'],
              public: typeof wp.public === 'boolean' ? wp.public : undefined,
              project_id: typeof wp.project_id === 'string' ? wp.project_id : undefined,
              metadata:
                wp.metadata && typeof wp.metadata === 'object' && !Array.isArray(wp.metadata)
                  ? (wp.metadata as Record<string, unknown>)
                  : undefined,
            },
            orgId,
            jwtToken,
          );
          const auditImpulseId = await emitWriteAudit({
            resolverId: 'concept_write',
            operation: 'create',
            targetTable: 'concept',
            requestBody: {
              source_type: wp.source_type,
              content_length: (wp.content as string).length,
              summary: wp.summary,
            },
            resultId: concept.id,
            performedBy: jwtAuth?.instanceId || jwtAuth?.orgId || 'anonymous',
            orgId,
            jwtToken,
          });
          return c.json({
            success: true,
            content: JSON.stringify(concept),
            metadata: {
              shape: 'concept_write_result',
              summary: `Concept ${concept.id} created from ${wp.source_type} source`,
              concept_id: concept.id,
              concept_shape: concept.shape,
              source_type: concept.source_type,
              auditImpulseId,
            },
          });
        } catch (err) {
          const e = err as Error;
          return c.json({ success: false, error: e.message }, 400);
        }
      }

      case 'concept_create_write': {
        if (config.auth.requireAuth && !jwtAuth) {
          return c.json({ success: false, error: 'Authentication required' }, 401);
        }
        const writePointer = pointer as { conceptData?: unknown };
        if (!writePointer.conceptData) {
          return c.json(
            { success: false, error: 'conceptData required for concept_create_write' },
            400,
          );
        }
        try {
          const request = CreateConceptRequestSchema.parse(writePointer.conceptData);
          const concept = await createConcept(request, orgId, jwtToken);
          const auditImpulseId = await emitWriteAudit({
            resolverId: 'concept_create_write',
            operation: 'create',
            targetTable: 'concept',
            requestBody: writePointer.conceptData,
            resultId: concept.id,
            performedBy: jwtAuth?.instanceId || jwtAuth?.orgId || 'anonymous',
            orgId,
            jwtToken,
          });
          return c.json({
            success: true,
            content: JSON.stringify(concept),
            metadata: {
              shape: 'concept_create_write_result',
              summary: `Concept ${concept.id} created`,
              auditImpulseId,
            },
          });
        } catch (err) {
          const e = err as Error;
          return c.json({ success: false, error: e.message }, 400);
        }
      }

      case 'conceptLink_write': {
        if (config.auth.requireAuth && !jwtAuth) {
          return c.json({ success: false, error: 'Authentication required' }, 401);
        }
        const writePointer = pointer as { linkData?: unknown };
        if (!writePointer.linkData) {
          return c.json(
            { success: false, error: 'linkData required for conceptLink_write' },
            400,
          );
        }
        try {
          const request = LinkConceptsRequestSchema.parse(writePointer.linkData);
          const result = await upsertEdge(request, orgId, jwtToken);
          const auditImpulseId = await emitWriteAudit({
            resolverId: 'conceptLink_write',
            operation: result.created ? 'create' : 'update',
            targetTable: 'concept_edge',
            requestBody: writePointer.linkData,
            resultId: result.id,
            performedBy: jwtAuth?.instanceId || jwtAuth?.orgId || 'anonymous',
            orgId,
            jwtToken,
          });
          return c.json({
            success: true,
            content: JSON.stringify(result),
            metadata: {
              shape: 'conceptLink_write_result',
              summary: result.created
                ? `Edge ${result.id} created`
                : `Edge ${result.id} EMA-updated (weight ${result.new_weight.toFixed(3)})`,
              auditImpulseId,
            },
          });
        } catch (err) {
          const e = err as Error;
          return c.json({ success: false, error: e.message }, 400);
        }
      }

      case 'conceptSignatureUpsert_write': {
        if (config.auth.requireAuth && !jwtAuth) {
          return c.json({ success: false, error: 'Authentication required' }, 401);
        }
        const writePointer = pointer as { pointer_type?: unknown; shape?: unknown };
        if (
          typeof writePointer.pointer_type !== 'string' ||
          typeof writePointer.shape !== 'string'
        ) {
          return c.json(
            {
              success: false,
              error:
                'pointer_type (string) and shape (string) required for conceptSignatureUpsert_write',
            },
            400,
          );
        }
        try {
          const result = await upsertBySignature(
            {
              pointerType: writePointer.pointer_type,
              shape: writePointer.shape,
              orgId,
            },
            jwtToken,
          );
          const auditImpulseId = await emitWriteAudit({
            resolverId: 'conceptSignatureUpsert_write',
            operation: result.created ? 'create' : 'noop',
            targetTable: 'concept',
            requestBody: {
              pointer_type: writePointer.pointer_type,
              shape: writePointer.shape,
            },
            resultId: result.id,
            performedBy: jwtAuth?.instanceId || jwtAuth?.orgId || 'anonymous',
            orgId,
            jwtToken,
          });
          return c.json({
            success: true,
            content: JSON.stringify(result),
            metadata: {
              shape: 'conceptSignatureUpsert_write_result',
              summary: result.created
                ? `Signature concept ${result.id} created`
                : `Signature concept ${result.id} already existed`,
              auditImpulseId,
            },
          });
        } catch (err) {
          const e = err as Error;
          return c.json({ success: false, error: e.message }, 400);
        }
      }

      case 'conceptUsage_write': {
        if (config.auth.requireAuth && !jwtAuth) {
          return c.json({ success: false, error: 'Authentication required' }, 401);
        }
        const writePointer = pointer as { usageData?: unknown };
        if (!writePointer.usageData) {
          return c.json(
            { success: false, error: 'usageData required for conceptUsage_write' },
            400,
          );
        }
        try {
          const request = RecordUsageRequestSchema.parse(writePointer.usageData);
          const usage = await recordUsage(request, orgId, jwtToken);
          const auditImpulseId = await emitWriteAudit({
            resolverId: 'conceptUsage_write',
            operation: 'create',
            targetTable: 'concept_usage',
            requestBody: writePointer.usageData,
            resultId: usage.id,
            performedBy: jwtAuth?.instanceId || jwtAuth?.orgId || 'anonymous',
            orgId,
            jwtToken,
          });
          return c.json({
            success: true,
            content: JSON.stringify(usage),
            metadata: {
              shape: 'conceptUsage_write_result',
              summary: `Usage ${usage.id} recorded for concept ${request.concept_id}`,
              auditImpulseId,
            },
          });
        } catch (err) {
          const e = err as Error;
          return c.json({ success: false, error: e.message }, 400);
        }
      }

      case 'conceptSequence_write': {
        if (config.auth.requireAuth && !jwtAuth) {
          return c.json({ success: false, error: 'Authentication required' }, 401);
        }
        const writePointer = pointer as { sequenceData?: unknown };
        if (!writePointer.sequenceData) {
          return c.json(
            { success: false, error: 'sequenceData required for conceptSequence_write' },
            400,
          );
        }
        try {
          const request = RecordSequenceRequestSchema.parse(writePointer.sequenceData);
          const result = await recordSequence(request, orgId, jwtToken);
          const auditImpulseId = await emitWriteAudit({
            resolverId: 'conceptSequence_write',
            operation: 'create',
            targetTable: 'concept_edge',
            requestBody: writePointer.sequenceData,
            // No single resultId for a sequence; record the trace_id for traceability.
            resultId: request.trace_id,
            performedBy: jwtAuth?.instanceId || jwtAuth?.orgId || 'anonymous',
            orgId,
            jwtToken,
          });
          return c.json({
            success: true,
            content: JSON.stringify(result),
            metadata: {
              shape: 'conceptSequence_write_result',
              summary: `Sequence recorded: ${result.edges_created} edges created, ${result.edges_skipped} updated`,
              auditImpulseId,
            },
          });
        } catch (err) {
          const e = err as Error;
          return c.json({ success: false, error: e.message }, 400);
        }
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
