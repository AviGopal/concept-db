/**
 * conceptSearch PAGES WITH pointer.offset.
 *
 * The route called searchConcepts with `offset: 0` hard-wired, although
 * searchConcepts honours request.offset (`... LIMIT $limit START $offset`), so a
 * reader could never page past the first result window. These tests run the REAL
 * impulses route and the REAL searchConcepts over a stubbed root client that
 * answers the scalar search statement from an ordered fixture, honouring the
 * relevance floor, LIMIT and START it is given. No database or network is touched.
 *   [MUST-FAIL] {limit:2, offset:2} returns rows 3-4 of the same ordering, and
 *               page 1 + page 2 equals the {limit:4} result;
 *   [MUST-FAIL] an invalid offset (negative, non-integer, non-number, over the
 *               cap) is refused 400 with a reason and nothing is queried;
 *   [BOUNDARY]  an offset exactly at the cap is accepted and pages there;
 *   [CONTROL]   an absent (or null) offset returns exactly the first page.
 *
 * The stub is restored in afterAll, so a whole-suite, one-process run sees the
 * real client after this file.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, spyOn } from 'bun:test';
import { Hono } from 'hono';

const { surrealDB } = await import('../src/db/surreal');
const impulsesMod = await import('../src/routes/impulses');
const { impulses } = impulsesMod;

// Strictly distinct relevance, so the order is unambiguous without created_at.
const FIXTURE = [0.97, 0.93, 0.88, 0.81, 0.74, 0.62, 0.45].map((relevance, i) => ({
  id: `concept:c${i + 1}`,
  shape: 'memo',
  summary: `row ${i + 1}`,
  content: `content ${i + 1}`,
  source_type: 'extracted',
  token_estimate: 2,
  relevance,
  org_id: 'default',
}));

const searchCalls: Array<Record<string, any>> = [];
let querySpy: ReturnType<typeof spyOn> | null = null;

function answerSearch(sql: string, params: Record<string, any> = {}): unknown[] {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (!/ORDER BY relevance DESC, created_at DESC LIMIT \$limit START \$offset/.test(s)) return [];
  searchCalls.push({ ...params });
  let rows = [...FIXTURE];
  if (/relevance >= \$relevance_floor/.test(s)) rows = rows.filter((r) => r.relevance >= params.relevance_floor);
  rows.sort((a, b) => b.relevance - a.relevance);
  return rows.slice(params.offset, params.offset + params.limit);
}

const app = new Hono();
app.route('/v2/impulses', impulses);

async function resolve(pointer: Record<string, unknown>) {
  const res = await app.fetch(new Request('http://local/v2/impulses/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pointer }),
  }));
  let body: any = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

const ids = (r: { body: any }) => (r.body?.content ?? []).map((c: any) => String(c.id));

beforeAll(() => {
  querySpy = spyOn(surrealDB, 'query').mockImplementation((async (sql: string, params?: Record<string, any>) =>
    answerSearch(String(sql), params)) as never);
});

beforeEach(() => {
  searchCalls.length = 0;
});

afterAll(() => {
  querySpy?.mockRestore();
});

describe('conceptSearch pages with pointer.offset', () => {
  test('MUST-FAIL: {limit:2, offset:2} returns rows 3-4 of the ordering', async () => {
    const r = await resolve({ type: 'conceptSearch', limit: 2, offset: 2 });
    expect(r.status).toBe(200);
    expect(ids(r)).toEqual(['concept:c3', 'concept:c4']);
    expect(r.body?.metadata?.count).toBe(2);
  });

  test('MUST-FAIL: page 1 + page 2 equals the {limit:4} result', async () => {
    const p1 = await resolve({ type: 'conceptSearch', limit: 2 });
    const p2 = await resolve({ type: 'conceptSearch', limit: 2, offset: 2 });
    const all = await resolve({ type: 'conceptSearch', limit: 4 });
    expect([p1.status, p2.status, all.status]).toEqual([200, 200, 200]);
    expect(ids(all)).toEqual(['concept:c1', 'concept:c2', 'concept:c3', 'concept:c4']);
    expect([...ids(p1), ...ids(p2)]).toEqual(ids(all));
  });

  test('CONTROL: an absent offset returns exactly the first page', async () => {
    const r = await resolve({ type: 'conceptSearch', limit: 2 });
    expect(r.status).toBe(200);
    expect(ids(r)).toEqual(['concept:c1', 'concept:c2']);
    expect(searchCalls.every((p) => p.offset === 0)).toBe(true);
  });

  test('CONTROL: a null offset is the first page, as on the concept search form', async () => {
    const r = await resolve({ type: 'conceptSearch', limit: 2, offset: null });
    expect(r.status).toBe(200);
    expect(ids(r)).toEqual(['concept:c1', 'concept:c2']);
  });

  test('BOUNDARY: an offset at the cap is accepted and pages there (empty past the rows)', async () => {
    const cap = (impulsesMod as any).CONCEPT_SEARCH_MAX_OFFSET;
    expect(typeof cap).toBe('number');
    const r = await resolve({ type: 'conceptSearch', limit: 2, offset: cap });
    expect(r.status).toBe(200);
    expect(ids(r)).toEqual([]);
  });

  const INVALID: Array<[string, unknown]> = [
    ['negative', -1],
    ['non-integer', 1.5],
    ['a numeric string', '2'],
    ['a boolean', true],
    ['an object', { n: 2 }],
    ['over the cap', ((impulsesMod as any).CONCEPT_SEARCH_MAX_OFFSET ?? 10_000) + 1],
  ];
  for (const [name, offset] of INVALID) {
    test(`MUST-FAIL: an offset that is ${name} is refused 400 with a reason and nothing is queried`, async () => {
      const r = await resolve({ type: 'conceptSearch', limit: 2, offset });
      expect(r.status).toBe(400);
      expect(String(r.body?.error ?? '')).toContain('pointer.offset');
      expect(searchCalls).toEqual([]);
    });
  }
});
