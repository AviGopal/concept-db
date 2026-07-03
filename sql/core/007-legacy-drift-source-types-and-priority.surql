-- =============================================================================
-- 007: Reconcile the concept.source_type ASSERT with rows that exist in data,
-- and coerce legacy string priorities to floats.
--
-- The 2026-07-03 credit decontamination (conceptCreditDecontaminate_write) had
-- to skip 9 rows because their UPDATE failed SCHEMAFULL revalidation:
-- source_type 'architecture_doc' / 'doc_expectation' (doc-ingest concepts
-- written before strict validation) are absent from the 006 enum, and some
-- rows carry priority 'low' (string) where the field expects a float.
-- DEFINE FIELD OVERWRITE replaces the prior ASSERT (SurrealDB 2.x requires
-- OVERWRITE; plain DEFINE errors 'already exists' and apply-schema swallows it).
-- The UPDATEs are idempotent data repairs.
-- =============================================================================

DEFINE FIELD OVERWRITE source_type ON concept TYPE string
  ASSERT $value IN [
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
    'vessel_construction_pattern',
    'impulse_activity_pattern',
    'architectural_pattern_principle',
    'architecture_doc',                -- docs-expectation-ingest architecture sections
    'doc_expectation'                  -- docs-expectation-ingest doc sections
  ];

UPDATE concept SET priority = 0.25 WHERE priority = 'low';
UPDATE concept SET priority = 0.5 WHERE priority = 'medium';
UPDATE concept SET priority = 0.75 WHERE priority = 'high';
