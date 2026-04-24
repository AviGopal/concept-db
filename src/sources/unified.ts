/**
 * Unified Source Handler
 *
 * Creates concepts from various source types with appropriate shape inference.
 */

import { createConcept } from '../resolvers/concept';
import { logger } from '../utils/logger';
import type { SourceType, Concept, ScopeType } from '../models/schemas';

/**
 * Source-to-shape mapping
 */
const sourceShapeMap: Record<SourceType, string> = {
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

/**
 * Source-specific priority defaults
 */
const sourcePriorityDefaults: Record<SourceType, number> = {
  goal: 0.9,           // Goals are high priority
  human_input: 0.8,    // User input is important
  metabob_annotation: 0.7, // Annotations from analysis
  write: 0.6,          // Written content
  read: 0.5,           // Read content
  llm: 0.5,            // LLM responses
  search: 0.4,         // Search results
  memo: 0.4,           // Memos
  cpg_embedding: 0.3,  // Code patterns
  extracted: 0.3,      // Extracted data
  impulse_signature: 0.5, // Impulse (pointer_type, shape) signatures
};

/**
 * Source-specific budget defaults
 */
const sourceBudgetDefaults: Record<SourceType, number> = {
  goal: 500,           // Goals are concise
  human_input: 1000,   // User input varies
  memo: 500,           // Memos are brief
  search: 2000,        // Search results can be longer
  llm: 4000,           // LLM responses can be verbose
  metabob_annotation: 1000,
  write: 3000,         // File content
  read: 3000,          // File content
  cpg_embedding: 2000, // Code patterns
  extracted: 2000,     // Extracted data
  impulse_signature: 500, // Signatures have no body content
};

export interface CreateFromSourceParams {
  source_type: SourceType;
  content: string;
  metadata?: Record<string, unknown>;
  summary?: string;
  priority?: number;
  budget?: number;
  scope?: ScopeType;
  public?: boolean;
  project_id?: string;
}

/**
 * Create a concept from a source with automatic shape inference
 */
export async function createConceptFromSource(
  params: CreateFromSourceParams,
  orgId: string,
  jwtToken?: string
): Promise<Concept> {
  const {
    source_type,
    content,
    metadata,
    summary,
    priority,
    budget,
    scope,
    public: isPublic,
    project_id,
  } = params;

  // Infer shape from source type
  const shape = sourceShapeMap[source_type] || 'unknown';

  // Use source-specific defaults
  const finalPriority = priority ?? sourcePriorityDefaults[source_type] ?? 0.5;
  const finalBudget = budget ?? sourceBudgetDefaults[source_type] ?? 2000;

  // Generate summary if not provided
  const finalSummary = summary || generateSummary(content, source_type);

  logger.debug('Creating concept from source', {
    source_type,
    shape,
    priority: finalPriority,
    budget: finalBudget,
    content_length: content.length,
  });

  return createConcept(
    {
      source_type,
      content,
      shape,
      summary: finalSummary,
      priority: finalPriority,
      budget: finalBudget,
      scope,
      public: isPublic,
      project_id,
      metadata,
    },
    orgId,
    jwtToken
  );
}

/**
 * Generate a summary from content based on source type
 */
function generateSummary(content: string, sourceType: SourceType): string {
  const maxLength = 200;

  switch (sourceType) {
    case 'goal':
      // For goals, use the full content if short, or first line
      if (content.length <= maxLength) return content;
      return content.split('\n')[0].slice(0, maxLength);

    case 'human_input':
      // For user input, use first line or truncate
      const firstLine = content.split('\n')[0];
      return firstLine.length <= maxLength ? firstLine : firstLine.slice(0, maxLength - 3) + '...';

    case 'llm':
      // For LLM responses, try to find a leading summary
      const lines = content.split('\n').filter(l => l.trim());
      if (lines[0] && lines[0].length <= maxLength) return lines[0];
      return content.slice(0, maxLength - 3) + '...';

    case 'metabob_annotation':
      // For annotations, extract the problem type if present
      const match = content.match(/^(Problem|Warning|Error|Info):\s*(.+)/i);
      if (match) return `${match[1]}: ${match[2].slice(0, maxLength - match[1].length - 2)}`;
      return content.slice(0, maxLength);

    case 'write':
    case 'read':
      // For file content, try to extract file path from metadata or truncate
      return `File content: ${content.slice(0, maxLength - 15)}...`;

    case 'cpg_embedding':
      // For code patterns, truncate
      return `Code pattern: ${content.slice(0, maxLength - 15)}`;

    case 'search':
      // For search results, use first result or truncate
      return content.slice(0, maxLength);

    case 'memo':
    case 'extracted':
    default:
      // Default truncation
      return content.length <= maxLength ? content : content.slice(0, maxLength - 3) + '...';
  }
}

/**
 * Batch create concepts from multiple sources
 */
export async function createConceptsFromSources(
  sources: CreateFromSourceParams[],
  orgId: string,
  jwtToken?: string
): Promise<Concept[]> {
  const concepts: Concept[] = [];

  for (const source of sources) {
    try {
      const concept = await createConceptFromSource(source, orgId, jwtToken);
      concepts.push(concept);
    } catch (error) {
      logger.warn('Failed to create concept from source', {
        source_type: source.source_type,
        error: (error as Error).message,
      });
    }
  }

  return concepts;
}

/**
 * Get shape for a source type
 */
export function getShapeForSource(sourceType: SourceType): string {
  return sourceShapeMap[sourceType] || 'unknown';
}

/**
 * Get all available source types
 */
export function getAvailableSourceTypes(): SourceType[] {
  return Object.keys(sourceShapeMap) as SourceType[];
}
