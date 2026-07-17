-- 009: HNSW vector indexes for dense embedding search.
--
-- NOTE: apply-schema.ts splits this file on the semicolon character BEFORE it
-- strips comment lines, so comments here MUST NOT contain a semicolon -- one in
-- a comment orphans the rest of the line as a bogus statement and corrupts the
-- next real one (which silently dropped idx_concept_summary_hnsw on first try).
--
-- Before this, searchConceptsByDense (src/resolvers/concept.ts) ran a dense
-- query of the form "SELECT *, vector::similarity::cosine(field, query) ORDER BY
-- score DESC LIMIT k" with NO vector index. SurrealDB therefore computed cosine
-- for EVERY row and sorted the whole table, materialising all ~39K concept rows
-- (incl. the large content field) into memory -- ballooning the surreal process
-- to ~30GB and triggering a host OOM that killed surreal, crash-looping
-- concept-db (observed 2026-07-17: 9 OOM-kills, 26 surreal restarts).
--
-- These HNSW indexes let the KNN operator fetch only the top-K nearest through
-- the index instead of a full scan. Embeddings are 384-dim (all-MiniLM-L6-v2)
-- and the field uses cosine distance. A read-only audit on 2026-07-17 confirmed
-- 0 of 39,291 summary and 6,872 content embeddings carry a non-384 length, so a
-- fixed-DIMENSION index builds cleanly with no pre-cleanup. The build reads only
-- the embedding vectors (~60MB), not the row bodies, so it does not OOM.
--
-- Idempotent (IF NOT EXISTS). The summary index (39K rows) is the slow one, so
-- concept-db carries a raised TimeoutStartSec drop-in for the one-time build.

DEFINE INDEX IF NOT EXISTS idx_concept_summary_hnsw ON concept FIELDS summary_embedding HNSW DIMENSION 384 DIST COSINE TYPE F32;

DEFINE INDEX IF NOT EXISTS idx_concept_content_hnsw ON concept FIELDS content_embedding HNSW DIMENSION 384 DIST COSINE TYPE F32;
