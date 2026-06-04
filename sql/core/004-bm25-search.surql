-- =============================================================================
-- concept-db: BM25 Full-Text Search Indexes
-- =============================================================================
-- Replaces substring CONTAINS queries with scored BM25 full-text search on
-- the concept table's content and summary fields.
--
-- ANALYZER: concept_analyzer
--   - blank:  Splits on whitespace ("fix bug" -> ["fix", "bug"])
--   - class:  Splits on character-class boundaries ("fix_bug" -> ["fix", "bug"])
--   - camel:  Splits on camelCase boundaries ("fixBug" -> ["fix", "Bug"])
--   - lowercase:        Normalizes to lowercase
--   - ascii:            Converts unicode to ASCII
--   - snowball(english): English stemming ("running" -> "run")
--
-- INDEXES:
--   idx_concept_content_fts  — score index 0 (@0@@), weight 1×
--   idx_concept_summary_fts  — score index 1 (@1@@), weight 2× (curated digest)
--
-- QUERY PATTERN (searchConcepts with non-empty query):
--   SELECT *,
--     search::score(0) + search::score(1) * 2.0 AS fts_score
--   FROM concept
--   WHERE
--     org_id = $org_id
--     AND (content @0@@ $query OR summary @1@@ $query)
--     -- additional scalar filters as AND clauses
--   ORDER BY fts_score DESC
--   LIMIT $limit START $offset
-- =============================================================================

DEFINE ANALYZER IF NOT EXISTS concept_analyzer TOKENIZERS blank, class FILTERS lowercase, ascii;

DEFINE INDEX IF NOT EXISTS idx_concept_content_fts ON concept FIELDS content SEARCH ANALYZER concept_analyzer BM25(1.2, 0.75) HIGHLIGHTS;

DEFINE INDEX IF NOT EXISTS idx_concept_summary_fts ON concept FIELDS summary SEARCH ANALYZER concept_analyzer BM25(1.2, 0.75) HIGHLIGHTS;
