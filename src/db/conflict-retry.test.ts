import { describe, it, expect } from "bun:test";
import { isRetryableConflictError } from "./surreal";

// SurrealDB returns "Failed to commit transaction due to a read or write conflict. This
// transaction can be retried" under concurrent writes, and nothing acted on that
// instruction — the conflict surfaced as a hard 400 and the write was lost.
//
// Measured on the live fleet 2026-08-31: six identical concept_create_write POSTs
// alternated 200/400/200/400/200/400. A deterministic every-other-write failure, not an
// occasional blip. The visible cost was the compose-lesson corpus — 5,797 classified
// compose failures since 2026-07-03 produced ONE stored lesson, so the drafter kept
// repeating mistakes the substrate had already diagnosed and written guidance for.
describe("isRetryableConflictError", () => {
  it("matches the real message SurrealDB returned on the live fleet", () => {
    const real =
      "Query failed in activity-system.learning_loop: The query was not executed due to a " +
      "failed transaction. Failed to commit transaction due to a read or write conflict. " +
      "This transaction can be retried";
    expect(isRetryableConflictError(new Error(real))).toBe(true);
  });

  it("matches on either stable phrase independently", () => {
    // Two independent anchors, so a reword of one half does not silently disable the retry.
    expect(isRetryableConflictError(new Error("read or write conflict"))).toBe(true);
    expect(isRetryableConflictError(new Error("This transaction can be retried"))).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isRetryableConflictError(new Error("READ OR WRITE CONFLICT"))).toBe(true);
  });

  it("does NOT match unrelated failures — retrying those just burns the budget", () => {
    // A schema or permission error will fail identically on every attempt. Retrying it
    // delays the real error and hides it behind a backoff.
    expect(isRetryableConflictError(new Error("Parse error: Missing order idiom"))).toBe(false);
    expect(isRetryableConflictError(new Error("IAM error: Not enough permissions"))).toBe(false);
    expect(isRetryableConflictError(new Error("The token has expired"))).toBe(false);
    expect(isRetryableConflictError(new Error("Cannot access namespace 'activity-system'"))).toBe(false);
  });

  it("is null- and shape-safe", () => {
    // The catch block hands us whatever was thrown; a non-Error must not crash the guard
    // and must not be treated as retryable.
    expect(isRetryableConflictError(null)).toBe(false);
    expect(isRetryableConflictError(undefined)).toBe(false);
    expect(isRetryableConflictError({})).toBe(false);
    expect(isRetryableConflictError("read or write conflict")).toBe(true);
  });
});
