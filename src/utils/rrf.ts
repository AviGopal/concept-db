/**
 * Reciprocal Rank Fusion (RRF)
 *
 * Merges two ranked lists (BM25 and dense) into a single ranked list using RRF.
 * RRF score = 1/(k + rank_bm25) + 1/(k + rank_dense)
 * where k=60 is the standard smoothing constant (Cormack et al. 2009).
 *
 * Documents present in only one list receive LARGE_RANK for the absent list,
 * ensuring they still score positively but below documents in both lists.
 */

const K = 60;
const LARGE_RANK = 10_000;

/**
 * Merge two ranked result lists using Reciprocal Rank Fusion.
 *
 * @param bm25Results - Results ordered by BM25 relevance (index 0 = best)
 * @param denseResults - Results ordered by cosine similarity (index 0 = best)
 * @returns Merged list ordered by descending RRF score
 */
export function mergeByRRF<T extends { id: string }>(
  bm25Results: T[],
  denseResults: T[]
): T[] {
  const bm25Rank = new Map<string, number>(bm25Results.map((r, i) => [r.id, i + 1]));
  const denseRank = new Map<string, number>(denseResults.map((r, i) => [r.id, i + 1]));

  const allIds = new Set<string>([
    ...bm25Results.map((r) => r.id),
    ...denseResults.map((r) => r.id),
  ]);

  // Deduplicated doc map (prefer bm25 copy)
  const allDocs = new Map<string, T>();
  for (const r of [...denseResults, ...bm25Results]) {
    allDocs.set(r.id, r);
  }

  return [...allIds]
    .map((id) => ({
      doc: allDocs.get(id)!,
      rrf:
        1 / (K + (bm25Rank.get(id) ?? LARGE_RANK)) +
        1 / (K + (denseRank.get(id) ?? LARGE_RANK)),
    }))
    .sort((a, b) => b.rrf - a.rrf)
    .map((x) => x.doc);
}
