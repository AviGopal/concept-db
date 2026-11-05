import { expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import * as mod from "../../src/routes/concepts";
import * as resolver from "../../src/resolvers/concept";
import { config } from "../../src/config";
import { logger } from "../../src/utils/logger";

const caller = "search-check-caller";
const orgId = "search-check-org";
const path = "/concepts/search";
const auth = {
  userId: caller,
  sub: caller,
  caller,
  vesselId: caller,
  orgId,
  jwtToken: "search-check-token",
};

function appForCaller() {
  const app = new Hono<{ Variables: { jwtAuth: typeof auth } }>();
  app.use("*", async (c, next) => {
    c.set("jwtAuth", auth);
    await next();
  });
  app.route("/concepts", mod.concepts);
  return app;
}

// Accept either structured or text logging, without prescribing a new event
// label or metadata spelling. Attribution must occur together in one record.
function valuesIn(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap((item: unknown) => valuesIn(item));
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap((item: unknown) => valuesIn(item));
  }
  return [value];
}

test("a zero-row search logs its caller, resolved org, path and count", async () => {
  const requireAuth = config.auth.requireAuth;
  config.auth.requireAuth = false;
  const search = spyOn(resolver, "searchConcepts").mockResolvedValue([]);
  const info = spyOn(logger, "info").mockImplementation(() => {});
  const debug = spyOn(logger, "debug").mockImplementation(() => {});
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  const error = spyOn(logger, "error").mockImplementation(() => {});
  try {
    const response = await appForCaller().request(path);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ concepts: [], count: 0 });
    expect(search).toHaveBeenCalledWith(expect.anything(), orgId, auth.jwtToken);

    // The /search handler currently reaches
    // return c.json({ concepts: projected, count: projected.length })
    // without emitting any success record. Assert that missing observable,
    // rather than declarations or the mocked resolver's own output.
    const records = [
      ...info.mock.calls,
      ...debug.mock.calls,
      ...warn.mock.calls,
      ...error.mock.calls,
    ].map((record) => valuesIn(record));
    expect(records).toContainEqual(expect.arrayContaining([caller, orgId, path, 0]));
  } finally {
    search.mockRestore();
    info.mockRestore();
    debug.mockRestore();
    warn.mockRestore();
    error.mockRestore();
    config.auth.requireAuth = requireAuth;
  }
});

test("CONTROL: a search error still returns 400 and logs Search failed", async () => {
  const requireAuth = config.auth.requireAuth;
  config.auth.requireAuth = false;
  const failure = new Error("Search failed");
  const search = spyOn(resolver, "searchConcepts").mockRejectedValue(failure);
  const error = spyOn(logger, "error").mockImplementation(() => {});
  try {
    const response = await appForCaller().request(path);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: failure.message });
    expect(error).toHaveBeenCalledWith("Search failed", { error: failure.message });
  } finally {
    search.mockRestore();
    error.mockRestore();
    config.auth.requireAuth = requireAuth;
  }
});
