/**
 * POST /v2/impulses/resolve: a writing shape requires an authenticated caller.
 *
 * The real app (src/index.ts) is driven in-process. Only the database driver
 * (the `surrealdb` package), the embedding model and outbound fetch are stubbed,
 * so the middleware, the route, the resolvers and the root client wrapper
 * (src/db/surreal.ts) all run for real. Every statement that reaches the driver
 * is recorded with the client it ran on (root or JWT-scoped).
 *
 *  - MUST-FAIL: an unauthenticated caller of any writing shape is refused before
 *    any statement reaches the database, whatever REQUIRE_AUTH says.
 *  - CONTROL: a valid ApiKey and a valid JWT can still write every shape.
 *  - CONTROL: the read allowlist answers unauthenticated and issues reads only.
 *  - DEFENCE IN DEPTH: inside an unauthenticated request scope the root client
 *    refuses every state-changing statement, so a writing path that a route
 *    guard misses still cannot write.
 *
 * Hermetic in a whole-suite, one-process run: see "One-process isolation" and
 * "Network guard" below. No test here may open a real network connection.
 */

import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll, mock } from 'bun:test';

process.env.NODE_ENV = 'test';
delete process.env.REQUIRE_AUTH; // the default
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

type DbCall = { sql: string; client: 'root' | 'jwt' };
const dbCalls: DbCall[] = [];
// Positive controls: what reached THIS file's driver stub.
const connectCalls: string[] = [];
const authenticateCalls: string[] = [];
const outbound: string[] = [];

