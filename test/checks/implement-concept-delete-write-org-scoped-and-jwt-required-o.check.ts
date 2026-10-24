import { describe, it, expect } from "bun:test";
import * as mod from "../../src/routes/impulses";

describe("impulse shape: concept_delete_write", () => {
  it("should be handled as a write shape requiring auth, but is not yet implemented", async () => {
    // GOAL: This test reproduces the defect that `concept_delete_write` is
    // advertised but not implemented in the impulse resolver.
    //
    // A request for an implemented write shape without authentication should be
    // rejected with a 401 Unauthorized status.
    //
    // The defect is that this shape is not implemented, so the resolver falls
    // back to a generic "unsupported shape" error, returning a 400 Bad Request.
    //
    // This test asserts the correct behavior (expect 401) and is designed
    // to FAIL until the shape is implemented.
    const req = new Request("http://localhost/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shape: "concept_delete_write",
        pointer: { concept_id: "concept_any_id" },
      }),
    });

    const res = await mod.impulses.fetch(req);
    const body = await res.json();

    // EXPECTED (CORRECT) BEHAVIOR: 401 Unauthorized because it's a write shape.
    // ACTUAL (DEFECTIVE) BEHAVIOR: 400 Bad Request because it's unimplemented.
    // These assertions will fail, highlighting the defect.
    expect(res.status).toBe(401);
    expect(body).toEqual({
      success: false,
      error: 'Write scope required',
      code: 'WRITE_SCOPE_REQUIRED',
    });
  });
});
