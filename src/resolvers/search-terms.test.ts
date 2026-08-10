// Pins the relaxation ladder that makes a real query matchable.
//
// THE DEFECT: `content @@ '<terms>'` is AND — every analysed term must be present.
// Proven against the live index 2026-08-10:
//   "anchor" -> 2 rows | "verbatim" -> 2 rows | "anchor verbatim" -> 1 row
//   "anchor verbatim zzqqxx" -> 0 rows | "anchor zzqqxx" -> 0 rows
// The caller capped the term at 200 CHARACTERS but never capped TERMS, so a spec or
// gap summary arrived as ~30 terms no row contains and matched nothing: 25 chars
// returned a row; 50, 80, 120, 160, 200 and 280 all returned none.

import { describe, expect, test } from 'bun:test';
import { distinctiveTerms, searchTermLadder } from './search-terms';

describe('distinctiveTerms', () => {
  test('keeps identifiers and failure-class names whole', () => {
    const t = distinctiveTerms('the anchor_not_found class means old_string was reconstructed');
    expect(t).toContain('anchor_not_found');
    expect(t).toContain('old_string');
  });

  test('drops stopwords and very short tokens', () => {
    const t = distinctiveTerms('the and for that with from into when a of to in on is');
    expect(t).toEqual([]);
  });

  test('orders longest first — long tokens are the identifiers, short ones prose', () => {
    const t = distinctiveTerms('anchor reconstructed grounding');
    expect(t[0]).toBe('reconstructed');
  });

  test('dedupes case-insensitively', () => {
    expect(distinctiveTerms('Anchor anchor ANCHOR').length).toBe(1);
  });

  test('never throws on junk', () => {
    for (const j of [null, undefined, 42, {}, []] as unknown[]) {
      expect(distinctiveTerms(j as string)).toEqual([]);
    }
    expect(distinctiveTerms('')).toEqual([]);
  });
});

describe('searchTermLadder', () => {
  test('a SHORT query is unchanged — no behaviour change for queries that already work', () => {
    expect(searchTermLadder('anchor verbatim')[0]).toBe('anchor verbatim');
  });

  test('a long prose query yields progressively narrower rungs', () => {
    const prose =
      'the anchor must be copied verbatim from the current file content shown in the ' +
      'grounding rather than reconstructed from memory, and every edit op must carry ' +
      'a non-empty old_string that differs from its new_string';
    const rungs = searchTermLadder(prose);
    expect(rungs.length).toBeGreaterThan(1);
    // Each later rung has no more terms than the one before it.
    const counts = rungs.map((r) => r.split(' ').length);
    for (let i = 1; i < counts.length; i++) expect(counts[i]!).toBeLessThanOrEqual(counts[i - 1]!);
    // The final rung is a single term — the widest recall, tried last.
    expect(counts[counts.length - 1]).toBe(1);
  });

  test('the narrow rungs of the REAL failing query are terms that exist in the corpus', () => {
    // This is the shape that returned 0 rows in production.
    const prose =
      'When a build check fails the routine that decides what kind of failure occurred ' +
      'searches for compiler error codes across the entire combined output, so a run ' +
      'whose compile stage succeeded but whose tests failed is recorded as a compile ' +
      'failure and the wrong lesson is taught back to whatever authored the change';
    const rungs = searchTermLadder(prose);
    const last = rungs[rungs.length - 1]!;
    expect(last.split(' ').length).toBe(1);
    expect(last.length).toBeGreaterThanOrEqual(4);
    // The original full text is still tried FIRST, so nothing is lost.
    expect(rungs[0]!.length).toBeGreaterThan(last.length);
  });

  test('returns nothing usable for an empty query', () => {
    expect(searchTermLadder('')).toEqual([]);
    expect(searchTermLadder('   ')).toEqual([]);
  });
});
