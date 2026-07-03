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

UPDATE concept SET source_type = source_type ?? 'unknown', priority = priority ?? 0.5, scope = scope ?? 'org', created_at = created_at ?? updated_at ?? time::now() WHERE source_type IS NONE OR priority IS NONE OR scope IS NONE OR created_at IS NONE;
-- Coalesced into one statement so SCHEMAFULL revalidation sees all required fields set on every touched row (fixes concept:0jcr3u5kbes8g8nqxsl8 and concept:halgy2em9lumgivvsat1 which had both priority AND scope NONE).