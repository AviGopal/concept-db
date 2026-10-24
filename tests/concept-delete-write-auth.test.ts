/**
 * concept_delete_write AT THE RESOLVE ROUTE: the shape is read from pointer.type, and only there.
 *
 * POST /v2/impulses/resolve routes by pointer.type. An unauthenticated, well-formed
 * concept_delete_write is refused 401 by the existing shape guard (it is not on the read
 * allowlist), so no pre-resolve guard keyed on another field is needed. A guard that read
 * top-level body.shape (7e897a99, reverted) answered 401 for requests the route never
 * routes by that field: it turned an input-validation 400 into an auth 401, and refused an
 * allowlisted read because of a stray key. These tests run the REAL auth middleware
 * (jwtAuthMiddleware) in front of the REAL impulses route; identity's answer is stubbed per
 * presented key at fetch and the root client's query is replaced by a recorder. No database
 * or network is touched.
 *   [MUST-FAIL] a body whose pointer has no type is a 400 input error, even when a
 *               top-level `shape` names a write shape (no auth refusal on an unrouted field);
 *   [MUST-FAIL] an allowlisted read (mcpTool) still answers unauthenticated when the body
 *               also carries a top-level `shape: "concept_delete_write"`;
 *   [HOLDS]     a well-formed unauthenticated concept_delete_write is refused 401 at the
 *               shape guard, with nothing queried;
 *   [CONTROL]   a read,write ApiKey passes both auth guards on concept_delete_write (not
 *               400/401/403), and writes concept_create_write (200, statements issued).
 *
 * Every stub is restored in afterAll, so a whole-suite, one-process run sees the real
 * modules after this file.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, mock, spyOn } from 'bun:test';
import { Hono } from 'hono';

const IDENTITY = 'http://identity-stub.test:1';

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
  if (/^INSERT INTO impulse/.test(s)) return [{ id: `impulse:${params.id}`, ...params }];
  if (/^UPDATE type::thing\("concept"/.test(s)) return [conceptRow(params.concept_id ?? params.cid)];
  if (/^SELECT \* FROM type::thing\("concept"/.test(s)) return [conceptRow(params.concept_id)];
  if (/^SELECT id FROM concept WHERE id = type::thing/.test(s)) return [{ id: `concept:${params.cid}` }];
  return [];
}

const previousSurrealModule = { ...(await import('../src/db/surreal')) };
mock.module('../src/db/surreal', () => ({
  ...previousSurrealModule,
  createAuthenticatedClient: async () => ({
    query: async (sql: string, params?: Record<string, any>) => {
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
  requireAuth: config.auth.requireAuth,
};
let querySpy: ReturnType<typeof spyOn> | null = null;

beforeAll(() => {
  config.metabob.identityEndpoint = IDENTITY;
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
  config.auth.requireAuth = saved.requireAuth;
  mock.module('../src/db/surreal', () => previousSurrealModule);
});

beforeEach(() => {
  calls.length = 0;
  lifecycleDispatcher.clear();
  // The default: the route's own shape guard decides, not the middleware.
  config.auth.requireAuth = false;
  identity.clear();
  identity.set('read-write-key', { scopes: ['read', 'write'], keyId: 'key_RWABCDEFGHIJKLM' });
});

function app(): Hono {
  const a = new Hono();
  a.use('*', jwtAuthMiddleware);
  a.route('/v2/impulses', impulses);
  return a;
}

async function post(body: unknown, authorization?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authorization) headers.Authorization = authorization;
  const res = await app().request('/v2/impulses/resolve', { method: 'POST', headers, body: JSON.stringify(body) });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  await new Promise((r) => setTimeout(r, 5)); // fire-and-forget follow-ups (audit, lifecycle hooks)
  return { status: res.status, body: json };
}

describe('the resolve route reads the shape from pointer.type only', () => {
  test('[MUST-FAIL] a pointer with no type is a 400 input error, not an auth refusal, whatever top-level shape says', async () => {
    const r = await post({ shape: 'concept_delete_write', pointer: { concept_id: 'concept_any_id' } });
    expect(r.status).toBe(400);
    expect(r.body?.error).toBe('Missing or invalid pointer.type');
    expect(calls).toEqual([]);
  });

  test('[MUST-FAIL] an allowlisted read answers unauthenticated even with a stray top-level write shape', async () => {
    const r = await post({ shape: 'concept_delete_write', pointer: { type: 'mcpTool' } });
    expect(r.status).toBe(200);
    expect(writes()).toEqual([]);
  });

  for (const requireAuth of [false, true]) {
    test(`[HOLDS] REQUIRE_AUTH=${requireAuth}: a well-formed unauthenticated concept_delete_write is refused 401, nothing queried`, async () => {
      config.auth.requireAuth = requireAuth;
      const r = await post({ pointer: { type: 'concept_delete_write', concept_id: 'concept_any_id' } });
      expect(r.status).toBe(401);
      if (!requireAuth) {
        // the route's shape guard, not a pre-resolve middleware
        expect(r.body?.code).toBe('AUTH_REQUIRED');
        expect(r.body?.shape).toBe('concept_delete_write');
      }
      expect(calls).toEqual([]);
    });
  }
});

describe('controls: an authenticated write is not refused', () => {
  test('[CONTROL] a read,write ApiKey passes both auth guards on concept_delete_write (not 400/401/403)', async () => {
    const r = await post({ pointer: { type: 'concept_delete_write', concept_id: 'concept_any_id' } }, 'ApiKey read-write-key');
    expect([400, 401, 403]).not.toContain(r.status);
  });

  test('[CONTROL] a read,write ApiKey writes concept_create_write (200, statements issued)', async () => {
    const r = await post(
      { pointer: { type: 'concept_create_write', conceptData: { source_type: 'extracted', content: 'hello world' } } },
      'ApiKey read-write-key',
    );
    expect(r.status).toBe(200);
    expect(writes().length).toBeGreaterThan(0);
  });
});
