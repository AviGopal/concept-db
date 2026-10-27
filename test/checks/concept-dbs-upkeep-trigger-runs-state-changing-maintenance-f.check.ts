import { describe, it, expect } from "bun:test";
import * as mod from "../../src/routes/upkeep";

// This check targets the defect: upkeep.post('/trigger') permits state-changing
// maintenance for any authenticated caller, including a [read]-scoped key.
// We send an authenticated token with a non-admin role (read scope implied) and
// assert the correct behavior should be 403 Forbidden. Current implementation
// only checks presence of jwtAuth and proceeds, so this will be non-403 (200 or 500),
// making the assertion fail for the defect's reason.

// Minimal JWT with alg=none and a payload indicating a regular user from the default org.
// getJwtAuthFromContext(c) is expected to parse orgId/role from the payload.
const READ_SCOPED_BEARER =
  "Bearer " +
  [
    // header: { alg: "none", typ: "JWT" }
    "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0",
    // payload: { orgId: "default", role: "user", scopes: ["read"] }
    "eyJvcmdJZCI6ImRlZmF1bHQiLCJyb2xlIjoidXNlciIsInNjb3BlcyI6WyJyZWFkIl19",
    // no signature
    ""
  ].join(".");

describe("/upkeep/trigger write-guard for read-scoped authenticated caller", () => {
  it("POST /upkeep/trigger with a [read]-scoped token should reject with 403 (write-scope required)", async () => {
    // Exercise the exported Hono router directly; this reaches the defect's handler.
    const res = await mod.upkeep.request("/trigger", {
      method: "POST",
      headers: {
        Authorization: READ_SCOPED_BEARER,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({})
    });

    // Correct behavior after fix: refuse a read-scoped token with 403.
    expect(res.status).toBe(403);
  });

  // CONTROL: Read-only endpoint behavior must remain unchanged.
  it("GET /upkeep/activities returns a list of activities (control)", async () => {
    const res = await mod.upkeep.request("/activities");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray((body as { activities?: unknown[] }).activities ?? [])).toBe(true);
  });
});
