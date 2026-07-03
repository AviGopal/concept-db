-- 2205 concept rows carry source_type values absent from migration 006's closed ASSERT list
-- (recurring_code_problem 510, doc_expectation 1581, architecture_doc 104, problem_detection 2,
-- plus singletons backfill_v2, code_quality_finding, decision, http_fetch_json_extract, pattern,
-- trace_summary, and 2 NULL rows), and 520 rows have created_at NONE;
-- SCHEMAFULL revalidation therefore rejects EVERY update to those rows, so
-- relevance/passive-usage learning is dead for them.
-- src/models/schemas.ts deliberately made SourceTypeSchema an OPEN string
-- (closed enums are connectivity barriers per its own comment) — this migration
-- aligns the DB ASSERT with that contract instead of re-arming the same failure
-- with a longer list. The UPDATE statements are idempotent (WHERE ... IS NONE).

DEFINE FIELD OVERWRITE source_type ON concept TYPE string ASSERT string::len($value) > 0;

UPDATE concept SET source_type = 'unknown' WHERE source_type IS NONE;

UPDATE concept SET created_at = updated_at WHERE created_at IS NONE AND updated_at IS NOT NONE;

UPDATE concept SET created_at = time::now() WHERE created_at IS NONE;