const WRITE_RE = /\b(CREATE|UPDATE|UPSERT|INSERT|DELETE|RELATE|DEFINE|REMOVE|ALTER|REBUILD)\b/i;
const isWrite = (sql: string) => WRITE_RE.test(sql.replace(/"[^"]*"|'[^']*'/g, '""'));
const writes = () => dbCalls.filter((c) => isWrite(c.sql));

function conceptRow(id: string) {
  const bare = String(id).replace(/^concept:/, '');
  return {
    id: `concept:${bare}`,
    shape: 'memo',
    summary: 'probe',
    content: 'probe content',
    source_type: 'extracted',
    token_estimate: 3,
    relevance: 0.5,
    times_loaded: 0,
    org_id: 'default',
  };
}

function respond(sql: string, params: Record<string, any> = {}): unknown[] {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (/^CREATE type::thing\("concept_usage"/.test(s)) return [{ id: `concept_usage:${params.id}`, ...params }];
  if (/^CREATE type::thing\("concept"/.test(s)) return [conceptRow(params.id)];
  if (/^INSERT INTO concept_edge/.test(s)) return [{ id: `concept_edge:${params.id}`, ...params }];
  if (/^INSERT INTO impulse/.test(s)) return [{ id: `impulse:${params.id}`, ...params }];
  if (/^UPDATE type::thing\("concept"/.test(s)) return [conceptRow(params.concept_id ?? params.cid ?? 'c')];
  if (/^SELECT \* FROM type::thing\("concept"/.test(s)) return [conceptRow(params.concept_id)];
  if (/^SELECT id FROM concept WHERE id = type::thing/.test(s)) return [{ id: `concept:${params.cid}` }];
  if (/^SELECT id, times_loaded, times_succeeded FROM concept/.test(s)) {
    return [{ id: 'concept:concept_c1', times_loaded: 5, times_succeeded: 5 }];
  }
  if (/^SELECT trace_id, outcome FROM concept_usage/.test(s)) return [{ trace_id: 'trace-real', outcome: 'success' }];
  return [];
}

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
  async query(sql: string, params?: Record<string, unknown>) {
    const s = String(sql);
    // jwtAuthMiddleware reads the claims of an authenticated JWT session.
    if (this.token && s.includes('$auth.org_id')) {
      return [{ id: 'user:u1', org_id: 'organizations:org-jwt', role: 'member' }];
    }
    dbCalls.push({ sql: s, client: this.token ? 'jwt' : 'root' });
    return [respond(s, (params ?? {}) as Record<string, any>)];
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
    embed: async () => new Float32Array(8).fill(0.5),
    embedBatch: async (ts: string[]) => ts.map((_, i) => new Float32Array(8).fill(i + 1)),
  },
}));

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  outbound.push(url);
  let origin = '';
  try { origin = new URL(url).origin; } catch { /* not a URL */ }
  if (!ALLOWED_FETCH_ORIGINS.has(origin)) forbidNetwork(`fetch ${url}`);
  if (url.endsWith('/v1/auth/resolve')) {
    const body = JSON.parse(String(init?.body ?? '{}'));
    const key = body?.impulse?.pointer?.apiKey;
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
const HERMETIC_SURREAL = '../src/db/surreal.ts?hermetic=resolve-unauthenticated-writes';
const hermeticSurreal = await import(HERMETIC_SURREAL);
mock.module('../src/db/surreal', () => ({ ...hermeticSurreal }));

const mod = await import('../src/index');
const fetchApp = (mod as any).default.fetch as (r: Request) => Promise<Response>;
const impulsesMod = await import('../src/routes/impulses');
// Absent before the fix; the tests that need it then fail individually.
const scope: any = await import('../src/db/request-auth-scope').catch(() => ({
  runInRequestAuthScope: (_a: boolean, fn: () => unknown) => fn(),
  UnauthenticatedWriteError: class MissingModule extends Error {},
  isWriteStatement: () => { throw new Error('src/db/request-auth-scope is missing'); },
}));
const conceptR = await import('../src/resolvers/concept');
const edgeR = await import('../src/resolvers/edge');
const usageR = await import('../src/resolvers/usage');
const seqR = await import('../src/resolvers/sequence');
const deconR = await import('../src/resolvers/decontaminate');
const impulseR = await import('../src/resolvers/impulse');
const sourceR = await import('../src/sources/unified');
const { logger } = await import('../src/utils/logger');

// Let the startup connect settle before the first test.
await new Promise((r) => setTimeout(r, 20));

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
  outbound.length = 0;
  config.auth.requireAuth = false;
});

async function resolve(pointer: Record<string, unknown>, headers: Record<string, string> = {}) {
  const res = await fetchApp(new Request('http://local/v2/impulses/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ pointer }),
  }));
  let body: any = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

const WRITING: Array<[string, Record<string, unknown>]> = [
  ['impulseSignatureConcept', { type: 'impulseSignatureConcept', pointer_type: 'probe', shape: 'probeShape' }],
  ['concept with concept_id', { type: 'concept', concept_id: 'concept_c1' }],
  ['concept_write', { type: 'concept_write', source_type: 'extracted', content: 'hello world' }],
  ['concept_create_write', { type: 'concept_create_write', conceptData: { source_type: 'extracted', content: 'hello world' } }],
  ['conceptLink_write', { type: 'conceptLink_write', linkData: { from_concept_id: 'concept_a', to_concept_id: 'concept_b', edge_type: 'related_to' } }],
  ['conceptSignatureUpsert_write', { type: 'conceptSignatureUpsert_write', pointer_type: 'probe', shape: 'probeShape' }],
  ['conceptCreditDecontaminate_write', { type: 'conceptCreditDecontaminate_write', dry_run: false, min_loads: 1 }],
  ['conceptUsage_write', { type: 'conceptUsage_write', usageData: { concept_id: 'concept_c1', trace_id: 'trace-1', outcome: 'success' } }],
  ['conceptSequence_write', { type: 'conceptSequence_write', sequenceData: { concept_ids: ['concept_a', 'concept_b'], trace_id: 'trace-1' } }],
];
// Advertised write shapes with no implementation yet: refused all the same.
const UNIMPLEMENTED_WRITES = ['concept_delete_write', 'concept_retire_write', 'concept_supersede_write'];

function expectRefused(r: { status: number; body: any }) {
  expect(r.status).toBe(401);
  expect(dbCalls).toEqual([]);
  if (config.auth.requireAuth && typeof r.body?.error === 'object') {
    // Under REQUIRE_AUTH the auth middleware may refuse before the route runs.
    expect(['MISSING_AUTH', 'INVALID_AUTH']).toContain(r.body.error.code);
    return;
  }
  expect(r.body?.success).toBe(false);
  expect(r.body?.error).toBe('Authentication required');
}

describe('ISOLATION: the auth paths run against this file\'s stubs', () => {
  test('a valid JWT is authenticated by this file\'s driver stub and writes on the JWT client', async () => {
    authenticateCalls.length = 0;
    const r = await resolve(WRITING[0][1], { Authorization: `Bearer ${VALID_JWT}` });
    expect(authenticateCalls).toContain(VALID_JWT);
    expect(r.status).toBe(200);
    expect(writes().some((w) => w.client === 'jwt')).toBe(true);
  });

  test('a valid ApiKey is validated by the identity stub and writes on this file\'s root client', async () => {
    const r = await resolve(WRITING[0][1], { Authorization: `ApiKey ${GOOD_KEY}` });
    expect(outbound).toContain(`${IDENTITY_STUB_URL}/v1/auth/resolve`);
    expect(r.status).toBe(200);
    expect(writes().some((w) => w.client === 'root')).toBe(true);
    expect(connectCalls.length).toBeGreaterThan(0);
    expect(connectCalls.every((u) => u === DB_STUB_URL)).toBe(true);
  });
});

describe('MUST-FAIL: an unauthenticated writing shape is refused with zero DB calls', () => {
  for (const requireAuth of [false, true]) {
    for (const [name, pointer] of WRITING) {
      test(`REQUIRE_AUTH=${requireAuth}: ${name}, no credentials`, async () => {
        config.auth.requireAuth = requireAuth;
        const r = await resolve(pointer);
        expectRefused(r);
      });
    }
  }

  for (const [name, pointer] of WRITING) {
    test(`REQUIRE_AUTH=false: ${name}, rejected ApiKey`, async () => {
      const r = await resolve(pointer, { Authorization: 'ApiKey bad-key' });
      expectRefused(r);
    });
    test(`REQUIRE_AUTH=false: ${name}, Bearer token that fails authentication`, async () => {
      const r = await resolve(pointer, { Authorization: 'Bearer not.a.validtoken' });
      expectRefused(r);
    });
  }

  for (const shape of UNIMPLEMENTED_WRITES) {
    test(`REQUIRE_AUTH=false: ${shape}, no credentials`, async () => {
      const r = await resolve({ type: shape });
      expectRefused(r);
    });
  }

  test('REQUIRE_AUTH=false: an unknown shape, no credentials, is refused without a DB call', async () => {
    const r = await resolve({ type: 'definitely_not_a_shape' });
    expectRefused(r);
  });

  test('the refusal names the read shapes an unauthenticated caller may use', async () => {
    const r = await resolve({ type: 'impulseSignatureConcept', pointer_type: 'p', shape: 's' });
    expect(r.body?.code).toBe('AUTH_REQUIRED');
    expect(r.body?.unauthenticated_read_shapes ?? []).toContain('mcpTool');
    expect(r.body?.unauthenticated_read_shapes).not.toContain('impulseSignatureConcept');
  });
});

describe('CONTROL: an authenticated caller can still write every shape', () => {
  const callers: Array<[string, Record<string, string>, 'root' | 'jwt']> = [
    ['valid ApiKey', { Authorization: `ApiKey ${GOOD_KEY}` }, 'root'],
    ['valid JWT', { Authorization: `Bearer ${VALID_JWT}` }, 'jwt'],
  ];
  for (const requireAuth of [false, true]) {
    for (const [who, headers, client] of callers) {
      for (const [name, pointer] of WRITING) {
        test(`REQUIRE_AUTH=${requireAuth}: ${who} → ${name} writes`, async () => {
          config.auth.requireAuth = requireAuth;
          const r = await resolve(pointer, headers);
          expect(r.status).toBe(200);
          expect(writes().length).toBeGreaterThan(0);
          // decontaminateCredit always uses the root client (it takes no token).
          if (name !== 'conceptCreditDecontaminate_write') {
            expect(writes().some((w) => w.client === client)).toBe(true);
          }
        });
      }
    }
  }
});

describe('CONTROL: open reads stay open unauthenticated', () => {
  test('GET /health answers 200 without credentials', async () => {
    const res = await fetchApp(new Request('http://local/health'));
    expect(res.status).toBe(200);
  });

  test('mcpTool answers 200 without credentials and touches no DB', async () => {
    const r = await resolve({ type: 'mcpTool' });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body?.content)).toBe(true);
    expect(dbCalls).toEqual([]);
  });

  const READS: Array<[string, Record<string, unknown>]> = [
    ['mcpTool', { type: 'mcpTool' }],
    ['resolver_schema', { type: 'resolver_schema', shape: 'concept' }],
    ['concept (search form)', { type: 'concept', query: 'hello' }],
    ['conceptSearch', { type: 'conceptSearch', query: 'hello' }],
    ['conceptGraph', { type: 'conceptGraph', concept_id: 'concept_c1' }],
    ['relatedConcepts', { type: 'relatedConcepts', concept_id: 'concept_c1' }],
    ['conceptUsageStats', { type: 'conceptUsageStats', concept_id: 'concept_c1' }],
    ['conceptSequence', { type: 'conceptSequence', concept_id: 'concept_c1' }],
    ['impulseCooccurrenceEdges', { type: 'impulseCooccurrenceEdges' }],
    ['embed', { type: 'embed', text: 'hello' }],
    ['cluster', { type: 'cluster', items: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }] }],
  ];

  test('the read list under test is exactly the route allowlist', () => {
    const listed = new Set(READS.map(([, p]) => String(p.type)));
    expect([...listed].sort()).toEqual([...((impulsesMod as any).UNAUTHENTICATED_READ_SHAPES ?? [])].sort());
  });

  for (const [name, pointer] of READS) {
    test(`allowlisted read ${name} answers 200 unauthenticated and issues no write`, async () => {
      const r = await resolve(pointer);
      expect(r.status).toBe(200);
      expect(writes()).toEqual([]);
    });
  }

  test('the same read under REQUIRE_AUTH=false with a rejected ApiKey still answers (anonymous read)', async () => {
    const r = await resolve({ type: 'conceptSearch', query: 'hello' }, { Authorization: 'ApiKey bad-key' });
    expect(r.status).toBe(200);
    expect(writes()).toEqual([]);
  });
});

