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
 *
 * Hermetic in a whole-suite, one-process run: see "One-process isolation" and
 * "Network guard" below. No test here may open a real network connection.
 */

import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { Hono } from 'hono';

process.env.NODE_ENV = 'test';
delete process.env.REQUIRE_AUTH;
process.env.IDENTITY_VESSEL_URL = 'http://identity-stub.test:1';
delete process.env.IDENTITY_VESSEL_EXTERNAL_URL;
process.env.DISCOVERY_ENABLED = 'false';
process.env.UPKEEP_ENABLED = 'false';
process.env.OBSERVER_ENABLED = 'false';
process.env.DENSE_BACKFILL_ENABLED = 'false';
const DB_STUB_URL = 'http://db-stub.test:1';
const IDENTITY_STUB_URL = 'http://identity-stub.test:1';
const ACTIVITY_API_STUB_URL = 'http://activity-api-stub.test:1';
process.env.SURREALDB_URL = DB_STUB_URL;
process.env.ACTIVITY_API_URL = ACTIVITY_API_STUB_URL;

// ---- Network guard ----------------------------------------------------------
// Every outbound fetch must go to a stub origin below, and no WebSocket may be
// opened. Database traffic never goes through fetch: the driver is stubbed, so a
// fetch to any database URL means the stub was bypassed. jwtAuth turns a thrown
// error into "not authenticated", so a trip is also recorded and fails the test
// that caused it (afterEach) and the summary test at the end of the file.
const ALLOWED_FETCH_ORIGINS = new Set([new URL(IDENTITY_STUB_URL).origin, new URL(ACTIVITY_API_STUB_URL).origin]);
const forbiddenNet: string[] = [];
function forbidNetwork(what: string): never {
  forbiddenNet.push(what);
  throw new Error(`NETWORK GUARD: ${what}`);
}
const originalWebSocket = globalThis.WebSocket;
(globalThis as any).WebSocket = class GuardedWebSocket {
  constructor(url: unknown) { forbidNetwork(`WebSocket ${String(url)}`); }
};

const GOOD_KEY = 'good-key';
const VALID_JWT = 'header.payload.signature';
const dbCalls: string[] = [];
// Positive controls: what reached THIS file's driver stub.
const connectCalls: string[] = [];
const authenticateCalls: string[] = [];

class FakeSurreal {
  private token: string | null = null;
  async connect(url: unknown) { connectCalls.push(String(url)); }
  async use() {}
  async signin() {}
  async close() {}
  async authenticate(token: string) {
    authenticateCalls.push(token);
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
const outbound: string[] = [];
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  outbound.push(url);
  let origin = '';
  try { origin = new URL(url).origin; } catch { /* not a URL */ }
  if (!ALLOWED_FETCH_ORIGINS.has(origin)) forbidNetwork(`fetch ${url}`);
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

// ---- One-process isolation ---------------------------------------------------
// A whole-suite `bun test` run shares one module registry across files. Before
// this file runs, another file may already have: loaded src/config with the
// default database and identity URLs; mocked src/db/surreal with a partial stub
// whose JWT path refuses (tests/apikey-identity-primary-only.test.ts); and
// connected the root client singleton to its own driver stub, or, where a real
// database answers on the default URL, to that database. So this file pins the
// config fields it depends on to stub values, loads its own instance of
// src/db/surreal (bound to FakeSurreal above, sharing the request auth scope),
// installs it under the shared specifier before importing the app, and restores
// all of it in afterAll so later files see what they saw before.
const { config } = await import('../src/config');
// The env above only reaches config when this file is the first to load it.
const configPins: Array<[Record<string, unknown>, string, unknown]> = [
  [config.surrealdb, 'url', DB_STUB_URL],
  [config.metabob, 'identityEndpoint', IDENTITY_STUB_URL],
  [config.activityApi, 'url', ACTIVITY_API_STUB_URL],
  [config.discovery, 'enabled', false],
  [config.upkeep, 'enabled', false],
  [config.observer, 'enabled', false],
];
const savedConfig = configPins.map(([obj, key]) => obj[key]);
for (const [obj, key, value] of configPins) obj[key] = value;
const previousSurrealModule = { ...(await import('../src/db/surreal')) };
const HERMETIC_SURREAL = '../src/db/surreal.ts?hermetic=middleware-public-paths';
const hermeticSurreal = await import(HERMETIC_SURREAL);
mock.module('../src/db/surreal', () => ({ ...hermeticSurreal }));

const mod = await import('../src/index');
const fetchApp = (mod as any).default.fetch as (r: Request) => Promise<Response>;
const mw = await import('../src/middleware/jwtAuth');
const { logger } = await import('../src/utils/logger');
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
  (globalThis as any).WebSocket = originalWebSocket;
  configPins.forEach(([obj, key], i) => { obj[key] = savedConfig[i]; });
  mock.module('../src/db/surreal', () => previousSurrealModule);
});

