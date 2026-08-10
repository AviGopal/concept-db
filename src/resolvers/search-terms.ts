/**
 * Turn a free-text query into the term-sets a MATCHES (`@@`) search can actually hit.
 *
 * WHY. `content @@ '<terms>'` requires EVERY analysed term to be present — it is AND,
 * not OR. Proven against the live index 2026-08-10:
 *
 *   "anchor"                  -> 2 rows
 *   "verbatim"                -> 2 rows
 *   "anchor verbatim"         -> 1 row     (the intersection)
 *   "anchor verbatim zzqqxx"  -> 0 rows    (one absent term kills the whole match)
 *   "anchor zzqqxx"           -> 0 rows
 *
 * The caller sanitises to 200 CHARACTERS but never caps TERMS, so a real query — a
 * spec, a goal, a gap summary — arrives as ~30 terms that no single row contains, and
 * returns 0. Measured end to end: 25 chars returned a row; 50, 80, 120, 160, 200 and
 * 280 all returned none. Every consumer with genuine text to search with therefore
 * gets nothing and silently falls back, which is why the substrate's drafter has no
 * working relevance recall.
 *
 * The fix is progressive relaxation: try the most distinctive few terms, then fewer,
 * then the single best. Each rung is strictly more permissive than the last, so the
 * first non-empty rung is the most specific match available rather than the widest.
 */

/** Words that carry no discriminating power in a code/ops corpus. */
const STOP = new Set([
  "the", "and", "for", "that", "this", "with", "from", "into", "onto", "when", "then",
  "than", "must", "not", "但", "are", "was", "were", "has", "have", "had", "its", "it",
  "a", "an", "of", "to", "in", "on", "is", "be", "by", "as", "at", "or", "if", "so",
  "which", "what", "where", "who", "whom", "how", "why", "all", "any", "some", "each",
  "every", "other", "only", "also", "very", "such", "same", "more", "most", "less",
  "can", "will", "would", "should", "could", "may", "might", "does", "did", "done",
  "one", "two", "three", "first", "last", "next", "new", "old", "before", "after",
  "because", "while", "during", "without", "within", "between", "against", "about",
]);

/**
 * Distinctive terms, most discriminating first.
 *
 * Ranked by length as a cheap proxy for rarity: in this corpus the long tokens are the
 * identifiers and failure-class names (`anchor_not_found`, `old_string`) and the short
 * ones are prose. Underscored/dotted tokens are kept whole — they are the names that
 * actually appear in both the request and the stored lesson.
 */
export function distinctiveTerms(query: string): string[] {
  if (typeof query !== "string" || !query.trim()) return [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of query.split(/[^A-Za-z0-9_.$-]+/)) {
    const t = raw.trim().replace(/^[.\-]+|[.\-]+$/g, "");
    if (t.length < 4 || t.length > 60) continue;
    const lower = t.toLowerCase();
    if (STOP.has(lower)) continue;
    if (/^\d+$/.test(t)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    terms.push(t);
  }
  return terms.sort((a, b) => b.length - a.length);
}

/**
 * The ladder of term-sets to try, widest recall LAST.
 *
 * Returns the ORIGINAL query first so an already-narrow query behaves exactly as it
 * does today (no behaviour change for callers that were working), then progressively
 * fewer terms. Empty when there is nothing usable to search with.
 */
export function searchTermLadder(query: string): string[] {
  const original = (query ?? "").replace(/['"\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  const terms = distinctiveTerms(query);
  const rungs: string[] = [];
  const push = (s: string) => {
    const v = s.trim();
    if (v && !rungs.includes(v)) rungs.push(v);
  };
  push(original);              // unchanged behaviour for short queries
  if (terms.length > 3) push(terms.slice(0, 3).join(" "));
  if (terms.length > 2) push(terms.slice(0, 2).join(" "));
  if (terms.length > 1) push(terms[0]!);
  return rungs;
}
