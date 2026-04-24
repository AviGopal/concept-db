/**
 * Discovery Client Tests
 *
 * Wave 1B: verifies concept-db advertises its resolver contract
 * (`resolve_endpoint`, `resolve_request_format`, `auth_scheme`,
 * `resolve_timeout_ms`) to discovery-vessel on registration. These fields
 * let callers (minibob, Wave 1D) invoke concept-db's resolver without any
 * hardcoded per-vessel knowledge.
 *
 * The test stubs `fetch` so no network is required, asserts the POST body
 * against `/register`, and inspects only the four contract fields plus
 * core identity fields (to sanity-check the rest of the payload is still
 * intact).
 */

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  spyOn,
} from 'bun:test';
import { DiscoveryClient } from '../src/services/discovery-client';

interface CapturedRequest {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

function stubFetch(captured: CapturedRequest[]) {
  return spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const method = (init?.method || 'GET').toUpperCase();
      const rawBody = init?.body;
      let body: Record<string, unknown> = {};
      if (typeof rawBody === 'string' && rawBody.length > 0) {
        body = JSON.parse(rawBody) as Record<string, unknown>;
      }
      captured.push({ url, method, body });

      // Simulate successful registration response
      return new Response(
        JSON.stringify({
          success: true,
          vesselId: body.vesselId ?? 'concept-db-test',
          expiresAt: Date.now() + 300_000,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  );
}

/**
 * Force a fresh DiscoveryClient singleton for each test so state from one
 * test doesn't leak into the next. The class holds `DiscoveryClient.instance`
 * as a private static; we reach through the prototype to reset it.
 */
function resetSingleton() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DiscoveryClient as any).instance = null;
}

describe('DiscoveryClient.register advertises resolver contract', () => {
  let captured: CapturedRequest[];
  let fetchSpy: ReturnType<typeof stubFetch>;

  beforeEach(() => {
    resetSingleton();
    captured = [];
    fetchSpy = stubFetch(captured);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    resetSingleton();
  });

  test('POST /register body includes the four contract fields', async () => {
    const client = DiscoveryClient.getInstance();
    const ok = await client.register();
    expect(ok).toBe(true);

    const registerCall = captured.find((c) => c.url.endsWith('/register'));
    expect(registerCall).toBeDefined();
    expect(registerCall!.method).toBe('POST');

    const body = registerCall!.body;

    // Contract fields (Wave 1B) — the point of this test.
    expect(body.resolve_endpoint).toBe('/v2/impulses/resolve');
    expect(body.resolve_request_format).toBe('pointer');
    expect(body.auth_scheme).toBe('ApiKey');
    expect(body.resolve_timeout_ms).toBe(10000);
  });

  test('POST /register body still carries identity fields (regression)', async () => {
    const client = DiscoveryClient.getInstance();
    await client.register();

    const registerCall = captured.find((c) => c.url.endsWith('/register'));
    expect(registerCall).toBeDefined();
    const body = registerCall!.body;

    // Sanity-check that adding the contract fields didn't drop anything.
    expect(typeof body.vesselId).toBe('string');
    expect(typeof body.vesselName).toBe('string');
    expect(typeof body.endpoint).toBe('string');
    expect(Array.isArray(body.shapes)).toBe(true);
    expect((body.shapes as string[]).length).toBeGreaterThan(0);
    expect(body.protocol).toBe('http');
  });
});