let forbiddenSeen = 0;
afterEach(() => {
  if (forbiddenNet.length > forbiddenSeen) {
    const tripped = forbiddenNet.slice(forbiddenSeen);
    forbiddenSeen = forbiddenNet.length;
    throw new Error(`NETWORK GUARD tripped: ${tripped.join('; ')}`);
  }
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

describe('ISOLATION: the auth paths run against this file\'s stubs', () => {
  test('a valid JWT is authenticated by this file\'s driver stub', async () => {
    authenticateCalls.length = 0;
    const r = await call('probe', 'POST', '/probe-unguarded', { auth: `Bearer ${VALID_JWT}` });
    expect(authenticateCalls).toContain(VALID_JWT);
    expect(r.body?.jwtAuth?.orgId).toBe('org-jwt');
  });

  test('a valid ApiKey is validated by the identity stub', async () => {
    outbound.length = 0;
    const r = await call('probe', 'POST', '/probe-unguarded', { auth: `ApiKey ${GOOD_KEY}` });
    expect(outbound).toContain(`${IDENTITY_STUB_URL}/v1/auth/resolve`);
    expect(r.body?.jwtAuth?.orgId).toBe('org-key');
  });

  test('root queries reach this file\'s driver stub at the stub URL', async () => {
    const r = await call('app', 'GET', '/concepts/concept_c1');
    expect(dbCalls.length).toBeGreaterThan(0);
    expect(connectCalls.length).toBeGreaterThan(0);
    expect(connectCalls.every((u) => u === DB_STUB_URL)).toBe(true);
    expect(r.status).toBeLessThan(500);
  });
});

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

describe('[auth-refused]: the middleware logs one line per refusal, never the credential', () => {
  const FAKE_KEY = 'FAKEKEY-mw-0xC0FFEE-recognisable';

  async function captureAll(fn: () => Promise<unknown>) {
    const lines: Array<{ msg: string; ctx: any }> = [];
    const levels = ['debug', 'info', 'warn', 'error'] as const;
    const orig = levels.map((l) => (logger as any)[l]);
    levels.forEach((l, i) => {
      (logger as any)[l] = (m: string, ctx?: unknown) => { lines.push({ msg: m, ctx }); return orig[i].call(logger, m, ctx); };
    });
    try { await fn(); } finally { levels.forEach((l, i) => { (logger as any)[l] = orig[i]; }); }
    return { lines, refused: lines.filter((x) => x.msg === '[auth-refused]') };
  }

  test('REQUIRE_AUTH=true, no credentials → one middleware MISSING_AUTH line', async () => {
    config.auth.requireAuth = true;
    const { refused } = await captureAll(() => call('app', 'POST', '/v2/impulses/resolve', {
      body: { pointer: { type: 'impulseSignatureConcept', pointer_type: 'p', shape: 's' } },
    }));
    expect(refused.length).toBe(1);
    expect(refused[0].ctx).toEqual({
      route: 'POST /v2/impulses/resolve', layer: 'middleware', reason: 'MISSING_AUTH', caller_hint: 'unknown',
    });
  });

  test('REQUIRE_AUTH=true, rejected ApiKey → one middleware INVALID_AUTH line without the key', async () => {
    config.auth.requireAuth = true;
    const { lines, refused } = await captureAll(() => call('probe', 'POST', '/probe-unguarded', { auth: `ApiKey ${FAKE_KEY}` }));
    expect(refused.length).toBe(1);
    expect(refused[0].ctx).toMatchObject({ route: 'POST /probe-unguarded', layer: 'middleware', reason: 'INVALID_AUTH' });
    expect(JSON.stringify(lines)).not.toContain(FAKE_KEY);
  });

  test('CONTROL: public path and REQUIRE_AUTH=false pass without a line', async () => {
    config.auth.requireAuth = true;
    const a = await captureAll(() => call('app', 'GET', '/health'));
    config.auth.requireAuth = false;
    const b = await captureAll(() => call('probe', 'POST', '/probe-unguarded'));
    expect(a.refused).toEqual([]);
    expect(b.refused).toEqual([]);
  });
});

describe('NETWORK GUARD', () => {
  test('no test in this file attempted a real network connection', () => {
    expect(forbiddenNet).toEqual([]);
  });
});
