/**
 * A CONCEPT'S AUTHOR IS THE KEY THE SERVER VALIDATED, NEVER THE CLIENT'S CLAIM.
 *
 * concept_create_write stored no server-stamped authorship, so any authorship a
 * client declared was the only record of who wrote a concept. These tests run the
 * REAL auth middleware (jwtAuthMiddleware) in front of the REAL impulses route.
 * Identity's answer is stubbed per presented key at fetch and the root client's
 * query is replaced by a recorder of each statement and its params. No database
 * or network is touched.
 *   [MUST-FAIL] a write that declares written_by "x" and a fake written_by_key is
 *               stored with the validated key's id and name;
 *   [MUST-FAIL] an identity that answers no name (an older identity) still gets
 *               written_by_key stamped, and written_by is left unset, never "x";
 *   [MUST-FAIL] the migration declares both fields on concept, which is
 *               SCHEMAFULL and would silently drop an undeclared field;
 *   [CONTROL]   an unauthenticated write is refused 401 with nothing queried, as
 *               today; no presented key appears in any log line.
 *
 * Every stub is restored in afterAll, so a whole-suite, one-process run sees the
 * real modules after this file.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, spyOn } from 'bun:test';
import { Hono } from 'hono';
import { readFileSync } from 'fs';
import { join } from 'path';

const IDENTITY = 'http://identity-stub.test:1';
const NAMED_KEY = 'authorship-named-key';
const UNNAMED_KEY = 'authorship-unnamed-key';

// identity's answer per presented key. A key not listed is refused.
type Answer = { keyId: string; name?: string };
const identity = new Map<string, Answer>();

type Call = { sql: string; params: Record<string, any> };
const calls: Call[] = [];
const creates = () => calls.filter((c) => /^\s*CREATE type::thing\("concept"/.test(c.sql));

function respond(sql: string, params: Record<string, any> = {}): unknown[] {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (/^CREATE type::thing\("concept"/.test(s)) return [{ ...params, id: `concept:${params.id}` }];
  if (/^INSERT INTO impulse/.test(s)) return [{ id: `impulse:${params.id}`, ...params }];
  return [];
}

const { config } = await import('../src/config');
const { surrealDB } = await import('../src/db/surreal');
const { jwtAuthMiddleware } = await import('../src/middleware/jwtAuth');
const { impulses } = await import('../src/routes/impulses');
const { lifecycleDispatcher } = await import('../src/lifecycle/dispatcher');

const originalFetch = globalThis.fetch;
const saved = { identityEndpoint: config.metabob.identityEndpoint, requireAuth: config.auth.requireAuth };
let querySpy: ReturnType<typeof spyOn> | null = null;

// Every console line the run writes, to check no presented key is logged.
const logged: string[] = [];
const consoleSpies: Array<ReturnType<typeof spyOn>> = [];

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
        data: {
          authenticated: true, orgId: 'org-1', userId: 'user-1', keyId: a.keyId, scopes: ['read', 'write'],
          ...(a.name !== undefined ? { name: a.name } : {}),
        },
      }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  querySpy = spyOn(surrealDB, 'query').mockImplementation((async (sql: string, params?: Record<string, any>) => {
    calls.push({ sql: String(sql), params: params ?? {} });
    return respond(String(sql), params);
  }) as never);
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const orig = console[m].bind(console);
    consoleSpies.push(spyOn(console, m).mockImplementation(((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      orig(...args);
    }) as never));
  }
});

afterAll(() => {
  querySpy?.mockRestore();
  for (const s of consoleSpies) s.mockRestore();
  globalThis.fetch = originalFetch;
  config.metabob.identityEndpoint = saved.identityEndpoint;
  config.auth.requireAuth = saved.requireAuth;
});

beforeEach(() => {
  calls.length = 0;
  lifecycleDispatcher.clear();
  config.auth.requireAuth = true;
  identity.clear();
  identity.set(NAMED_KEY, { keyId: 'key_AUTHNAMED000001', name: 'drafter-node-key' });
  identity.set(UNNAMED_KEY, { keyId: 'key_AUTHUNNAMED0002' });
});

function app(): Hono {
  const a = new Hono();
  a.use('*', jwtAuthMiddleware);
  a.route('/v2/impulses', impulses);
  return a;
}

async function resolve(authorization: string | null, pointer: Record<string, unknown>) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authorization) headers.Authorization = authorization;
  const res = await app().request('/v2/impulses/resolve', { method: 'POST', headers, body: JSON.stringify({ pointer }) });
  let body: any = null;
  try { body = await res.json(); } catch { body = null; }
  await new Promise((r) => setTimeout(r, 5)); // fire-and-forget follow-ups (audit, lifecycle hooks)
  return { status: res.status, body };
}

// A write that claims someone else wrote it, at the top level and in its metadata.
const CLAIMING = {
  type: 'concept_create_write',
  conceptData: {
    source_type: 'extracted',
    content: 'authorship probe',
    written_by: 'x',
    written_by_key: 'key_FAKECLIENTCLAIM',
    metadata: { written_by: 'x', written_by_key: 'key_FAKECLIENTCLAIM' },
  },
};

describe('concept_create_write stamps the validated key as the author', () => {
  test('[MUST-FAIL] a write declaring written_by "x" is stored with the validated key\'s id and name', async () => {
    const r = await resolve(`ApiKey ${NAMED_KEY}`, CLAIMING);
    expect(r.status).toBe(200);
    const [create] = creates();
    expect(create).toBeDefined();
    expect(create.sql).toContain('written_by_key = $written_by_key');
    expect(create.sql).toContain('written_by = $written_by');
    expect(create.params.written_by_key).toBe('key_AUTHNAMED000001');
    expect(create.params.written_by).toBe('drafter-node-key');
    const stored = JSON.parse(r.body.content);
    expect(stored.written_by_key).toBe('key_AUTHNAMED000001');
    expect(stored.written_by).toBe('drafter-node-key');
  });

  test('[MUST-FAIL] an identity with no name: written_by_key is stamped, written_by is unset, never the client\'s', async () => {
    const r = await resolve(`ApiKey ${UNNAMED_KEY}`, CLAIMING);
    expect(r.status).toBe(200);
    const [create] = creates();
    expect(create).toBeDefined();
    expect(create.params.written_by_key).toBe('key_AUTHUNNAMED0002');
    expect(create.params.written_by).toBeUndefined();
    expect(create.sql).not.toContain('written_by = $written_by');
  });
});

describe('controls', () => {
  test('[CONTROL] an unauthenticated write is refused 401 and nothing is queried', async () => {
    const r = await resolve(null, CLAIMING);
    expect(r.status).toBe(401);
    expect(calls).toEqual([]);
  });

  test('[MUST-FAIL] the migration declares both fields on concept, which is SCHEMAFULL', () => {
    const sql = readFileSync(join(import.meta.dir, '..', 'sql', 'core', '010-concept-written-by.surql'), 'utf-8');
    expect(sql).toContain('DEFINE FIELD IF NOT EXISTS written_by_key ON concept TYPE option<string>;');
    expect(sql).toContain('DEFINE FIELD IF NOT EXISTS written_by ON concept TYPE option<string>;');
    // the runner splits on the semicolon before stripping comments
    for (const line of sql.split('\n').filter((l) => l.trim().startsWith('--'))) expect(line).not.toContain(';');
  });

  test('[CONTROL] no presented key appears in any log line', async () => {
    await resolve(`ApiKey ${NAMED_KEY}`, CLAIMING);
    await resolve(`ApiKey ${UNNAMED_KEY}`, CLAIMING);
    await resolve('ApiKey authorship-refused-key', CLAIMING);
    const all = logged.join('\n');
    for (const k of [NAMED_KEY, UNNAMED_KEY, 'authorship-refused-key']) expect(all).not.toContain(k);
  });
});