describe('DEFENCE IN DEPTH: the root client refuses writes in an unauthenticated request scope', () => {
  // Every resolver a writing shape reaches. Each runs once with no auth context
  // (refused, no write reaches the driver) and once authenticated (writes).
  const RESOLVERS: Array<[string, () => Promise<unknown>]> = [
    ['upsertBySignature', () => conceptR.upsertBySignature({ pointerType: 'p', shape: 's', orgId: 'default' })],
    ['resolveConcept', () => conceptR.resolveConcept({ concept_id: 'concept_c1', include_neighbors: false, neighbor_depth: 1 }, 'default')],
    ['createConcept', () => conceptR.createConcept({ source_type: 'extracted', content: 'x' } as any, 'default')],
    ['createConceptFromSource', () => sourceR.createConceptFromSource({ source_type: 'extracted', content: 'x' } as any, 'default')],
    ['updateConcept', () => conceptR.updateConcept('concept_c1', { summary: 'y' } as any, 'default')],
    ['upsertEdge', () => edgeR.upsertEdge({ from_concept_id: 'concept_a', to_concept_id: 'concept_b', edge_type: 'related_to' }, 'default')],
    ['createEdge', () => edgeR.createEdge({ from_concept_id: 'concept_a', to_concept_id: 'concept_b', edge_type: 'related_to' }, 'default')],
    ['recordUsage', () => usageR.recordUsage({ concept_id: 'concept_c1', trace_id: 'trace-1', outcome: 'success' }, 'default')],
    ['recordSequence', () => seqR.recordSequence({ concept_ids: ['concept_a', 'concept_b'], trace_id: 'trace-1' }, 'default')],
    ['decontaminateCredit', () => deconR.decontaminateCredit({ dry_run: false, min_loads: 1 })],
    ['createImpulse', () => impulseR.createImpulse({ shape: 'conceptUpkeepAuditLog', pointer: { type: 'audit' } } as any, 'default')],
  ];

  for (const [name, call] of RESOLVERS) {
    test(`${name}: no auth context → no write reaches the database`, async () => {
      let threw: unknown = null;
      try {
        await scope.runInRequestAuthScope(false, call);
      } catch (e) {
        threw = e;
      }
      // decontaminateCredit records per-row update failures instead of throwing.
      if (name !== 'decontaminateCredit') expect(threw).toBeInstanceOf(scope.UnauthenticatedWriteError);
      await new Promise((r) => setTimeout(r, 5)); // fire-and-forget follow-ups
      expect(writes()).toEqual([]);
    });

    test(`${name}: authenticated scope → writes (control)`, async () => {
      await scope.runInRequestAuthScope(true, call);
      expect(writes().length).toBeGreaterThan(0);
    });
  }

  test('a writing shape wrongly added to the read allowlist still cannot write unauthenticated', async () => {
    const list = (impulsesMod as any).UNAUTHENTICATED_READ_SHAPES as string[];
    expect(Array.isArray(list)).toBe(true);
    const added = WRITING.map(([, p]) => String(p.type)).filter((s) => !list.includes(s));
    list.push(...added);
    try {
      for (const [name, pointer] of WRITING) {
        if (name === 'concept with concept_id') continue; // excluded by pointer, not by list
        dbCalls.length = 0;
        const r = await resolve(pointer);
        await new Promise((res) => setTimeout(res, 5));
        expect({ name, writes: writes() }).toEqual({ name, writes: [] });
        // decontaminate reports a refused row update as skipped and answers 200.
        if (name !== 'conceptCreditDecontaminate_write') expect(r.status).not.toBe(200);
      }
    } finally {
      for (const s of added) list.splice(list.indexOf(s), 1);
    }
  });

  test('outside any request scope (startup, scheduler) the root client is unaffected', async () => {
    await conceptR.upsertBySignature({ pointerType: 'p', shape: 's', orgId: 'default' });
    expect(writes().length).toBeGreaterThan(0);
  });

  test('field names and literals that contain write keywords are not treated as writes', () => {
    expect(scope.isWriteStatement('SELECT * FROM concept ORDER BY updated_at DESC, created_at')).toBe(false);
    expect(scope.isWriteStatement('SELECT * FROM concept WHERE summary = "DELETE me" AND x = \'UPDATE\'')).toBe(false);
    expect(scope.isWriteStatement('  update type::thing("concept", $id) SET x = 1')).toBe(true);
    expect(scope.isWriteStatement('LET $x = (CREATE concept SET a = 1); RETURN $x')).toBe(true);
  });
});

