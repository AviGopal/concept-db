import { describe, it, expect } from "bun:test";
import * as mod from "../../src/services/execution-observer";

// This check reproduces the defect: a reached walk that recalled concept C
// should produce a usage record (success credit) for C. Today, none are built.
// The assertion expects the correct post-fix behavior (>= 1 request), so it is red now.

describe("walk verdict usage crediting for recalled concepts", () => {
  it("a reached walk credits the concepts it recalled (posterior success)", () => {
    const reachedVerdict: mod.WalkVerdictEvent = {
      type: "execution_completed",
      data: {
        execution_id: "exec-reached-1",
        reached: true,
        // The walk recalled this concept; after the fix this must be credited as a success.
        recalled_concept_ids: ["concept_abc123"],
      },
    };

    const reqs = mod.buildUsageRequestsFromWalkVerdict(reachedVerdict, []);

    // EXPECTED (post-fix): at least one usage record is created for the recalled concept.
    // CURRENT (bug): returns [], so this fails.
    expect(reqs.length).toBeGreaterThan(0);
  });

  it("control: an unreached walk does not increase times_succeeded for recalled concepts", () => {
    const unreachedVerdict: mod.WalkVerdictEvent = {
      type: "execution_completed",
      data: {
        execution_id: "exec-unreached-1",
        reached: false,
        recalled_concept_ids: ["concept_abc123"],
      },
    };

    const reqs = mod.buildUsageRequestsFromWalkVerdict(unreachedVerdict, []);

    // Control invariant: no success credit for an unreached walk.
    expect(reqs.length).toBe(0);
  });
});
