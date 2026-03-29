-- =============================================================================
-- concept-db: Core Tables
-- Concepts as impulses with graph relationships
-- =============================================================================

-- -----------------------------------------------------------------------------
-- concept table (extends impulse pattern)
-- Concepts ARE impulses with metadata for graph-based reasoning
-- -----------------------------------------------------------------------------
DEFINE TABLE concept SCHEMAFULL
  PERMISSIONS
    FOR select WHERE (scope = 'global' AND public = true) OR org_id = $auth.org_id
    FOR create, update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

-- Core impulse fields (matching impulse pattern)
DEFINE FIELD id ON concept TYPE string;
DEFINE FIELD pointer ON concept TYPE object;
DEFINE FIELD shape ON concept TYPE string;
DEFINE FIELD summary ON concept TYPE option<string>;
DEFINE FIELD content ON concept TYPE option<string>;
DEFINE FIELD token_estimate ON concept TYPE option<int>;
DEFINE FIELD budget ON concept TYPE int DEFAULT 2000;

-- Concept-specific: source tracking
DEFINE FIELD source_type ON concept TYPE string
  ASSERT $value IN [
    'goal',              -- From goal processing
    'memo',              -- Inline memo
    'human_input',       -- User request/input
    'search',            -- Search result
    'llm',               -- LLM-generated content
    'metabob_annotation',-- Metabob code annotation
    'write',             -- Written file content
    'read',              -- Read file content
    'cpg_embedding',     -- Code pattern graph embedding
    'extracted'          -- Extracted from execution trace
  ];

-- Learning metrics (for Thompson Sampling and relevance)
DEFINE FIELD priority ON concept TYPE float DEFAULT 0.5
  ASSERT $value >= 0.0 AND $value <= 1.0;
DEFINE FIELD relevance ON concept TYPE float DEFAULT 0.5
  ASSERT $value >= 0.0 AND $value <= 1.0;
DEFINE FIELD times_loaded ON concept TYPE int DEFAULT 0;
DEFINE FIELD times_succeeded ON concept TYPE int DEFAULT 0;
DEFINE FIELD times_failed ON concept TYPE int DEFAULT 0;

-- Resolution snapshot: captured when concept is resolved
DEFINE FIELD resolution_snapshot ON concept TYPE option<object>;
-- {
--   resolved_at: datetime,
--   content_hash: string,
--   neighbor_ids: string[],
--   token_count: int
-- }

-- Multi-tenant scoping
DEFINE FIELD scope ON concept TYPE string
  ASSERT $value IN ['global', 'org', 'project']
  DEFAULT 'org';
DEFINE FIELD public ON concept TYPE bool DEFAULT false;
DEFINE FIELD org_id ON concept TYPE string;
DEFINE FIELD project_id ON concept TYPE option<string>;

-- Timestamps
DEFINE FIELD created_at ON concept TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at ON concept TYPE datetime VALUE time::now();

-- Indexes for efficient querying
DEFINE INDEX idx_concept_org ON concept FIELDS org_id;
DEFINE INDEX idx_concept_scope ON concept FIELDS scope, public;
DEFINE INDEX idx_concept_source ON concept FIELDS source_type;
DEFINE INDEX idx_concept_shape ON concept FIELDS shape;
DEFINE INDEX idx_concept_relevance ON concept FIELDS relevance;
DEFINE INDEX idx_concept_project ON concept FIELDS project_id;

-- -----------------------------------------------------------------------------
-- concept_edge table (graph relationships)
-- Edges connect concepts with typed, weighted relationships
-- -----------------------------------------------------------------------------
DEFINE TABLE concept_edge SCHEMAFULL
  PERMISSIONS
    FOR select, create, update, delete WHERE org_id = $auth.org_id;

DEFINE FIELD id ON concept_edge TYPE string;
DEFINE FIELD from_concept ON concept_edge TYPE record<concept>;
DEFINE FIELD to_concept ON concept_edge TYPE record<concept>;
DEFINE FIELD edge_type ON concept_edge TYPE string
  ASSERT $value IN [
    'related_to',      -- General relationship
    'derived_from',    -- Parent-child derivation
    'resolves_to',     -- Resolution pointer
    'sequence_next',   -- Next in execution sequence
    'sequence_prev',   -- Previous in execution sequence
    'description_of',  -- Describes another concept
    'example_of',      -- Example of a pattern/concept
    'contradicts'      -- Contradictory information
  ];
DEFINE FIELD description ON concept_edge TYPE option<string>;
DEFINE FIELD weight ON concept_edge TYPE float DEFAULT 0.5
  ASSERT $value >= 0.0 AND $value <= 1.0;
DEFINE FIELD times_traversed ON concept_edge TYPE int DEFAULT 0;
DEFINE FIELD org_id ON concept_edge TYPE string;
DEFINE FIELD created_at ON concept_edge TYPE datetime DEFAULT time::now();

-- Indexes for graph traversal
DEFINE INDEX idx_edge_from ON concept_edge FIELDS from_concept;
DEFINE INDEX idx_edge_to ON concept_edge FIELDS to_concept;
DEFINE INDEX idx_edge_type ON concept_edge FIELDS edge_type;
DEFINE INDEX idx_edge_org ON concept_edge FIELDS org_id;

-- Unique constraint: only one edge of each type between two concepts
DEFINE INDEX idx_edge_unique ON concept_edge FIELDS from_concept, to_concept, edge_type UNIQUE;

-- -----------------------------------------------------------------------------
-- concept_usage table
-- Tracks concept usage in execution traces for learning
-- -----------------------------------------------------------------------------
DEFINE TABLE concept_usage SCHEMAFULL
  PERMISSIONS
    FOR select, create WHERE org_id = $auth.org_id
    FOR update, delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

DEFINE FIELD id ON concept_usage TYPE string;
DEFINE FIELD concept_id ON concept_usage TYPE record<concept>;
DEFINE FIELD trace_id ON concept_usage TYPE string;
DEFINE FIELD activity_id ON concept_usage TYPE option<string>;
DEFINE FIELD task_id ON concept_usage TYPE option<string>;
DEFINE FIELD outcome ON concept_usage TYPE string
  ASSERT $value IN ['success', 'failure', 'neutral'];
DEFINE FIELD org_id ON concept_usage TYPE string;
DEFINE FIELD recorded_at ON concept_usage TYPE datetime DEFAULT time::now();

DEFINE INDEX idx_usage_concept ON concept_usage FIELDS concept_id;
DEFINE INDEX idx_usage_trace ON concept_usage FIELDS trace_id;
DEFINE INDEX idx_usage_org ON concept_usage FIELDS org_id;
