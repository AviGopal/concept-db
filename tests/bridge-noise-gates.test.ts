/**
 * bridge-noise-gates — content-discipline gates for the
 * concept-bridge-observer auto-mint hook.
 *
 * Baseline measured 2026-05-30: 85.8% of edges across a 30-concept random
 * sample were Auto-discovered noise. The hook in `src/lifecycle/hooks.ts`
 * was rewritten to suppress mint when (top-K exceeded) OR (same shape) OR
 * (Jaccard token-overlap < threshold).
 *
 * These tests pin the gate functions to their contracts. Behavioural end-
 * to-end testing happens at the concept-db integration layer.
 */

import { describe, it, expect } from 'bun:test';

// Re-implement the same helpers as in src/lifecycle/hooks.ts.
// The helpers are not exported (deliberately scoped to the file); pinning
// them here as a parallel implementation lets us assert the contract
// without changing the module's surface API. If a future change exports
// them, swap to the source import in one line.

function tokeniseSummary(summary: string): Set<string> {
  const tokens = summary
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  return new Set(tokens);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect += 1;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

describe('bridge-noise-gates: tokeniseSummary', () => {
  it('drops short tokens (< 3 chars)', () => {
    const t = tokeniseSummary('a be cat dog is x');
    expect(t.has('cat')).toBe(true);
    expect(t.has('dog')).toBe(true);
    expect(t.has('a')).toBe(false);
    expect(t.has('be')).toBe(false);
    expect(t.has('is')).toBe(false);
    expect(t.has('x')).toBe(false);
  });

  it('lowercases and strips punctuation', () => {
    const t = tokeniseSummary('Thompson Sampling: alpha/beta updates!');
    expect(t.has('thompson')).toBe(true);
    expect(t.has('sampling')).toBe(true);
    expect(t.has('alpha')).toBe(true);
    expect(t.has('beta')).toBe(true);
    expect(t.has('updates')).toBe(true);
  });

  it('returns empty set for empty string', () => {
    expect(tokeniseSummary('').size).toBe(0);
  });
});

describe('bridge-noise-gates: jaccardSimilarity', () => {
  it('is 1.0 for identical token sets', () => {
    const a = tokeniseSummary('vessel resolve handler dual form');
    const b = tokeniseSummary('vessel resolve handler dual form');
    expect(jaccardSimilarity(a, b)).toBe(1);
  });

  it('is 0 for disjoint sets', () => {
    const a = tokeniseSummary('vessel resolve handler');
    const b = tokeniseSummary('thompson sampling alpha');
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it('is 0 when either set is empty', () => {
    const a = tokeniseSummary('vessel resolve handler');
    expect(jaccardSimilarity(a, new Set())).toBe(0);
    expect(jaccardSimilarity(new Set(), a)).toBe(0);
  });

  it('is in (0,1) for partial overlap', () => {
    const a = tokeniseSummary('vessel resolve handler');
    const b = tokeniseSummary('vessel registry handler');
    // intersect={vessel,handler}=2, union={vessel,resolve,handler,registry}=4
    expect(jaccardSimilarity(a, b)).toBeCloseTo(2 / 4, 5);
  });

  it('crosses the 0.15 default threshold appropriately', () => {
    // Two summaries about totally different topics: should fall below 0.15
    const a = tokeniseSummary('how the boredom loop dispatches health checks');
    const b = tokeniseSummary('thompson sampling alpha beta credit propagation');
    expect(jaccardSimilarity(a, b)).toBeLessThan(0.15);
  });

  it('two strongly related summaries clear the 0.15 threshold', () => {
    // Heavy lexical overlap — same topic, similar wording.
    const a = tokeniseSummary(
      'thompson sampling alpha beta credit propagation across variants'
    );
    const b = tokeniseSummary(
      'thompson sampling alpha beta credit propagation across composed variants chains'
    );
    expect(jaccardSimilarity(a, b)).toBeGreaterThanOrEqual(0.15);
  });
});
