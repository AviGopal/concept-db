import { describe, it, expect, mock } from "bun:test";
import type { SearchConceptsRequest } from "../../src/models/schemas";

// Mock the resolver module BEFORE importing the route that uses it.
// This is crucial to inject the mock and avoid hitting real services.
const mockSearchConcepts = mock(() => Promise.resolve([]));
mock.module("../../src/resolvers/concept", () => ({
  searchConcepts: mockSearchConcepts,
}));

// Import the module with the defect as a namespace, as per best practices
// and to ensure mocks are applied correctly after being hoisted.
import * as impulsesModule from "../../src/routes/impulses";

describe("concept-db conceptSearch in impulses route", () => {
  it("fails to pass on a non-zero offset, hard-wiring it to 0", async () => {
    // The test reproduces a defect where a reader asking for a subsequent
    // page of conceptSearch results is silently served the first page again.
    const requestedOffset = 100;

    const requestBody = {
      shape: "conceptSearch",
      query: "some-query",
      offset: requestedOffset,
    };

    const request = new Request("http://localhost/v2/impulses/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    // The 'impulses' export is a Hono app. We can 'fetch' it directly to test it.
    await impulsesModule.impulses.fetch(request);

    // Verify that the underlying search function was called.
    expect(mockSearchConcepts).toHaveBeenCalledTimes(1);

    // Get the arguments passed to our mock.
    // The signature is searchConcepts(request, orgId, jwtToken?)
    const callArgs = mockSearchConcepts.mock.calls[0];
    const searchRequest = callArgs[0] as SearchConceptsRequest;

    // This is the failing assertion.
    // The code under test has a defect and passes `offset: 0` regardless of
    // the request. This test asserts that the requested offset is honored.
    // When the bug is present, `searchRequest.offset` will be 0, and this
    // assertion will fail as `expect(0).toBe(100)` is false.
    expect(searchRequest.offset).toBe(requestedOffset);
  });
});
