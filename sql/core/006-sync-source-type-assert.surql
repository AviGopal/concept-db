-- =============================================================================
-- 006: Sync the concept.source_type ASSERT with the application schema.
--
-- src/models/schemas.ts has allowed 'vessel_construction_pattern',
-- 'impulse_activity_pattern' (Phase 22 forge) and
-- 'architectural_pattern_principle' (pre-lift bootstrap 2026-06-03) for weeks,
-- but the DB-level ASSERT was last redefined in 002 and stops at
-- 'impulse_signature'. On a FRESH datastore every seed-concepts insert
-- therefore failed field validation (found 2026-07-02 from-zero boot test);
-- long-lived datastores never hit it because their rows predate strict
-- validation paths. DEFINE FIELD re-definition replaces the prior ASSERT, so
-- re-running is safe. NB: SurrealDB 2.x requires DEFINE FIELD OVERWRITE to
-- replace an existing field — plain DEFINE FIELD errors 'already exists',
-- which apply-schema swallows, so migration 002's redefinition silently never
-- applied on 2.x. OVERWRITE is the load-bearing keyword here.
-- =============================================================================

DEFINE FIELD OVERWRITE source_type ON concept TYPE string
  ASSERT $value IN [
    'goal',                            -- From goal processing
    'memo',                            -- Inline memo
    'human_input',                     -- User request/input
    'search',                          -- Search result
    'llm',                             -- LLM-generated content
    'metabob_annotation',              -- Metabob code annotation
    'write',                           -- Written file content
    'read',                            -- Read file content
    'cpg_embedding',                   -- Code pattern graph embedding
    'extracted',                       -- Extracted from execution trace
    'impulse_signature',               -- (pointer_type, shape) impulse signature
    'vessel_construction_pattern',     -- Phase 22 forge: vessel-construction concepts
    'impulse_activity_pattern',        -- Phase 22 forge: impulse-activity concepts
    'architectural_pattern_principle'  -- Pre-lift bootstrap horizon detectors
  ];
