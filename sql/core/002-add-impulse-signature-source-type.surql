-- =============================================================================
-- concept-db: Add `impulse_signature` source type
-- Enables concepts that represent a (pointer_type, shape) signature of an
-- impulse — used by the `learn-impulse-relationships` activity to record
-- which impulse shapes co-occur in executions and build a co-occurrence
-- graph over the signatures.
-- =============================================================================

-- Redefine the `source_type` ASSERT on `concept` to include `impulse_signature`.
-- SurrealDB's `DEFINE FIELD` is idempotent (re-definition replaces the prior
-- ASSERT), so re-running this migration is safe.
DEFINE FIELD source_type ON concept TYPE string
  ASSERT $value IN [
    'goal',               -- From goal processing
    'memo',               -- Inline memo
    'human_input',        -- User request/input
    'search',             -- Search result
    'llm',                -- LLM-generated content
    'metabob_annotation', -- Metabob code annotation
    'write',              -- Written file content
    'read',               -- Read file content
    'cpg_embedding',      -- Code pattern graph embedding
    'extracted',          -- Extracted from execution trace
    'impulse_signature'   -- (pointer_type, shape) signature of an impulse
  ];
