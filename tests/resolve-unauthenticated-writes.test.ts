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
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test';

process.env.NODE_ENV = 'test';
delete process.env.REQUIRE_AUTH; // the default
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

type DbCall = { sql: string; client: 'root' | 'jwt' };
const dbCalls: DbCall[] = [];
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
  async connect() {}
  async use() {}
  async signin() {}
  async close() {}
  async authenticate(token: string) {
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

const mod = await import('../src/index');
const fetchApp = (mod as any).default.fetch as (r: Request) => Promise<Response>;
const { config } = await import('../src/config');
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

// Let the startup connect settle before the first test.
await new Promise((r) => setTimeout(r, 20));

afterAll(() => {
  globalThis.fetch = originalFetch;
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
