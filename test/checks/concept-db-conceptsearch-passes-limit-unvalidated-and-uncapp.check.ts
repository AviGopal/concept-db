import { describe, it, expect } from "bun:test";
import * as mod from "../../src/routes/impulses";

describe("concept-db conceptSearch limit validation", () => {
  // This test reproduces the bug where the conceptSearch route fails to validate
  // the 'limit' parameter. Invalid values are passed through to the database,
  // causing a 500 error instead of a 400 client error.
  it("must-fail: rejects a negative limit with a 400 error", async () => {
    const body = {
      shape: "conceptSearch",
      pointer: {
        query: "test query",
        limit: -1,
      },
    };
    const request = new Request("http://localhost/v2/impulses/resolve", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });

    const response = await mod.impulses.fetch(request);

    // This is the failing assertion. The route currently passes the invalid limit
    // to the resolver, which will cause a database error and a 500 response.
    // The expected behavior is a 400 response with a clear error message.
    expect(response.status).toBe(400);
    const json: { error?: string } = await response.json();
    expect(json.error).toMatch(/pointer.limit/i);
  });

  // This control test ensures that valid uses of the 'limit' parameter,
  // including its absence (which should default), are not broken by the fix.
  it("control: accepts valid and absent limits", async () => {
    const cases = [
      { pointer: { query: "test", limit: 15 }, description: "a valid limit" },
      { pointer: { query: "test" }, description: "an absent limit" },
    ];

    for (const { pointer, description } of cases) {
      const body = { shape: "conceptSearch", pointer };
      const request = new Request("http://localhost/v2/impulses/resolve", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });

      const response = await mod.impulses.fetch(request);

      // A valid call proceeds to the database, which is not available in the test
      // environment, resulting in a 500 error. This assertion confirms that the
      // code path for valid limits was taken, as opposed to being rejected with a 400.
      expect(response.status).not.toBe(400);
    }
  });
});
