/**
 * A `_write` SHAPE NEEDS THE WRITE SCOPE.
 *
 * Authentication alone admitted every concept-db write shape, so a key identity
 * issued with exactly [read] created concepts, links and usage records. These
 * tests run the REAL auth middleware (jwtAuthMiddleware) in front of the REAL
 * impulses route. Identity's answer is stubbed per presented key at fetch, the
 * root client's query is replaced by a recorder, and the JWT session the
 * middleware opens is stubbed. No database or network is touched.
 *   [MUST-FAIL] a [read] ApiKey is refused 403 on every served `_write` shape
 *               with no state-changing statement issued;
 *   [MUST-FAIL] a [read] JWT session and a credential with no scopes are
 *               refused 403 (fail closed);
 *   [CONTROL]   a read,write key writes (200, statements issued); an admin key
 *               writes; a [read] key still READS a concept; the node's own key
 *               writes by the write scope it was issued with; a key identity
 *               refuses is 401 and nothing is queried.
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

// The claims of a Bearer JWT session, answered by the session the middleware opens.
let sessionClaims: Record<string, unknown> = {};

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
  if (/^SELECT id, times_loaded, times_succeeded FROM concept/.test(s)) {
    return [{ id: 'concept:concept_c1', times_loaded: 5, times_succeeded: 5 }];
  }
  if (/^SELECT trace_id, outcome FROM concept_usage/.test(s)) return [{ trace_id: 'trace-real', outcome: 'success' }];
  return [];
}

const previousSurrealModule = { ...(await import('../src/db/surreal')) };
mock.module('../src/db/surreal', () => ({
  ...previousSurrealModule,
  createAuthenticatedClient: async () => ({
    query: async (sql: string, params?: Record<string, any>) => {
      if (String(sql).includes('$auth.org_id')) return [sessionClaims];
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
  sessionClaims = {};
  identity.clear();
  identity.set('read-only-key', { scopes: ['read'], keyId: 'key_READONLY1234567' });
  identity.set('read-write-key', { scopes: ['read', 'write'], keyId: 'key_RWABCDEFGHIJKLM' });
  identity.set('admin-key', { scopes: ['admin'], keyId: 'key_ADMINXYZ98765' });
  identity.set('no-scope-key', { keyId: 'key_NOSCOPE0000000' });
  identity.set(NODE_KEY, { scopes: ['read', 'write'], keyId: 'key_NODESELF000000' });
});

function app(): Hono {
  const a = new Hono();
  a.use('*', jwtAuthMiddleware);
  a.route('/v2/impulses', impulses);
  return a;
}

async function resolve(authorization: string, pointer: Record<string, unknown>) {
  const res = await app().request('/v2/impulses/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authorization },
    body: JSON.stringify({ pointer }),
  });
  let body: any = null;
  try { body = await res.json(); } catch { body = null; }
  await new Promise((r) => setTimeout(r, 5)); // fire-and-forget follow-ups (audit, lifecycle hooks)
  return { status: res.status, body };
}

// Every `_write` shape the route dispatches, with a payload that writes when admitted.
const WRITES: Array<[string, Record<string, unknown>]> = [
  ['concept_write', { type: 'concept_write', source_type: 'extracted', content: 'hello world' }],
  ['concept_create_write', { type: 'concept_create_write', conceptData: { source_type: 'extracted', content: 'hello world' } }],
  ['conceptLink_write', { type: 'conceptLink_write', linkData: { from_concept_id: 'concept_a', to_concept_id: 'concept_b', edge_type: 'related_to' } }],
  ['conceptSignatureUpsert_write', { type: 'conceptSignatureUpsert_write', pointer_type: 'probe', shape: 'probeShape' }],
  ['conceptUsage_write', { type: 'conceptUsage_write', usageData: { concept_id: 'concept_c1', trace_id: 'trace-1', outcome: 'success' } }],
  ['conceptSequence_write', { type: 'conceptSequence_write', sequenceData: { concept_ids: ['concept_a', 'concept_b'], trace_id: 'trace-1' } }],
  ['conceptCreditDecontaminate_write', { type: 'conceptCreditDecontaminate_write', dry_run: false, min_loads: 1 }],
];
// Advertised `_write` shapes with no implementation yet: refused all the same.
const UNIMPLEMENTED = ['concept_delete_write', 'concept_retire_write', 'concept_supersede_write'];

function expectRefused403(r: { status: number; body: any }) {
  expect(r.status).toBe(403);
  expect(r.body?.success).toBe(false);
  expect(String(r.body?.message ?? '')).toContain('"write" scope');
  expect(writes()).toEqual([]);
}

describe('a `_write` shape needs the write scope, validated by identity', () => {
  for (const requireAuth of [true, false]) {
    for (const [name, pointer] of WRITES) {
      test(`[MUST-FAIL] REQUIRE_AUTH=${requireAuth}: a [read] ApiKey is refused 403 on ${name}, nothing written`, async () => {
        config.auth.requireAuth = requireAuth;
        expectRefused403(await resolve('ApiKey read-only-key', pointer));
      });
    }
  }

  for (const shape of UNIMPLEMENTED) {
    test(`[MUST-FAIL] a [read] ApiKey is refused 403 on ${shape}`, async () => {
      expectRefused403(await resolve('ApiKey read-only-key', { type: shape }));
    });
  }

  test('[MUST-FAIL] a [read] key is refused before the payload is read (403, not 400)', async () => {
    expectRefused403(await resolve('ApiKey read-only-key', { type: 'concept_create_write' }));
  });

  test('[MUST-FAIL] a [read] JWT session is refused 403, nothing written', async () => {
    sessionClaims = { id: 'user:u1', org_id: 'organizations:org-1', user_id: 'user-1', scopes: ['read'] };
    expectRefused403(await resolve('Bearer aaa.bbb.ccc', WRITES[1][1]));
  });

  test('[MUST-FAIL] a JWT session that carries no scopes is refused 403 (fail closed)', async () => {
    sessionClaims = { id: 'user:u1', org_id: 'organizations:org-1', user_id: 'user-1' };
    expectRefused403(await resolve('Bearer aaa.bbb.ccc', WRITES[1][1]));
  });

  test('[MUST-FAIL] an ApiKey identity answers with no scopes is refused 403 (fail closed)', async () => {
    expectRefused403(await resolve('ApiKey no-scope-key', WRITES[1][1]));
  });

  test('[MUST-FAIL] the node\'s own key has no shortcut: issued [read] only, it is refused', async () => {
    identity.set(NODE_KEY, { scopes: ['read'], keyId: 'key_NODESELF000000' });
    expectRefused403(await resolve(`ApiKey ${NODE_KEY}`, WRITES[1][1]));
  });

  test('the refusal names the scope, never the credential', async () => {
    const r = await resolve('ApiKey read-only-key', WRITES[1][1]);
    expect(r.body?.code).toBe('WRITE_SCOPE_REQUIRED');
    expect(JSON.stringify(r.body)).not.toContain('read-only-key');
    expect(JSON.stringify(r.body)).not.toContain('key_READONLY');
  });
});

describe('controls', () => {
  for (const [name, pointer] of WRITES) {
    test(`[CONTROL] a read,write ApiKey writes ${name} (200, statements issued)`, async () => {
      const r = await resolve('ApiKey read-write-key', pointer);
      expect(r.status).toBe(200);
      expect(writes().length).toBeGreaterThan(0);
    });
  }

  test('[CONTROL] an admin-scoped key writes concept_create_write', async () => {
    const r = await resolve('ApiKey admin-key', WRITES[1][1]);
    expect(r.status).toBe(200);
    expect(writes().length).toBeGreaterThan(0);
  });

  test('[CONTROL] the node\'s own key writes by the write scope it was issued with', async () => {
    for (const [, pointer] of [WRITES[1], WRITES[2], WRITES[4]]) {
      calls.length = 0;
      const r = await resolve(`ApiKey ${NODE_KEY}`, pointer);
      expect(r.status).toBe(200);
      expect(writes().length).toBeGreaterThan(0);
    }
  });

  test('[CONTROL] a read,write JWT session writes concept_create_write on the session client', async () => {
    sessionClaims = { id: 'user:u1', org_id: 'organizations:org-1', user_id: 'user-1', scopes: ['read', 'write'] };
    const r = await resolve('Bearer aaa.bbb.ccc', WRITES[1][1]);
    expect(r.status).toBe(200);
    expect(writes().some((w) => w.client === 'jwt')).toBe(true);
  });

  test('[CONTROL] a [read] key still reads a concept', async () => {
    const r = await resolve('ApiKey read-only-key', { type: 'concept', concept_id: 'concept_c1' });
    expect(r.status).toBe(200);
    expect(calls.some((c) => /^\s*SELECT \* FROM type::thing\("concept"/.test(c.sql))).toBe(true);
  });

  test('[CONTROL] a [read] key still searches concepts, issuing no write', async () => {
    const r = await resolve('ApiKey read-only-key', { type: 'conceptSearch', query: 'hello' });
    expect(r.status).toBe(200);
    expect(writes()).toEqual([]);
  });

  test('[CONTROL] a key identity refuses is 401 and nothing is queried', async () => {
    const r = await resolve('ApiKey unknown-key', WRITES[1][1]);
    expect(r.status).toBe(401);
    expect(calls).toEqual([]);
  });
});
