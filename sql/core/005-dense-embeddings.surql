-- ============================================================================
-- Dense Embeddings for all-MiniLM-L6-v2 (384-dim) — 005-dense-embeddings
-- ============================================================================
-- Adds content_embedding and summary_embedding fields to the concept table
-- for local dense vector search via LocalEmbeddingService (ONNX Runtime).
--
-- Search is done in-process (O(n) cosine scan); an HNSW index can be added
-- once volume justifies it.
-- ============================================================================

DEFINE FIELD IF NOT EXISTS content_embedding ON concept
  TYPE option<array<float>>
  COMMENT "all-MiniLM-L6-v2 embedding of concept content (384-dim, L2-normalised)";

DEFINE FIELD IF NOT EXISTS summary_embedding ON concept
  TYPE option<array<float>>
  COMMENT "all-MiniLM-L6-v2 embedding of concept summary (384-dim, L2-normalised)";
