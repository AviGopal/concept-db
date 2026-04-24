/**
 * MCP Tool Definitions for concept-db
 *
 * These tools are exposed via the MCP interface for MiniBob and other vessels to use.
 */

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description: string;
      enum?: string[];
      items?: { type: string };
      minimum?: number;
      maximum?: number;
      default?: unknown;
    }>;
    required: string[];
  };
}

export const conceptTools: MCPTool[] = [
  {
    name: 'concept_create',
    description: 'Create a new concept from source data. Concepts are impulses with graph relationships.',
    inputSchema: {
      type: 'object',
      properties: {
        source_type: {
          type: 'string',
          description: 'Type of source that created this concept',
          enum: ['goal', 'memo', 'human_input', 'search', 'llm', 'metabob_annotation', 'write', 'read', 'cpg_embedding', 'extracted'],
        },
        content: {
          type: 'string',
          description: 'The content of the concept',
        },
        shape: {
          type: 'string',
          description: 'Shape/type of the concept (inferred from source_type if not provided)',
        },
        summary: {
          type: 'string',
          description: 'Brief summary of the concept (for display)',
        },
        priority: {
          type: 'number',
          description: 'Initial priority (0.0-1.0)',
          minimum: 0,
          maximum: 1,
          default: 0.5,
        },
        budget: {
          type: 'number',
          description: 'Token budget for this concept',
          default: 2000,
        },
        scope: {
          type: 'string',
          description: 'Visibility scope',
          enum: ['global', 'org', 'project'],
          default: 'org',
        },
        public: {
          type: 'boolean',
          description: 'Whether concept is publicly visible (only for global scope)',
          default: false,
        },
        project_id: {
          type: 'string',
          description: 'Project ID for project-scoped concepts',
        },
      },
      required: ['source_type', 'content'],
    },
  },
  {
    name: 'concept_resolve',
    description: 'Resolve a concept and create a resolution snapshot. Returns the concept with loaded content and metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        concept_id: {
          type: 'string',
          description: 'ID of the concept to resolve',
        },
        include_neighbors: {
          type: 'boolean',
          description: 'Whether to include neighboring concepts in the response',
          default: false,
        },
        neighbor_depth: {
          type: 'number',
          description: 'Depth of neighbor traversal (1 = immediate neighbors)',
          default: 1,
        },
      },
      required: ['concept_id'],
    },
  },
  {
    name: 'concept_link',
    description: 'Create a typed edge between two concepts',
    inputSchema: {
      type: 'object',
      properties: {
        from_concept_id: {
          type: 'string',
          description: 'ID of the source concept',
        },
        to_concept_id: {
          type: 'string',
          description: 'ID of the target concept',
        },
        edge_type: {
          type: 'string',
          description: 'Type of relationship',
          enum: ['related_to', 'derived_from', 'resolves_to', 'sequence_next', 'sequence_prev', 'description_of', 'example_of', 'contradicts'],
        },
        description: {
          type: 'string',
          description: 'Optional description of the relationship',
        },
        weight: {
          type: 'number',
          description: 'Edge weight (0.0-1.0)',
          minimum: 0,
          maximum: 1,
          default: 0.5,
        },
      },
      required: ['from_concept_id', 'to_concept_id', 'edge_type'],
    },
  },
  {
    name: 'concept_search',
    description: 'Search for concepts by content, shape, or source type',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text search query for concept content/summary',
        },
        shape: {
          type: 'string',
          description: 'Filter by shape',
        },
        source_type: {
          type: 'string',
          description: 'Filter by source type',
          enum: ['goal', 'memo', 'human_input', 'search', 'llm', 'metabob_annotation', 'write', 'read', 'cpg_embedding', 'extracted'],
        },
        min_relevance: {
          type: 'number',
          description: 'Minimum relevance score',
          minimum: 0,
          maximum: 1,
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return',
          default: 20,
        },
        offset: {
          type: 'number',
          description: 'Offset for pagination',
          default: 0,
        },
      },
      required: [],
    },
  },
  {
    name: 'concept_neighbors',
    description: 'Get graph neighbors of a concept',
    inputSchema: {
      type: 'object',
      properties: {
        concept_id: {
          type: 'string',
          description: 'ID of the concept to get neighbors for',
        },
        edge_types: {
          type: 'array',
          description: 'Filter by edge types',
          items: { type: 'string' },
        },
        direction: {
          type: 'string',
          description: 'Direction of edges to follow',
          enum: ['outgoing', 'incoming', 'both'],
          default: 'both',
        },
        limit: {
          type: 'number',
          description: 'Maximum neighbors to return',
          default: 10,
        },
      },
      required: ['concept_id'],
    },
  },
  {
    name: 'concept_record_usage',
    description: 'Record that a concept was used in an execution, with outcome for learning',
    inputSchema: {
      type: 'object',
      properties: {
        concept_id: {
          type: 'string',
          description: 'ID of the concept that was used',
        },
        trace_id: {
          type: 'string',
          description: 'ID of the execution trace',
        },
        activity_id: {
          type: 'string',
          description: 'ID of the activity (if applicable)',
        },
        task_id: {
          type: 'string',
          description: 'ID of the task (if applicable)',
        },
        outcome: {
          type: 'string',
          description: 'Outcome of the execution',
          enum: ['success', 'failure', 'neutral'],
        },
      },
      required: ['concept_id', 'trace_id', 'outcome'],
    },
  },
  {
    name: 'concept_upsert_by_signature',
    description:
      'Idempotently upsert a concept keyed on an impulse signature (pointer_type, shape). Returns the concept id and whether it was newly created. Used by learn-impulse-relationships to materialise one concept per unique impulse signature seen in traces.',
    inputSchema: {
      type: 'object',
      properties: {
        pointer_type: {
          type: 'string',
          description: 'The impulse pointer type (e.g. "file", "concept", "activityExecutionTrace")',
        },
        shape: {
          type: 'string',
          description: 'The impulse shape (e.g. "file", "concept", "activityExecutionTrace")',
        },
      },
      required: ['pointer_type', 'shape'],
    },
  },
  {
    name: 'concept_cooccurrence_edges',
    description:
      'Return co-occurrence edges between impulse-signature concepts, sorted by weight DESC. Optionally filter by a (pointer_type, shape) signature to get edges touching that signature. Used by activities to query the learned impulse relationship graph without going through /v2/impulses/resolve.',
    inputSchema: {
      type: 'object',
      properties: {
        pointer_type: {
          type: 'string',
          description: 'Optional pointer_type filter. If paired with `shape`, keeps only edges touching that signature.',
        },
        shape: {
          type: 'string',
          description: 'Optional shape filter. If paired with `pointer_type`, keeps only edges touching that signature.',
        },
        min_weight: {
          type: 'number',
          description: 'Minimum edge weight (0.0-1.0)',
          minimum: 0,
          maximum: 1,
        },
        limit: {
          type: 'number',
          description: 'Maximum edges to return (default 100)',
          default: 100,
        },
      },
      required: [],
    },
  },
  {
    name: 'concept_sequence_record',
    description: 'Record a sequence of concepts that were resolved together, creating sequence edges',
    inputSchema: {
      type: 'object',
      properties: {
        concept_ids: {
          type: 'array',
          description: 'Ordered list of concept IDs that were resolved in sequence',
          items: { type: 'string' },
        },
        trace_id: {
          type: 'string',
          description: 'ID of the execution trace',
        },
      },
      required: ['concept_ids', 'trace_id'],
    },
  },
];

/**
 * Get tool by name
 */
export function getToolByName(name: string): MCPTool | undefined {
  return conceptTools.find(t => t.name === name);
}
