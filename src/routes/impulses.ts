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
import {
  CreateConceptRequestSchema,
  LinkConceptsRequestSchema,
  RecordUsageRequestSchema,
  RecordSequenceRequestSchema,
} from '../models/schemas';
import type { EdgeType } from '../models/schemas';

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
  'concept_create_write',
  'conceptLink_write',
  'conceptSignatureUpsert_write',
  'conceptUsage_write',
  'conceptSequence_write',
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
      // Write shapes
      // ---------------------------------------------------------------
      // Per docs/specs/impulse-write-resolver.md → "Mirror the activity-api
      // _write pattern in concept-db. No contract changes. Add *_write cases
      // to ... impulses.ts. Each case validates the required payload field,
      // calls the corresponding resolver function ... and wraps the result
      // in the standard impulse-resolve envelope with metadata.shape =
      // <type>_result". Each emits a conceptUpkeepAuditLog impulse.

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
