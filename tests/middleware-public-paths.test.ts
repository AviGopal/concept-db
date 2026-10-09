/**
 * jwtAuthMiddleware: only the named public paths are public.
 *
 * '/' in PUBLIC_PATHS is the service index, matched exactly. Under REQUIRE_AUTH
 * the middleware itself refuses a request to any other path that has no
 * Authorization header (MISSING_AUTH) or whose credentials are not accepted
 * (INVALID_AUTH), even when the route behind it has no guard of its own. With
 * REQUIRE_AUTH=false every request still passes the middleware.
 *
 * The real app (src/index.ts) and a probe app with an UNGUARDED route behind the
 * real middleware are driven in-process. Only the database driver, the embedding
 * model and outbound fetch are stubbed.
 */

import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { Hono } from 'hono';

process.env.NODE_ENV = 'test';
delete process.env.REQUIRE_AUTH;
process.env.IDENTITY_VESSEL_URL = 'http://identity-stub.test:1';
delete process.env.IDENTITY_VESSEL_EXTERNAL_URL;
process.env.DISCOVERY_ENABLED = 'false';
process.env.UPKEEP_ENABLED = 'false';
process.env.OBSERVER_ENABLED = 'false';
process.env.DENSE_BACKFILL_ENABLED = 'false';
process.env.SURREALDB_URL = 'http://db-stub.test:1';
process.env.ACTIVITY_API_URL = 'http://activity-api-stub.test:1';

const GOOD_KEY = 'good-key';
const VALID_JWT = 'header.payload.signature';
const dbCalls: string[] = [];

class FakeSurreal {
  private token: string | null = null;
  async connect() {}
  async use() {}
  async signin() {}
  async close() {}
  async authenticate(token: string) {
    if (token !== VALID_JWT) throw new Error('Authentication failed');
    this.token = token;
  }
  async query(sql: string) {
    const s = String(sql);
    if (this.token && s.includes('$auth.org_id')) {
      return [{ id: 'user:u1', org_id: 'organizations:org-jwt', role: 'member' }];
    }
    dbCalls.push(s);
    if (/^\s*SELECT \* FROM type::thing\("concept"/.test(s)) {
      return [[{ id: 'concept:concept_c1', shape: 'memo', summary: 's', content: 'c', source_type: 'extracted', org_id: 'default' }]];
    }
    return [[]];
  }
}
mock.module('surrealdb', () => ({ Surreal: FakeSurreal }));

mock.module('../src/services/embedding', () => ({
  embeddingCacheKey: (t: string) => t,
  EmbeddingCache: class { get() { return undefined; } set() {} },
  embeddingService: {
    getStatus: () => ({ status: 'stub' }),
    init: async () => {},
    isReady: () => false,
    embed: async () => new Float32Array(8),
    embedBatch: async (ts: string[]) => ts.map(() => new Float32Array(8)),
  },
}));

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith('/v1/auth/resolve')) {
    const key = JSON.parse(String(init?.body ?? '{}'))?.impulse?.pointer?.apiKey;
    if (key === GOOD_KEY) {
      return new Response(JSON.stringify({
        success: true,
        data: { authenticated: true, orgId: 'org-key', userId: 'user-key', keyId: 'key-1' },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: true, data: { authenticated: false, orgId: '' } }), { status: 200 });
  }
  return new Response('{}', { status: 200 });
}) as typeof fetch;

const mod = await import('../src/index');
const fetchApp = (mod as any).default.fetch as (r: Request) => Promise<Response>;
const { config } = await import('../src/config');
const mw = await import('../src/middleware/jwtAuth');
await new Promise((r) => setTimeout(r, 20));

// The mutant "route guard removed": a handler with no guard of its own.
let probeHits = 0;
const probe = new Hono();
probe.use('*', mw.jwtAuthMiddleware);
probe.all('/probe-unguarded', (c) => {
  probeHits++;
  return c.json({ reached: true, jwtAuth: mw.getJwtAuthFromContext(c) ?? null });
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  dbCalls.length = 0;
  probeHits = 0;
  config.auth.requireAuth = false;
});