describe('conceptCreditDecontaminate_write logs each caller', () => {
  const MSG = 'conceptCreditDecontaminate_write requested';
  const pointer = { type: 'conceptCreditDecontaminate_write', dry_run: true, min_loads: 1 };

  async function captureInfo(fn: () => Promise<unknown>) {
    const seen: Array<[string, unknown]> = [];
    const orig = logger.info.bind(logger);
    (logger as any).info = (m: string, ctx?: unknown) => { seen.push([m, ctx]); return orig(m, ctx as any); };
    try { await fn(); } finally { (logger as any).info = orig; }
    return seen;
  }

  for (const [who, headers, org] of [
    ['valid ApiKey', { Authorization: `ApiKey ${GOOD_KEY}` }, 'org-key'],
    ['valid JWT', { Authorization: `Bearer ${VALID_JWT}` }, 'org-jwt'],
  ] as const) {
    test(`${who}: one line naming the shape, org_id and auth_context=yes, without the credential`, async () => {
      const seen = await captureInfo(() => resolve(pointer, { ...headers }));
      const lines = seen.filter(([m]) => m === MSG);
      expect(lines.length).toBe(1);
      expect(lines[0][1]).toEqual({ shape: 'conceptCreditDecontaminate_write', org_id: org, auth_context: 'yes' });
      const all = JSON.stringify(seen);
      expect(all).not.toContain(GOOD_KEY);
      expect(all).not.toContain(VALID_JWT);
    });
  }

  test('unauthenticated: refused before the write path, so no line and no DB call', async () => {
    const seen = await captureInfo(() => resolve(pointer));
    expect(seen.filter(([m]) => m === MSG)).toEqual([]);
    expect(dbCalls).toEqual([]);
  });
});

