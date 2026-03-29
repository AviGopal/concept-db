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
import { createEdge } from '../resolvers/edge';
import { recordUsage } from '../resolvers/usage';
import { recordSequence } from '../resolvers/sequence';
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
        const request = LinkConceptsRequestSchema.parse(args);
        const edge = await createEdge(request, orgId, jwtToken);
        return { success: true, result: edge };
      }

      case 'concept_search': {
        const request = SearchConceptsRequestSchema.parse(args);
        const concepts = await searchConcepts(request, orgId, jwtToken);
        return { success: true, result: concepts };
      }

      case 'concept_neighbors': {
        const request = GetNeighborsRequestSchema.parse(args);
        const neighbors = await getNeighbors(request, orgId, jwtToken);
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
