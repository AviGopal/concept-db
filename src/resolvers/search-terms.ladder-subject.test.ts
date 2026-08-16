import { describe, it, expect } from "bun:test";
import { searchTermLadder } from "./search-terms";

// THE MEASURED FAILURE (2026-08-16).
//
// A NAIF-id concept was seeded into the live store to close a generalization gap: the walk knew
// "Io" but the Horizons command says "COMMAND=501", so the body->id mapping had to be recallable
// at the point of use. It was written successfully and was still unreachable:
//
//   query "astronomical distance ganymede"   (the walk's own phrasing)
//     ladder -> ["astronomical distance ganymede", "astronomical distance", "astronomical"]
//     live hits ->  0                              0                        0
//   the DROPPED term retrieves it:
//     "ganymede" -> 1 hit
//
// Terms are ordered by LENGTH as a rarity proxy. That holds for the identifier-heavy lessons the
// ladder was built for and INVERTS for prose questions, where the long words are the generic ones
// ("astronomical") and the short one is the subject ("ganymede"). Every rung narrowed toward the
// most generic term and discarded the only discriminating one.
//
// The fix appends the query's TRAILING distinctive term as a final rung. These tests pin the win,
// pin that nothing existing changed, and pin the case where word order does NOT identify the
// subject — so the limitation is recorded rather than discovered again later.

describe("searchTermLadder — the last rung keeps the subject", () => {
  it("ends on the discriminating term for the query that failed live", () => {
    const rungs = searchTermLadder("astronomical distance ganymede");
    expect(rungs).toContain("ganymede");
    expect(rungs[rungs.length - 1]).toBe("ganymede");
  });

  it("preserves every pre-existing rung, in order, before the new one", () => {
    // Additive only: a query that already worked must still try exactly what it tried before,
    // in the same sequence, so this can add recall and never change an existing result.
    const rungs = searchTermLadder("astronomical distance ganymede");
    expect(rungs.slice(0, 3)).toEqual([
      "astronomical distance ganymede",
      "astronomical distance",
      "astronomical",
    ]);
  });

  it("still puts the full original query first — narrow queries are unaffected", () => {
    expect(searchTermLadder("horizons COMMAND naif id moon")[0]).toBe("horizons COMMAND naif id moon");
  });

  it("does not add a redundant rung for a single-term query", () => {
    expect(searchTermLadder("ganymede")).toEqual(["ganymede"]);
  });

  it("leaves the identifier-heavy case the ladder was built for intact", () => {
    // Here length IS a good rarity proxy and the existing ordering is correct; the appended rung
    // is the trailing term and costs one extra lookup at worst.
    const rungs = searchTermLadder("anchor_not_found old_string error");
    expect(rungs[0]).toBe("anchor_not_found old_string error");
    expect(rungs).toContain("anchor_not_found");
  });

  it("KNOWN LIMIT: word order is a heuristic, not a rule", () => {
    // "distance earth ganymede astronomical units" trails on "units", not the subject. Word order
    // carries specificity in most English noun phrases and not in all of them. Recorded rather
    // than papered over: closing this properly needs corpus rarity (IDF), not a better guess at
    // position. The earlier rungs still carry "ganymede", so this query is not made worse.
    const rungs = searchTermLadder("distance earth ganymede astronomical units");
    expect(rungs[rungs.length - 1]).toBe("units");
    expect(rungs.some((r) => r.includes("ganymede"))).toBe(true);
  });
});
