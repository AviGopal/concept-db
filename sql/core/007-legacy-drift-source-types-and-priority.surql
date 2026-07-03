-- =============================================================================
-- 007: Reconcile concept.source_type ASSERT with rows that exist in data, and
-- coerce legacy string priorities to floats. Rewritten 2026-07-03: the runner
-- (scripts/apply-schema.ts) mishandles inline comments inside a multi-line
-- DEFINE, and whole-table UPDATEs abort on rows with created_at = NONE, so
-- statements below are single-line and coalesce created_at.
-- =============================================================================

DEFINE FIELD OVERWRITE source_type ON concept TYPE string ASSERT $value INSIDE ['goal', 'memo', 'human_input', 'search', 'llm', 'metabob_annotation', 'write', 'read', 'cpg_embedding', 'extracted', 'impulse_signature', 'vessel_construction_pattern', 'impulse_activity_pattern', 'architectural_pattern_principle', 'architecture_doc', 'doc_expectation'];

UPDATE concept SET priority = 0.25, created_at = created_at ?? time::now() WHERE priority = 'low';

UPDATE concept SET priority = 0.5, created_at = created_at ?? time::now() WHERE priority = 'medium';

UPDATE concept SET priority = 0.75, created_at = created_at ?? time::now() WHERE priority = 'high';