async function call(
  target: 'app' | 'probe',
  method: string,
  path: string,
  opts: { body?: unknown; auth?: string } = {},
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.auth) headers.Authorization = opts.auth;
  const req = new Request('http://local' + path, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const res = target === 'app' ? await fetchApp(req) : await probe.fetch(req);
  let body: any = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

describe('MUST-FAIL: REQUIRE_AUTH=true, the middleware refuses non-public paths', () => {
  beforeEach(() => { config.auth.requireAuth = true; });

  test('no credentials, unguarded route → MISSING_AUTH, handler never runs', async () => {
    const r = await call('probe', 'POST', '/probe-unguarded');
    expect(r.status).toBe(401);
    expect(r.body?.error?.code).toBe('MISSING_AUTH');
    expect(probeHits).toBe(0);
  });

  for (const [what, auth] of [
    ['rejected ApiKey', 'ApiKey bad-key'],
    ['JWT that fails authentication', 'Bearer not.a.validtoken'],
    ['malformed Bearer token', 'Bearer opaque-token'],
    ['unrecognised scheme', 'Basic dXNlcjpwYXNz'],
  ] as const) {
    test(`${what}, unguarded route → INVALID_AUTH, handler never runs`, async () => {
      const r = await call('probe', 'POST', '/probe-unguarded', { auth });
      expect(r.status).toBe(401);
      expect(r.body?.error?.code).toBe('INVALID_AUTH');
      expect(probeHits).toBe(0);
    });
  }

  const PROTECTED: Array<[string, string, unknown?]> = [
    ['POST', '/concepts', { source_type: 'extracted', content: 'x' }],
    ['GET', '/concepts/search?query=x'],
    ['GET', '/concepts/concept_c1'],
    ['POST', '/mcp/tools/call', { tool: 'concept_search', arguments: {} }],
    ['POST', '/mcp/tools/batch', { calls: [] }],
    ['POST', '/upkeep/trigger'],
    ['POST', '/upkeep/scheduler/start'],
    ['POST', '/v2/impulses/resolve', { pointer: { type: 'impulseSignatureConcept', pointer_type: 'p', shape: 's' } }],
    ['POST', '/v2/impulses/resolve', { pointer: { type: 'mcpTool' } }],
    ['GET', '/health/extra'],
    ['GET', '/nonexistent'],
  ];
  for (const [method, path, body] of PROTECTED) {
    test(`no credentials, ${method} ${path}${body ? ' ' + JSON.stringify(body).slice(0, 60) : ''} → MISSING_AUTH, no DB call`, async () => {
      const r = await call('app', method, path, { body });
      expect(r.status).toBe(401);
      expect(r.body?.error?.code).toBe('MISSING_AUTH');
      expect(dbCalls).toEqual([]);
    });
  }

  test('rejected ApiKey on POST /upkeep/trigger → INVALID_AUTH', async () => {
    const r = await call('app', 'POST', '/upkeep/trigger', { auth: 'ApiKey bad-key' });
    expect(r.status).toBe(401);
    expect(r.body?.error?.code).toBe('INVALID_AUTH');
  });
});

describe('CONTROL: REQUIRE_AUTH=true, public paths and valid credentials pass', () => {
  beforeEach(() => { config.auth.requireAuth = true; });

  const PUBLIC: Array<[string, number]> = [
    ['/health', 200],
    ['/', 200],
    ['/mcp/tools', 200],
    ['/mcp/tools/concept_create', 200],
    ['/upkeep/status', 200],
    ['/upkeep/activities', 200],
    ['/upkeep/activities/no-such-activity', 404],
  ];
  for (const [path, status] of PUBLIC) {
    test(`GET ${path} answers ${status} without credentials`, async () => {
      const r = await call('app', 'GET', path);
      expect(r.status).toBe(status);
    });
  }

  test('isPublicPath: GET-only entries do not open other methods', () => {
    expect(mw.isPublicPath('/mcp/tools/concept_create', 'GET')).toBe(true);
    expect(mw.isPublicPath('/mcp/tools/call', 'POST')).toBe(false);
    expect(mw.isPublicPath('/upkeep/activities/x', 'DELETE')).toBe(false);
    expect(mw.isPublicPath('/', 'GET')).toBe(true);
    expect(mw.isPublicPath('/concepts', 'GET')).toBe(false);
    expect(mw.isPublicPath('/v2/impulses/resolve', 'POST')).toBe(false);
  });

  test('valid ApiKey reaches the unguarded route with its auth context', async () => {
    const r = await call('probe', 'POST', '/probe-unguarded', { auth: `ApiKey ${GOOD_KEY}` });
    expect(r.status).toBe(200);
    expect(r.body?.jwtAuth?.orgId).toBe('org-key');
    expect(probeHits).toBe(1);
  });

  test('valid JWT reaches the unguarded route with its auth context', async () => {
    const r = await call('probe', 'POST', '/probe-unguarded', { auth: `Bearer ${VALID_JWT}` });
    expect(r.status).toBe(200);
    expect(r.body?.jwtAuth?.orgId).toBe('org-jwt');
    expect(probeHits).toBe(1);
  });

  test('valid ApiKey resolves mcpTool', async () => {
    const r = await call('app', 'POST', '/v2/impulses/resolve', { auth: `ApiKey ${GOOD_KEY}`, body: { pointer: { type: 'mcpTool' } } });
    expect(r.status).toBe(200);
  });
});

describe('CONTROL: REQUIRE_AUTH=false, unauthenticated requests still pass the middleware', () => {
  for (const auth of [undefined, 'ApiKey bad-key', 'Bearer not.a.validtoken', 'Bearer opaque-token']) {
    test(`unguarded route, ${auth ?? 'no credentials'} → reached with a null auth context`, async () => {
      const r = await call('probe', 'POST', '/probe-unguarded', { auth });
      expect(r.status).toBe(200);
      expect(r.body?.reached).toBe(true);
      expect(r.body?.jwtAuth).toBeNull();
    });
  }

  const READS: Array<[string, string, unknown?]> = [
    ['GET', '/concepts/search?query=x'],
    ['GET', '/concepts/concept_c1'],
    ['GET', '/upkeep/status'],
    ['POST', '/v2/impulses/resolve', { pointer: { type: 'mcpTool' } }],
    ['POST', '/v2/impulses/resolve', { pointer: { type: 'conceptSearch', query: 'x' } }],
  ];
  for (const [method, path, body] of READS) {
    test(`unauthenticated read ${method} ${path}${body ? ' ' + JSON.stringify(body) : ''} → 200`, async () => {
      const r = await call('app', method, path, { body });
      expect(r.status).toBe(200);
    });
  }

  test('a writing shape is still refused, by the route, not the middleware', async () => {
    const r = await call('app', 'POST', '/v2/impulses/resolve', {
      body: { pointer: { type: 'impulseSignatureConcept', pointer_type: 'p', shape: 's' } },
    });
    expect(r.status).toBe(401);
    expect(r.body?.error).toBe('Authentication required');
    expect(r.body?.code).toBe('AUTH_REQUIRED');
    expect(dbCalls).toEqual([]);
  });
});
