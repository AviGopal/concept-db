/**
 * Zod schemas for concept-db
 * Defines validation for concepts, edges, and API requests
 */

import { z } from 'zod';

// =============================================================================
// Source Types
// =============================================================================

export const SourceTypeSchema = z.enum([
  'goal',
  'memo',
  'human_input',
  'search',
  'llm',
  'metabob_annotation',
  'write',
  'read',
  'cpg_embedding',
  'extracted',
  'impulse_signature',
  // Phase 22 (Autonomous Vessel Forge): concepts extracted from architecture
  // docs for forge LLM resolvers. Queryable via
  // GET /concepts/search?source_type=vessel_construction_pattern
  // GET /concepts/search?source_type=impulse_activity_pattern
  'vessel_construction_pattern',
  'impulse_activity_pattern',
  // Pre-lift bootstrap (2026-06-03, openspec change
  // 2026-06-03-pre-lift-bootstrap-and-architectural-aware-loop):
  // Architectural pattern / principle concepts. Foundation-doc sections and
  // operator-articulated insights from session findings are stored under this
  // source_type so the four horizon detectors
  // (vessel_responsibility_audit, vessel_architecture_pattern_scan,
  //  activity_lifecycle_audit, resolver_distribution_audit)
  // can derive check predicates from concept-db rather than encoding them in
  // resolver source. Adding a new principle = adding a concept; detectors
  // pick up the new principle on the next dispatch.
  'architectural_pattern_principle',
]);

export type SourceType = z.infer<typeof SourceTypeSchema>;

// =============================================================================
// Edge Types
// =============================================================================

export const EdgeTypeSchema = z.enum([
  'related_to',
  'derived_from',
  'resolves_to',
  'sequence_next',
  'sequence_prev',
  'description_of',
  'example_of',
  'contradicts',
]);

export type EdgeType = z.infer<typeof EdgeTypeSchema>;

// =============================================================================
// Scope Types
// =============================================================================

export const ScopeTypeSchema = z.enum(['global', 'org', 'project']);

export type ScopeType = z.infer<typeof ScopeTypeSchema>;

// =============================================================================
// Pointer Schema (impulse pointer pattern)
// =============================================================================