describe('[auth-refused]: one log line per refusal, never the credential', () => {
  const FAKE_KEY = 'FAKEKEY-zz9-plural-z-alpha-0xDEADBEEF';
  const FAKE_JWT = 'eyFAKE.eyCREDENTIAL.sigFAKECRED';

  async function captureAll(fn: () => Promise<unknown>) {
    const lines: Array<{ level: string; msg: string; ctx: any }> = [];
    const levels = ['debug', 'info', 'warn', 'error'] as const;
    const orig = levels.map((l) => (logger as any)[l]);
    levels.forEach((l, i) => {
      (logger as any)[l] = (m: string, ctx?: unknown) => { lines.push({ level: l, msg: m, ctx }); return orig[i].call(logger, m, ctx); };
    });
    try { await fn(); } finally { levels.forEach((l, i) => { (logger as any)[l] = orig[i]; }); }
    return { lines, refused: lines.filter((x) => x.msg === '[auth-refused]') };
  }

  for (const [name, pointer] of WRITING) {
    test(`MUST-FAIL: unauthenticated ${name} → exactly one shape_guard line, no credential bytes`, async () => {
      const { lines, refused } = await captureAll(() => resolve(pointer, {
        Authorization: `ApiKey ${FAKE_KEY}`,
        'x-forwarded-for': '10.1.2.3',
        'x-libp2p-peer-id': '12D3KooWPeer',
        'x-libp2p-auth-token': 'SECRET-IN-PEER-HEADER',
      }));
      expect(refused.length).toBe(1);
      expect(refused[0].ctx).toEqual({
        route: 'POST /v2/impulses/resolve',
        shape: String(pointer.type),
        layer: 'shape_guard',
        reason: 'AUTH_REQUIRED: shape requires an authenticated caller',
        caller_hint: 'x-forwarded-for=10.1.2.3 x-libp2p-peer-id=12D3KooWPeer',
      });
      const all = JSON.stringify(lines);
      expect(all).not.toContain(FAKE_KEY);
      expect(all).not.toContain('SECRET-IN-PEER-HEADER');
      expect(dbCalls).toEqual([]);
    });
  }

  test('no transport header → caller_hint "unknown" (no server address in-process)', async () => {
    const { refused } = await captureAll(() => resolve({ type: 'impulseSignatureConcept', pointer_type: 'p', shape: 's' }));
    expect(refused.length).toBe(1);
    expect(refused[0].ctx.caller_hint).toBe('unknown');
  });

  test('a failed JWT is not logged either', async () => {
    const { lines, refused } = await captureAll(() => resolve(WRITING[0][1], { Authorization: `Bearer ${FAKE_JWT}` }));
    expect(refused.length).toBe(1);
    expect(JSON.stringify(lines)).not.toContain('eyCREDENTIAL');
  });

  test('root layer refusal (writing shape wrongly allowlisted) → one root_write line', async () => {
    const list = (impulsesMod as any).UNAUTHENTICATED_READ_SHAPES as string[];
    list.push('impulseSignatureConcept');
    try {
      const { lines, refused } = await captureAll(() => resolve(
        { type: 'impulseSignatureConcept', pointer_type: 'p', shape: 's' },
        { Authorization: `ApiKey ${FAKE_KEY}`, 'x-substrate-vessel': 'probe-vessel' },
      ));
      expect(refused.length).toBe(1);
      expect(refused[0].ctx).toEqual({
        route: 'POST /v2/impulses/resolve',
        shape: 'impulseSignatureConcept',
        layer: 'root_write',
        reason: 'state-changing statement without an authenticated caller',
        caller_hint: 'x-substrate-vessel=probe-vessel',
      });
      expect(JSON.stringify(lines)).not.toContain(FAKE_KEY);
      expect(writes()).toEqual([]);
    } finally {
      list.splice(list.indexOf('impulseSignatureConcept'), 1);
    }
  });

  for (const [who, headers] of [
    ['valid ApiKey', { Authorization: `ApiKey ${GOOD_KEY}` }],
    ['valid JWT', { Authorization: `Bearer ${VALID_JWT}` }],
  ] as const) {
    test(`CONTROL: ${who} writes emit no [auth-refused] line`, async () => {
      for (const requireAuth of [false, true]) {
        config.auth.requireAuth = requireAuth;
        for (const [, pointer] of WRITING) {
          const { refused } = await captureAll(() => resolve(pointer, { ...headers }));
          expect(refused).toEqual([]);
        }
      }
    });
  }
});

describe('NETWORK GUARD', () => {
  test('no test in this file attempted a real network connection', () => {
    expect(forbiddenNet).toEqual([]);
  });
});
