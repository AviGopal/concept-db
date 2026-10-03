/**
 * /v2/impulses/resolve — every shape concept-db advertises must be SERVED.
 *
 * Why this must hold (REALIGNMENT/WIRING step 1(c); WIRING-ADDENDUM C2 and C§1(c)):
 *   concept_supersede_write / concept_retire_write / concept_delete_write are advertised to
 *   discovery (config.discovery.shapes) and listed in SUPPORTED_SHAPES, but the resolve switch has
 *   no case for them, so a caller routed here by discovery gets 400 "Unknown impulse shape". The
 *   shape-dispatch lint is satisfied by a no-op `switch ('')` holding three dead case labels, so
 *   the lint certifies advertisement, not implementation. An advertised shape that is not served
 *   is a hollow capability: the walk can aim at it and every dispatch fails.
 *
 * What is checked: for EVERY shape in the union of config.discovery.shapes and the vessel's own
 * supported_shapes list (read from its 400 body), resolving it with an empty pointer does NOT
 * answer "Unknown impulse shape". A validation 400 for a missing pointer field, a 401, or a
 * 500 from the fixture's refusing DB all pass: they prove the dispatch reached a case.
 * Either honest fix turns this green: implement the shape, or stop advertising it (remove it
 * from BOTH lists; a shape left in SUPPORTED_SHAPES still lies to callers in the 400 body).
 *
 * Positive control: a bogus shape DOES answer "Unknown impulse shape" through the same route,
 * so a pass is never the detector failing to see the error.
 *
 * Fixture only: surrealDB.query/getInstance, the embedding service and globalThis.fetch are all
 * spied to throw (restored after each test), so nothing can reach a live store or peer.
 */
import { describe, test, expect, spyOn, beforeAll, afterAll } from 'bun:test';
import { Hono } from 'hono';
import { surrealDB } from '../src/db/surreal';
import { embeddingService } from '../src/services/embedding';
import { config } from '../src/config';
import { impulses } from '../src/routes/impulses';

const app = new Hono();
app.route('/v2/impulses', impulses);

const UNKNOWN_RE = /Unknown impulse shape/;
const BOGUS = 'definitely_not_a_concept_db_shape';

type Spy = { mockRestore(): void };
const spies: Spy[] = [];
const realFetch = globalThis.fetch;
const blockedFetches: string[] = [];

function installFixtureOnlySeams() {
  const refuse = (what: string) => async () => {
    throw new Error(`fixture: ${what} is not available in this test`);
  };
  spies.push(spyOn(surrealDB, 'query').mockImplementation(refuse('surrealDB.query') as any));
  spies.push(spyOn(surrealDB, 'getInstance').mockImplementation(refuse('surrealDB.getInstance') as any));
  spies.push(spyOn(embeddingService, 'embed').mockImplementation(refuse('embeddingService.embed') as any));
  spies.push(spyOn(embeddingService, 'embedBatch').mockImplementation(refuse('embeddingService.embedBatch') as any));
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    blockedFetches.push(url);
    throw new Error(`fixture: network is not available in this test (${url})`);
  }) as unknown as typeof fetch;
}

function restoreSeams() {
  while (spies.length) spies.pop()!.mockRestore();
  globalThis.fetch = realFetch;
}

async function resolveEmpty(shape: string): Promise<{ status: number; body: any }> {
  const res = await app.request('/v2/impulses/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pointer: { type: shape } }),
  });
  let body: any = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

// The vessel's own supported list, as it reports it to a caller (read once, outside any test,
// with the same refusing seams installed).
installFixtureOnlySeams();
const bogus = await resolveEmpty(BOGUS);
restoreSeams();
const reportedSupported: string[] = Array.isArray(bogus.body?.supported_shapes) ? bogus.body.supported_shapes : [];
const advertised = [...new Set<string>([...config.discovery.shapes, ...reportedSupported])].sort();

describe('concept-db: every advertised shape is served', () => {
  beforeAll(installFixtureOnlySeams);
  afterAll(restoreSeams);

  test('CONTROL: a bogus shape answers 400 "Unknown impulse shape" with the supported list (the detector sees the error)', async () => {
    const r = await resolveEmpty(BOGUS);
    expect(r.status).toBe(400);
    expect(String(r.body?.error)).toMatch(UNKNOWN_RE);
    expect(Array.isArray(r.body?.supported_shapes)).toBe(true);
    expect(reportedSupported.length).toBeGreaterThan(0);
  });

  test('CONTROL: a served shape ("concept") reaches its case and answers a validation error, not unknown-shape', async () => {
    expect(advertised).toContain('concept');
    const r = await resolveEmpty('concept');
    expect(r.status).toBe(400);
    expect(String(r.body?.error)).not.toMatch(UNKNOWN_RE);
    expect(String(r.body?.error)).toMatch(/concept_id/);
  });

  for (const shape of advertised) {
    test(`advertised shape "${shape}" is served (not "Unknown impulse shape")`, async () => {
      const r = await resolveEmpty(shape);
      expect(`${r.status} ${String(r.body?.error ?? '')}`).not.toMatch(UNKNOWN_RE);
    });
  }
});
