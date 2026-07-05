-- ============================================================================
-- Dense Embeddings for all-MiniLM-L6-v2 (384-dim) — 005-dense-embeddings
-- ============================================================================
-- Adds content_embedding and summary_embedding fields to the concept table
-- for local dense vector search via LocalEmbeddingService (ONNX Runtime).
--
-- Search is done in-process (O(n) cosine scan). An HNSW index can be added
-- once volume justifies it. NOTE: keep comment lines free of semicolons.
-- apply-schema.ts splits statements on the semicolon character before it
-- strips comment lines, so a semicolon inside a comment orphans the tail of
-- the comment into the next chunk and silently breaks the statement that
-- follows. That is exactly how the content_embedding DEFINE below failed to
-- apply until 2026-07-05.
-- ============================================================================

DEFINE FIELD IF NOT EXISTS content_embedding ON concept
  TYPE option<array<float>>
  COMMENT "all-MiniLM-L6-v2 embedding of concept content (384-dim, L2-normalised)";

DEFINE FIELD IF NOT EXISTS summary_embedding ON concept
  TYPE option<array<float>>
  COMMENT "all-MiniLM-L6-v2 embedding of concept summary (384-dim, L2-normalised)";
