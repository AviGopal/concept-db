/**
 * EVERY CONCEPT-DB WRITE INGRESS NEEDS THE WRITE SCOPE.
 *
 * The resolve route refused a `_write` shape to a [read] credential, but the
 * same credential still wrote through the other doors: the REST writes under
 * /concepts, the MCP tools under /mcp/tools/call and /mcp/tools/batch, and the
 * unsuffixed shape impulseSignatureConcept. These tests run the REAL auth
 * middleware (jwtAuthMiddleware) in front of the REAL concepts, mcp and
 * impulses routers. Identity's answer is stubbed per presented key at fetch,
 * the root client's query is replaced by a recorder, and the JWT session the
 * middleware opens is stubbed. No database or network is touched.
 *   [MUST-FAIL] a [read] ApiKey is refused 403 with no state-changing statement
 *               on every REST write route, every MCP write tool (call and
 *               batch) and impulseSignatureConcept;
 *   [CONTROL]   a read,write key writes through each; a [read] key still reads
 *               (GET /concepts/:id, GET /concepts/search, MCP concept_search,
 *               a read batch entry, the concept search shape).
 *
 * Every stub is restored in afterAll, so a whole-suite, one-process run sees the
 * real modules after this file.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, mock, spyOn } from 'bun:test';
import { Hono } from 'hono';

const IDENTITY = 'http://identity-stub.test:1';
const NODE_KEY = 'node-own-key';

// identity's answer per presented key. A key not listed is refused.
type Answer = { scopes?: string[]; keyId: string };
const identity = new Map<string, Answer>();

type Call = { sql: string; client: 'root' | 'jwt' };
const calls: Call[] = [];
const WRITE_RE = /\b(CREATE|UPDATE|UPSERT|INSERT|DELETE|RELATE|DEFINE|REMOVE|ALTER|REBUILD)\b/i;
const writes = () => calls.filter((c) => WRITE_RE.test(c.sql.replace(/"[^"]*"|'[^']*'/g, '""')));

function conceptRow(id: unknown) {
  const bare = String(id ?? 'c').replace(/^concept:/, '');
  return {
    id: `concept:${bare}`, shape: 'memo', summary: 'probe', content: 'probe content', source_type: 'extracted',
    token_estimate: 3, relevance: 0.5, times_loaded: 0, org_id: 'org-1',
  };
}

function respond(sql: string, params: Record<string, any> = {}): unknown[] {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (/^SELECT VALUE meta::id\(id\) FROM \[type::thing\("concept"/.test(s)) return [params.from_id, params.to_id];
  if (/^CREATE type::thing\("concept_usage"/.test(s)) return [{ id: `concept_usage:${params.id}`, ...params }];
  if (/^CREATE type::thing\("concept"/.test(s)) return [conceptRow(params.id)];
  if (/^INSERT INTO concept_edge/.test(s)) return [{ id: `concept_edge:${params.id}`, ...params }];
  if (/^INSERT INTO concept_usage/.test(s)) return [{ id: 'concept_usage:u1', ...params }];
  if (/^INSERT INTO impulse/.test(s)) return [{ id: `impulse:${params.id}`, ...params }];
  if (/^UPDATE type::thing\("concept"/.test(s)) return [conceptRow(params.concept_id ?? params.cid)];
  if (/^SELECT \* FROM type::thing\("concept"/.test(s)) return [conceptRow(params.concept_id)];
  if (/^SELECT id FROM concept WHERE id = type::thing/.test(s)) return [{ id: `concept:${params.cid}` }];
  if (/^SELECT id, org_id FROM concept WHERE meta::id\(id\)/.test(s)) return [{ id: `concept:${params.concept_id}`, org_id: 'org-1' }];
  if (/^SELECT VALUE id FROM organizations/.test(s)) return ['org-1'];
  return [];
}

const previousSurrealModule = { ...(await import('../src/db/surreal')) };
mock.module('../src/db/surreal', () => ({
  ...previousSurrealModule,
  createAuthenticatedClient: async () => ({
    query: async (sql: string, params?: Record<string, any>) => {
      if (String(sql).includes('$auth.org_id')) return [{}];
      calls.push({ sql: String(sql), client: 'jwt' });
      return [respond(String(sql), params)];
    },
    close: async () => {},
  }),
  queryWithAuth: async (_token: string, sql: string, params?: Record<string, any>) => {
    calls.push({ sql: String(sql), client: 'jwt' });
    return respond(String(sql), params);
  },
}));

const originalFetch = globalThis.fetch;
const { config } = await import('../src/config');
const { surrealDB } = await import('../src/db/surreal');
const { jwtAuthMiddleware } = await import('../src/middleware/jwtAuth');
const { impulses } = await import('../src/routes/impulses');
const { concepts } = await import('../src/routes/concepts');
const { mcp } = await import('../src/routes/mcp');
const { lifecycleDispatcher } = await import('../src/lifecycle/dispatcher');

const saved = {
  identityEndpoint: config.metabob.identityEndpoint,
  apiKey: config.metabob.apiKey,
  requireAuth: config.auth.requireAuth,
};
let querySpy: ReturnType<typeof spyOn> | null = null;

beforeAll(() => {
  config.metabob.identityEndpoint = IDENTITY;
  config.metabob.apiKey = NODE_KEY;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${IDENTITY}/v1/auth/resolve`) {
      const key = JSON.parse(String(init?.body ?? '{}'))?.impulse?.pointer?.apiKey;
      const a = identity.get(key);
      if (!a) return new Response(JSON.stringify({ success: true, data: { authenticated: false, orgId: '' } }), { status: 200 });
      return new Response(JSON.stringify({
        success: true,
        data: { authenticated: true, orgId: 'org-1', userId: 'user-1', keyId: a.keyId, ...(a.scopes ? { scopes: a.scopes } : {}) },
      }), { status: 200 });
    }
    // recordUsage forwards to activity-api; every other outbound call answers empty.
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  querySpy = spyOn(surrealDB, 'query').mockImplementation((async (sql: string, params?: Record<string, any>) => {
    calls.push({ sql: String(sql), client: 'root' });
    return respond(String(sql), params);
  }) as never);
});

afterAll(() => {
  querySpy?.mockRestore();
  globalThis.fetch = originalFetch;
  config.metabob.identityEndpoint = saved.identityEndpoint;
  config.metabob.apiKey = saved.apiKey;
  config.auth.requireAuth = saved.requireAuth;
  mock.module('../src/db/surreal', () => previousSurrealModule);
});

beforeEach(() => {
  calls.length = 0;
  lifecycleDispatcher.clear();
  config.auth.requireAuth = true;
  identity.clear();
  identity.set('read-only-key', { scopes: ['read'], keyId: 'key_READONLY1234567' });
  identity.set('read-write-key', { scopes: ['read', 'write'], keyId: 'key_RWABCDEFGHIJKLM' });
  identity.set(NODE_KEY, { scopes: ['read', 'write'], keyId: 'key_NODESELF000000' });
});

function app(): Hono {
  const a = new Hono();
  a.use('*', jwtAuthMiddleware);
  a.route('/mcp', mcp);
  a.route('/concepts', concepts);
  a.route('/v2/impulses', impulses);
  return a;
}

async function send(method: string, path: string, authorization: string, body?: unknown) {
  const res = await app().request(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: authorization },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  await new Promise((r) => setTimeout(r, 5)); // fire-and-forget follow-ups (audit, lifecycle hooks, passive usage)
  return { status: res.status, body: json };
}

// Every REST route under /concepts that writes, with a body that writes when admitted.
const REST_WRITES: Array<[string, string, unknown]> = [
  ['POST', '/concepts', { source_type: 'extracted', content: 'hello world' }],
  ['POST', '/concepts/from-source', { source_type: 'extracted', content: 'hello world' }],
  ['POST', '/concepts/upsert-by-signature', { pointer_type: 'probe', shape: 'probeShape' }],
  ['PATCH', '/concepts/concept_c1', { content: 'rewritten content' }],
  ['POST', '/concepts/concept_a/link', { to_concept_id: 'concept_b', edge_type: 'related_to' }],
  ['POST', '/concepts/concept_c1/usage', { trace_id: 'trace-1', outcome: 'success' }],
  ['POST', '/concepts/sequences', { concept_ids: ['concept_a', 'concept_b'], trace_id: 'trace-1' }],
  ['DELETE', '/concepts/concept_c1', undefined],
];

// Every MCP tool that writes, with arguments that write when admitted.
const MCP_WRITES: Array<[string, Record<string, unknown>]> = [
  ['concept_create', { source_type: 'extracted', content: 'hello world' }],
  ['concept_link', { from_concept_id: 'concept_a', to_concept_id: 'concept_b', edge_type: 'related_to' }],
  ['concept_upsert_by_signature', { pointer_type: 'probe', shape: 'probeShape' }],
  ['concept_record_usage', { concept_id: 'concept_c1', trace_id: 'trace-1', outcome: 'success' }],
  ['concept_sequence_record', { concept_ids: ['concept_a', 'concept_b'], trace_id: 'trace-1' }],
];

const SIGNATURE = { pointer: { type: 'impulseSignatureConcept', pointer_type: 'probe', shape: 'probeShape' } };

function expectRefused403(r: { status: number; body: any }) {
  expect(r.status).toBe(403);
  expect(r.body?.code).toBe('WRITE_SCOPE_REQUIRED');
  expect(String(r.body?.message ?? '')).toContain('"write" scope');
  expect(writes()).toEqual([]);
}

describe('REST writes need the write scope', () => {
  for (const [method, path, body] of REST_WRITES) {
    test(`[MUST-FAIL] a [read] ApiKey is refused 403 on ${method} ${path}, nothing written`, async () => {
      expectRefused403(await send(method, path, 'ApiKey read-only-key', body));
    });
  }
  for (const [method, path, body] of REST_WRITES) {
    test(`[CONTROL] a read,write ApiKey writes through ${method} ${path}`, async () => {
      const r = await send(method, path, 'ApiKey read-write-key', body);
      expect(r.status).toBeLessThan(300);
      expect(writes().length).toBeGreaterThan(0);
    });
  }
  test('[CONTROL] a [read] key still reads GET /concepts/:id and GET /concepts/search', async () => {
    const one = await send('GET', '/concepts/concept_c1', 'ApiKey read-only-key');
    expect(one.status).toBe(200);
    const search = await send('GET', '/concepts/search?query=hello', 'ApiKey read-only-key');
    expect(search.status).toBe(200);
  });
});

describe('MCP write tools need the write scope', () => {
  for (const requireAuth of [true, false]) {
    for (const [tool, args] of MCP_WRITES) {
      test(`[MUST-FAIL] REQUIRE_AUTH=${requireAuth}: a [read] ApiKey is refused 403 on tools/call ${tool}, nothing written`, async () => {
        config.auth.requireAuth = requireAuth;
        expectRefused403(await send('POST', '/mcp/tools/call', 'ApiKey read-only-key', { tool, arguments: args }));
      });
    }
  }
  test('[MUST-FAIL] tools/batch refuses each write entry to a [read] ApiKey and still runs its read entry', async () => {
    const r = await send('POST', '/mcp/tools/batch', 'ApiKey read-only-key', {
      calls: [
        ...MCP_WRITES.map(([tool, args]) => ({ tool, arguments: args })),
        { tool: 'concept_search', arguments: { query: 'hello' } },
      ],
    });
    expect(r.status).toBe(200);
    const results = r.body?.results as any[];
    for (const [tool] of MCP_WRITES) {
      const entry = results.find((x) => x.tool === tool);
      expect(entry?.success).toBe(false);
      expect(entry?.code).toBe('WRITE_SCOPE_REQUIRED');
    }
    expect(results.find((x) => x.tool === 'concept_search')?.success).toBe(true);
    expect(writes()).toEqual([]);
  });
  for (const [tool, args] of MCP_WRITES) {
    test(`[CONTROL] a read,write ApiKey writes through tools/call ${tool}`, async () => {
      const r = await send('POST', '/mcp/tools/call', 'ApiKey read-write-key', { tool, arguments: args });
      expect(r.status).toBe(200);
      expect(writes().length).toBeGreaterThan(0);
    });
  }
  test('[CONTROL] a [read] key still calls concept_search through tools/call', async () => {
    const r = await send('POST', '/mcp/tools/call', 'ApiKey read-only-key', { tool: 'concept_search', arguments: { query: 'hello' } });
    expect(r.status).toBe(200);
  });
});

describe('the unsuffixed write shape impulseSignatureConcept needs the write scope', () => {
  test('[MUST-FAIL] a [read] ApiKey is refused 403 on impulseSignatureConcept, nothing written', async () => {
    expectRefused403(await send('POST', '/v2/impulses/resolve', 'ApiKey read-only-key', SIGNATURE));
  });
  test('[CONTROL] a read,write ApiKey upserts the signature concept', async () => {
    const r = await send('POST', '/v2/impulses/resolve', 'ApiKey read-write-key', SIGNATURE);
    expect(r.status).toBe(200);
    expect(writes().length).toBeGreaterThan(0);
  });
  test('[CONTROL] a [read] key still searches through the concept shape', async () => {
    const r = await send('POST', '/v2/impulses/resolve', 'ApiKey read-only-key', { pointer: { type: 'concept', query: 'hello' } });
    expect(r.status).toBe(200);
  });
});

test('the refusal names the scope, never the credential', async () => {
  const r = await send('POST', '/concepts', 'ApiKey read-only-key', REST_WRITES[0][2]);
  expect(JSON.stringify(r.body)).not.toContain('read-only-key');
  expect(JSON.stringify(r.body)).not.toContain('key_READONLY');
});
