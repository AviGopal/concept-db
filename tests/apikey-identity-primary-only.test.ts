/**
 * ApiKey validation trusts only the configured in-fleet identity endpoint.
 *
 * A key is accepted only when the primary identity endpoint accepts it. When the
 * primary rejects the key, answers with an error status, or cannot be reached,
 * the key is not accepted and no request goes to any other identity URL.
 * "Not accepted" means the request carries no auth context, so the route-level
 * guard refuses it under REQUIRE_AUTH and treats it as anonymous otherwise.
 *
 * Every outbound call is captured by a fetch recorder; nothing leaves the process.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test';
import { Hono } from 'hono';

const PRIMARY = 'http://identity-primary.test:8080';

process.env.IDENTITY_VESSEL_URL = PRIMARY;
delete process.env.IDENTITY_VESSEL_EXTERNAL_URL;
process.env.REQUIRE_AUTH = 'true';

// JWT branch: stand in for SurrealDB so the Bearer path can be exercised offline.
// In a whole-suite, one-process run a module mock outlives this file, so the mock
// keeps every other export of the real module and afterAll puts the module back.
let jwtClaims: Record<string, unknown> | null = null;
let jwtAuthenticateFails = false;
const previousSurrealModule = { ...(await import('../src/db/surreal')) };
mock.module('../src/db/surreal', () => ({
  ...previousSurrealModule,
  createAuthenticatedClient: async (_token: string) => {
    if (jwtAuthenticateFails) throw new Error('Authentication failed');
    return {
      query: async () => [jwtClaims],
      close: async () => {},
    };
  },
}));

type Recorded = { url: string; body: unknown };
let calls: Recorded[] = [];
type PrimaryMode = 'accept' | 'reject-body' | 'reject-401' | 'error-503' | 'timeout' | 'network';
let primaryMode: PrimaryMode = 'accept';
let elsewhereAccepts = true;

const ACCEPT_BODY = {
  success: true,
  data: { authenticated: true, orgId: 'org-primary', userId: 'user-1', keyId: 'key-1' },
};

const originalFetch = globalThis.fetch;

function recorder(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
  let body: unknown = undefined;
  try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { body = init?.body; }
  calls.push({ url: u, body });

  if (!u.startsWith(PRIMARY)) {
    // Any other identity host "accepts" — so trusting it would be observable.
    if (!elsewhereAccepts) {
      return Promise.resolve(new Response(JSON.stringify({
        success: true, data: { authenticated: false, orgId: '' },
      }), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify({
      success: true,
      data: { authenticated: true, orgId: 'org-elsewhere', userId: 'user-x', keyId: 'key-x' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }

  switch (primaryMode) {
    case 'accept':
      return Promise.resolve(new Response(JSON.stringify(ACCEPT_BODY), { status: 200 }));
    case 'reject-body':
      return Promise.resolve(new Response(JSON.stringify({
        success: true,
        data: { authenticated: false, orgId: '', reason: 'unknown key' },
      }), { status: 200 }));
    case 'reject-401':
      return Promise.resolve(new Response(JSON.stringify({ success: false }), { status: 401 }));
    case 'error-503':
      return Promise.resolve(new Response('unavailable', { status: 503 }));
    case 'timeout': {
      const err = new Error('The operation timed out.');
      err.name = 'TimeoutError';
      return Promise.reject(err);
    }
    case 'network':
      return Promise.reject(new TypeError('fetch failed'));
  }
}

let app: Hono;
let config: { auth: { requireAuth: boolean }; metabob: { identityEndpoint: string } };
let savedIdentityEndpoint = '';

beforeAll(async () => {
  globalThis.fetch = recorder as typeof fetch;
  const mw = await import('../src/middleware/jwtAuth');
  config = (await import('../src/config')).config as unknown as typeof config;
  // The env above only reaches config when this file is the first to load it.
  savedIdentityEndpoint = config.metabob.identityEndpoint;
  config.metabob.identityEndpoint = PRIMARY;
  app = new Hono();
  app.use('*', mw.jwtAuthMiddleware);
  // Mirrors the route handlers' own guard (`config.auth.requireAuth && !jwtAuth` -> 401).
  // Under REQUIRE_AUTH the middleware refuses a non-public path itself (MISSING_AUTH /
  // INVALID_AUTH) before this handler runs, so a refused response may carry no jwtAuth
  // field at all; the assertions read an absent field as "no context".
  app.get('/probe', (c) => {
    const jwtAuth = mw.getJwtAuthFromContext(c) ?? null;
    if (config.auth.requireAuth && !jwtAuth) {
      return c.json({ jwtAuth, error: { code: 'ROUTE_AUTH_REQUIRED' } }, 401);
    }
    return c.json({ jwtAuth });
  });
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  config.metabob.identityEndpoint = savedIdentityEndpoint;
  jwtClaims = null;
  jwtAuthenticateFails = false;
  mock.module('../src/db/surreal', () => previousSurrealModule);
});

beforeEach(() => {
  calls = [];
  primaryMode = 'accept';
  elsewhereAccepts = true;
  jwtClaims = null;
  jwtAuthenticateFails = false;
  config.auth.requireAuth = true;
});

async function probe(header: string) {
  const res = await app.request('/probe', { headers: { Authorization: header } });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

function nonPrimaryCalls(): Recorded[] {
  return calls.filter((c) => !c.url.startsWith(PRIMARY));
}

describe('ApiKey validation: primary failure is never retried elsewhere', () => {
  for (const mode of ['reject-body', 'reject-401'] as const) {
    test(`primary rejects the key (${mode}) -> refused, no other identity URL contacted`, async () => {
      primaryMode = mode;
      const { status, json } = await probe('ApiKey some-key');
      expect(nonPrimaryCalls()).toEqual([]);
      expect(calls.length).toBe(1);
      expect(calls[0].url).toBe(`${PRIMARY}/v1/auth/resolve`);
      expect(json.jwtAuth ?? null).toBeNull();
      expect(status).toBe(401);
    });
  }

  for (const mode of ['error-503', 'timeout', 'network'] as const) {
    test(`transient primary failure (${mode}) -> refused, no other identity URL contacted`, async () => {
      primaryMode = mode;
      const { status, json } = await probe('ApiKey some-key');
      expect(nonPrimaryCalls()).toEqual([]);
      expect(calls.length).toBe(1);
      expect(json.jwtAuth ?? null).toBeNull();
      expect(status).toBe(401);
    });
  }

  test('REQUIRE_AUTH=false: primary rejection leaves the request anonymous, no other URL contacted', async () => {
    config.auth.requireAuth = false;
    primaryMode = 'reject-body';
    const { status, json } = await probe('ApiKey some-key');
    expect(nonPrimaryCalls()).toEqual([]);
    expect(status).toBe(200);
    expect(json.jwtAuth ?? null).toBeNull();
  });

  test('REQUIRE_AUTH=false: transient primary failure leaves the request anonymous, no other URL contacted', async () => {
    config.auth.requireAuth = false;
    primaryMode = 'error-503';
    const { status, json } = await probe('ApiKey some-key');
    expect(nonPrimaryCalls()).toEqual([]);
    expect(status).toBe(200);
    expect(json.jwtAuth ?? null).toBeNull();
  });
});

describe('controls: unchanged behaviour', () => {
  test('primary accepts a valid key -> apikey context as before', async () => {
    primaryMode = 'accept';
    const { status, json } = await probe('ApiKey good-key');
    expect(status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(`${PRIMARY}/v1/auth/resolve`);
    expect(calls[0].body).toEqual({
      impulse: { type: 'authentication', pointer: { type: 'apiKey', apiKey: 'good-key' } },
    });
    expect(json.jwtAuth).toEqual({
      jwtToken: '',
      orgId: 'org-primary',
      userId: 'user-1',
      keyId: 'key-1',
      authType: 'apikey',
    });
  });

  test('invalid key (no identity endpoint accepts it) -> not accepted, as before', async () => {
    elsewhereAccepts = false;
    primaryMode = 'reject-body';
    const { status, json } = await probe('ApiKey bad-key');
    expect(json.jwtAuth ?? null).toBeNull();
    expect(status).toBe(401);
    expect(calls[0].url).toBe(`${PRIMARY}/v1/auth/resolve`);
  });

  test('missing Authorization -> no context, no fetch', async () => {
    const res = await app.request('/probe');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { jwtAuth?: unknown }).jwtAuth ?? null).toBeNull();
    expect(calls).toEqual([]);
  });

  test('valid JWT -> jwt context with prefixes stripped, no identity fetch', async () => {
    jwtClaims = {
      id: 'user:1',
      org_id: 'organizations:acme',
      project_id: 'projects:p1',
      project_ids: ['projects:p1', 'projects:p2'],
      instance_id: 'inst-1',
      role: 'admin',
    };
    const token = 'aaa.bbb.ccc';
    const { status, json } = await probe(`Bearer ${token}`);
    expect(status).toBe(200);
    expect(calls).toEqual([]);
    expect(json.jwtAuth).toEqual({
      jwtToken: token,
      orgId: 'acme',
      projectId: 'p1',
      projectIds: ['p1', 'p2'],
      instanceId: 'inst-1',
      role: 'admin',
      authType: 'jwt',
    });
  });

  test('JWT the database refuses -> anonymous context, no identity fetch', async () => {
    config.auth.requireAuth = false;
    jwtAuthenticateFails = true;
    const { status, json } = await probe('Bearer aaa.bbb.ccc');
    expect(status).toBe(200);
    expect(json.jwtAuth ?? null).toBeNull();
    expect(calls).toEqual([]);
  });
});