export const PointerSchema = z.object({
  type: z.string(),
  path: z.string().optional(),
  url: z.string().optional(),
  query: z.string().optional(),
  offset: z.number().optional(),
  limit: z.number().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type Pointer = z.infer<typeof PointerSchema>;

// =============================================================================
// Resolution Snapshot
// =============================================================================

export const ResolutionSnapshotSchema = z.object({
  resolved_at: z.string().datetime(),
  content_hash: z.string(),
  neighbor_ids: z.array(z.string()),
  token_count: z.number(),
});

export type ResolutionSnapshot = z.infer<typeof ResolutionSnapshotSchema>;

// =============================================================================
// Concept Schema
// =============================================================================

export const ConceptSchema = z.object({
  id: z.string(),
  pointer: PointerSchema,
  shape: z.string(),
  summary: z.string().optional().nullable(),
  content: z.string().optional().nullable(),
  token_estimate: z.number().optional().nullable(),
  budget: z.number().default(2000),
  source_type: SourceTypeSchema,
  priority: z.number().min(0).max(1).default(0.5),
  relevance: z.number().min(0).max(1).default(0.5),
  times_loaded: z.number().default(0),
  times_succeeded: z.number().default(0),
  times_failed: z.number().default(0),
  resolution_snapshot: ResolutionSnapshotSchema.optional().nullable(),
  scope: ScopeTypeSchema.default('org'),
  public: z.boolean().default(false),
  org_id: z.string(),
  project_id: z.string().optional().nullable(),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
});

export type Concept = z.infer<typeof ConceptSchema>;

// =============================================================================
// Concept Edge Schema
// =============================================================================

export const ConceptEdgeSchema = z.object({
  id: z.string(),
  from_concept: z.string(), // record<concept> as string
  to_concept: z.string(),   // record<concept> as string
  edge_type: EdgeTypeSchema,
  description: z.string().optional().nullable(),
  weight: z.number().min(0).max(1).default(0.5),
  times_traversed: z.number().default(0),
  org_id: z.string(),
  created_at: z.string().datetime().optional(),
});

export type ConceptEdge = z.infer<typeof ConceptEdgeSchema>;

// =============================================================================
// Concept Usage Schema
// =============================================================================

export const OutcomeSchema = z.enum(['success', 'failure', 'neutral']);

export type Outcome = z.infer<typeof OutcomeSchema>;

export const ConceptUsageSchema = z.object({
  id: z.string(),
  concept_id: z.string(),
  trace_id: z.string(),
  activity_id: z.string().optional().nullable(),
  task_id: z.string().optional().nullable(),
  outcome: OutcomeSchema,
  org_id: z.string(),
  recorded_at: z.string().datetime().optional(),
});

export type ConceptUsage = z.infer<typeof ConceptUsageSchema>;

// =============================================================================
// API Request Schemas
// =============================================================================

export const CreateConceptRequestSchema = z.object({
  source_type: SourceTypeSchema,
  content: z.string(),
  shape: z.string().optional(),
  summary: z.string().optional(),
  priority: z.number().min(0).max(1).optional(),
  budget: z.number().optional(),
  scope: ScopeTypeSchema.optional(),
  public: z.boolean().optional(),
  project_id: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  // Full pointer envelope from caller. When present, takes precedence over
  // the synthesized {type:"memo", metadata} pointer. Callers (e.g. the
  // metabob-mcp `concept_create` tool) use this to attach structured source
  // references like {type, path, section}.
  pointer: z.record(z.unknown()).optional(),
});

export type CreateConceptRequest = z.infer<typeof CreateConceptRequestSchema>;

export const ResolveConceptRequestSchema = z.object({
  concept_id: z.string(),
  include_neighbors: z.boolean().optional().default(false),
  neighbor_depth: z.number().optional().default(1),
});

export type ResolveConceptRequest = z.infer<typeof ResolveConceptRequestSchema>;

export const LinkConceptsRequestSchema = z.object({
  from_concept_id: z.string(),
  to_concept_id: z.string(),
  edge_type: EdgeTypeSchema,
  description: z.string().optional(),
  weight: z.number().min(0).max(1).optional(),
});

export type LinkConceptsRequest = z.infer<typeof LinkConceptsRequestSchema>;

export const SearchConceptsRequestSchema = z.object({
  query: z.string().optional(),
  shape: z.string().optional(),
  // F26: accept either a single source_type or an array. The route handler
  // parses comma-separated query strings into an array; the resolver uses an
  // IN-clause when given an array (>1 element) and single-value equality otherwise.
  // This lets prime_substrate_concepts query bridge-minted impulse_signature
  // concepts AND hand-minted memo/pattern concepts in a single call.
  source_type: z.union([SourceTypeSchema, z.array(SourceTypeSchema)]).optional(),
  min_relevance: z.number().min(0).max(1).optional(),
  limit: z.number().optional().default(20),
  offset: z.number().optional().default(0),
});

export type SearchConceptsRequest = z.infer<typeof SearchConceptsRequestSchema>;

export const GetNeighborsRequestSchema = z.object({
  concept_id: z.string(),
  edge_types: z.array(EdgeTypeSchema).optional(),
  direction: z.enum(['outgoing', 'incoming', 'both']).optional().default('both'),
  limit: z.number().optional().default(10),
});

export type GetNeighborsRequest = z.infer<typeof GetNeighborsRequestSchema>;

export const RecordUsageRequestSchema = z.object({
  concept_id: z.string(),
  trace_id: z.string(),
  activity_id: z.string().optional(),
  task_id: z.string().optional(),
  outcome: OutcomeSchema,
});

export type RecordUsageRequest = z.infer<typeof RecordUsageRequestSchema>;

export const RecordSequenceRequestSchema = z.object({
  concept_ids: z.array(z.string()).min(2),
  trace_id: z.string(),
});

export type RecordSequenceRequest = z.infer<typeof RecordSequenceRequestSchema>;

// =============================================================================
// Impulse Table Schema
// =============================================================================
//
// Concept-db's own `impulse` table — distinct from activity-api's. Stores
// universal-data outputs of resolvers (audit logs, cached query results,
// write-resolver acks). See sql/core/003-impulse-table.surql.

export const ImpulseSchema = z.object({
  id: z.string(),
  pointer: z.record(z.unknown()),
  shape: z.string(),
  summary: z.string().optional().nullable(),
  content: z.string().optional().nullable(),
  metadata: z.record(z.unknown()).optional().nullable(),
  org_id: z.string(),
  project_id: z.string().optional().nullable(),
  created_at: z.string().datetime().optional(),
  created_by_activity_id: z.string().optional().nullable(),
  created_by_resolver_id: z.string().optional().nullable(),
  expires_at: z.string().datetime().optional().nullable(),
});

export type Impulse = z.infer<typeof ImpulseSchema>;

/**
 * Request shape for inserting an impulse via `createImpulse(...)`. `id` is
 * generated by the resolver if omitted; `org_id` is taken from the auth
 * context, not the request body.
 */
export const CreateImpulseRequestSchema = z.object({
  pointer: z.record(z.unknown()),
  shape: z.string(),
  summary: z.string().optional(),
  content: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  project_id: z.string().optional(),
  created_by_activity_id: z.string().optional(),
  created_by_resolver_id: z.string().optional(),
  expires_at: z.string().datetime().optional(),
});

export type CreateImpulseRequest = z.infer<typeof CreateImpulseRequestSchema>;

// =============================================================================
// MCP Tool Call Schema
// =============================================================================

export const MCPToolCallSchema = z.object({
  tool: z.string(),
  arguments: z.record(z.unknown()),
});

export type MCPToolCall = z.infer<typeof MCPToolCallSchema>;
