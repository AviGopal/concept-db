import { describe, it, expect, mock, beforeEach } from "bun:test";
import { Hono } from "hono";

// Import the router from the module under test
import * as conceptsRoutes from "../../src/routes/concepts";

// Dependencies to mock
import * as conceptResolver from "../../src/resolvers/concept";
import * as jwtAuth from "../../src/middleware/jwtAuth";
import * as impulsesRoutes from "../../src/routes/impulses";

import type { Concept } from "../../src/models/schemas";

// Mock dependencies BEFORE they are imported by the module under test.
// Bun's test runner will hoist these calls.
mock.module("../../src/resolvers/concept", () => ({
  getConceptById: mock(),
  updateConcept: mock(),
}));

mock.module("../../src/middleware/jwtAuth", () => ({
  getJwtAuthFromContext: mock(() => ({
    orgId: "test-org",
    jwtToken: "test-token",
    claims: { scope: "read write" },
  })),
}));

mock.module("../../src/routes/impulses", () => ({
  // Mocking writeScopeRefusal to always allow the write operation,
  // so we can isolate the PATCH handler's logic.
  writeScopeRefusal: mock(() => null),
}));

// Destructure after mocks are set up.
const { concepts } = conceptsRoutes;

describe("PATCH /concepts/:id", () => {
  const app = new Hono().route("/concepts", concepts);

  const conceptId = "concept:concept_Xix8-GFnHyvJ";

  const mockConceptBase: Concept = {
    id: conceptId,
    name: "Initial Concept",
    summary: "This is a test concept.",
    content: "Initial content.",
    org_id: "test-org",
    scope: "org",
    priority: 0.5,
    relevance: 0.5,
    created_at: new Date("2023-01-01T00:00:00.000Z").toISOString(),
    updated_at: new Date("2023-01-01T00:00:00.000Z").toISOString(),
    source: "test",
    source_type: "test",
    public: false,
    schema_version: 1,
  };

  let conceptsDB: Record<string, Concept>;

  beforeEach(() => {
    // Reset mocks and in-memory DB for test isolation
    (conceptResolver.getConceptById as any).mockClear();
    (conceptResolver.updateConcept as any).mockClear();
    (jwtAuth.getJwtAuthFromContext as any).mockClear();
    (impulsesRoutes.writeScopeRefusal as any).mockClear();

    conceptsDB = {
      [conceptId]: { ...mockConceptBase },
    };

    // This stateful mock setup for the data layer addresses the prior feedback
    // about stale data in the control test.
    (conceptResolver.getConceptById as any).mockImplementation(async (id: string) => {
      return conceptsDB[id] ?? null;
    });

    (conceptResolver.updateConcept as any).mockImplementation(
      async (id: string, updates: Partial<Omit<Concept, 'id'>>) => {
        const concept = conceptsDB[id];
        if (concept) {
          conceptsDB[id] = { ...concept, ...updates, updated_at: new Date().toISOString() };
          // The real updateConcept likely returns void. The route handler
          // is expected to re-fetch the concept to return it.
          return;
        }
        throw new Error("Concept not found");
      }
    );
  });

  it("should return 400 for unsupported fields and name them in the error", async () => {
    const payload = {
      scope: "global", // Unsupported field for PATCH
      public: true,    // Also unsupported
    };

    const req = new Request(`http://localhost/concepts/${conceptId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    });

    const res = await app.request(req);

    // This is the failing assertion. The defective code returns 200.
    expect(res.status).toBe(400);

    const body = await res.json();
    
    // These assertions address the prior feedback about fragile error message checks.
    // By checking for a specific error structure, we avoid false positives from
    // a successful response that happens to contain the checked-for strings.
    expect(body).toHaveProperty("error");
    const errorMessage = (body.error as string).toLowerCase();
    expect(errorMessage).toContain("unsupported");
    expect(errorMessage).toContain("scope");
    expect(errorMessage).toContain("public");
  });

  it("should return 200 and update concept for supported fields (CONTROL)", async () => {
    const payload = {
      summary: "A new summary for the concept.",
      priority: 0.8,
    };

    const req = new Request(`http://localhost/concepts/${conceptId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    });

    const res = await app.request(req);

    // This control test should pass on both defective and fixed code.
    expect(res.status).toBe(200);

    const body: Concept = await res.json();
    
    // Assert that the response body reflects the updates.
    expect(body.id).toBe(conceptId);
    expect(body.summary).toBe("A new summary for the concept.");
    expect(body.priority).toBe(0.8);
    // Assert that other fields are unchanged.
    expect(body.name).toBe(mockConceptBase.name);
    // The timestamp should have been updated.
    expect(new Date(body.updated_at).getTime()).toBeGreaterThan(new Date(mockConceptBase.updated_at).getTime());
  });
});
