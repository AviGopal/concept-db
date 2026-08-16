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
  // THE LAST RUNG MUST NOT DROP THE SUBJECT (2026-08-16).
  //
  // Terms are ordered by LENGTH as a rarity proxy, which holds for the identifier-heavy
  // lessons this was written for (`anchor_not_found` beats `error`) and inverts for prose
  // questions, where the long words are the generic ones. Measured against the live store:
  //
  //   query "astronomical distance ganymede"
  //     ladder -> ["astronomical distance ganymede", "astronomical distance", "astronomical"]
  //     hits   ->  0                                  0                        0
  //   but the DROPPED term retrieves it:
  //     "ganymede" -> 1 hit (the NAIF-id concept the walk needed)
  //
  // Every rung narrowed toward the most generic word and discarded the only discriminating
  // one, so a seeded fact sat in the store and was unreachable by the phrasing that needed it.
  //
  // Append the query's LAST distinctive term as a final rung. Word order carries specificity in
  // English noun phrases — "astronomical distance ganymede" is about ganymede, "horizons naif id"
  // is about the id — so the trailing term is the subject far more often than the longest one is.
  // Appended rather than substituted: every existing rung is tried first in its existing order,
  // so this can only ADD recall, never change what a working query already returns. `push`
  // dedupes, so a single-term query is unaffected.
  if (terms.length > 1) {
    // `terms` is sorted by length; recover the term that appeared LAST in the original query.
    const inQueryOrder = query.split(/[^A-Za-z0-9_.$-]+/).map((t) => t.trim()).filter(Boolean);
    const termSet = new Set(terms.map((t) => t.toLowerCase()));
    const trailing = [...inQueryOrder].reverse().find((t) => termSet.has(t.toLowerCase()));
    if (trailing) push(trailing);
  }
  return rungs;
}
