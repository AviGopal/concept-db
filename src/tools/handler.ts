/**
 * MCP Tool Handler
 *
 * Routes MCP tool calls to the appropriate resolvers.
 */

import { logger } from '../utils/logger';
import {
  createConcept,
  resolveConcept,
  searchConcepts,
  getNeighbors,
} from '../resolvers/concept';
import { upsertEdge, getImpulseCooccurrenceEdges } from '../resolvers/edge';
import { upsertBySignature } from '../resolvers/concept';
import { recordUsage } from '../resolvers/usage';
import { recordSequence } from '../resolvers/sequence';
import { recordPassiveUsageForResults, normalizeConceptId } from '../services/passive-usage';
import type { Concept } from '../models/schemas';
import {
  CreateConceptRequestSchema,
  ResolveConceptRequestSchema,
  LinkConceptsRequestSchema,
  SearchConceptsRequestSchema,
  GetNeighborsRequestSchema,
  RecordUsageRequestSchema,
  RecordSequenceRequestSchema,
} from '../models/schemas';

export interface ToolCallResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Handle an MCP tool call
 */
export async function handleToolCall(
  toolName: string,
  args: Record<string, unknown>,
  orgId: string,
  jwtToken?: string
): Promise<ToolCallResult> {
  logger.info('Handling MCP tool call', { tool: toolName, org_id: orgId });

  try {
    switch (toolName) {
      case 'concept_create': {
        const request = CreateConceptRequestSchema.parse(args);
        const concept = await createConcept(request, orgId, jwtToken);
        return { success: true, result: concept };
      }

      case 'concept_resolve': {
        const request = ResolveConceptRequestSchema.parse(args);
        const result = await resolveConcept(request, orgId, jwtToken);
        return { success: true, result };
      }

      case 'concept_link': {
        // Normalize both endpoint IDs at the tool boundary so MCP callers that
        // pass bare nanoid or prefixed forms get canonical records.
        const normalizedArgs = {
          ...args,
          from_concept_id: typeof args.from_concept_id === 'string'
            ? (normalizeConceptId(args.from_concept_id) ?? args.from_concept_id)
            : args.from_concept_id,
          to_concept_id: typeof args.to_concept_id === 'string'
            ? (normalizeConceptId(args.to_concept_id) ?? args.to_concept_id)
            : args.to_concept_id,
        };
        const request = LinkConceptsRequestSchema.parse(normalizedArgs);
        const result = await upsertEdge(request, orgId, jwtToken);
        return { success: true, result };
      }

      case 'concept_upsert_by_signature': {
        const pointerType = args.pointer_type;
        const shape = args.shape;
        if (typeof pointerType !== 'string' || typeof shape !== 'string') {
          return {
            success: false,
            error: 'concept_upsert_by_signature requires string `pointer_type` and `shape`',
          };
        }
        const result = await upsertBySignature(
          { pointerType, shape, orgId },
          jwtToken,
        );
        return { success: true, result };
      }

      case 'concept_cooccurrence_edges': {
        const pointerType = typeof args.pointer_type === 'string' ? args.pointer_type : undefined;
        const shape = typeof args.shape === 'string' ? args.shape : undefined;
        const minWeight = typeof args.min_weight === 'number' ? args.min_weight : undefined;
        const limit = typeof args.limit === 'number' ? args.limit : undefined;
        const edges = await getImpulseCooccurrenceEdges(
          { pointerType, shape, minWeight, limit, orgId },
          jwtToken,
        );
        return { success: true, result: { edges } };
      }

      case 'concept_search': {
        const request = SearchConceptsRequestSchema.parse(args);
        const concepts = await searchConcepts(request, orgId, jwtToken);
        recordPassiveUsageForResults('concept_search', concepts, orgId, jwtToken);
        // F27 (2026-05-30): see routes/concepts.ts for rationale. MCP callers
        // never need the raw float vectors; embeddings would balloon LLM
        // prompts that interpolate the tool output. Pass `include_embeddings:true`
        // in args to opt in.
        const includeEmbeddings = args.include_embeddings === true;
        const projected = includeEmbeddings
          ? concepts
          : concepts.map((c) => {
              const { content_embedding: _ce, summary_embedding: _se, ...rest } = c as Concept & {
                content_embedding?: unknown;
                summary_embedding?: unknown;
              };
              return rest;
            });
        return { success: true, result: projected };
      }

      case 'concept_neighbors': {
        const request = GetNeighborsRequestSchema.parse(args);
        const neighbors = await getNeighbors(request, orgId, jwtToken);
        // `getNeighbors` returns one entry per edge; each entry has a
        // `.concept` field with the neighbor concept itself. Surface those
        // as the load events.
        const neighborConcepts = (neighbors as Array<{ concept?: Concept }>)
          .map((n) => n?.concept)
          .filter((c): c is Concept => Boolean(c));
        recordPassiveUsageForResults('concept_neighbors', neighborConcepts, orgId, jwtToken);
        return { success: true, result: neighbors };
      }

      case 'concept_record_usage': {
        const request = RecordUsageRequestSchema.parse(args);
        const usage = await recordUsage(request, orgId, jwtToken);
        return { success: true, result: usage };
      }

      case 'concept_sequence_record': {
        const request = RecordSequenceRequestSchema.parse(args);
        const result = await recordSequence(request, orgId, jwtToken);
        return { success: true, result };
      }

      default:
        return { success: false, error: `Unknown tool: ${toolName}` };
    }
  } catch (error) {
    const err = error as Error;
    logger.error('Tool call failed', {
      tool: toolName,
      error: err.message,
      stack: err.stack,
    });

    return {
      success: false,
      error: err.message,
    };
  }
}
