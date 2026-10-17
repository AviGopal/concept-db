/**
 * The auth census counts requests by ROUTE PATTERN and credential type, never by concrete path (an id is never logged).
 */
import { describe, test, expect } from 'bun:test';
import { Hono } from 'hono';
import { authCensusMiddleware, takeCensusWindow } from '../src/services/auth-census';

function app(auth: Record<string, unknown> | null) {
  const a = new Hono();
  a.use('*', async (c, next) => { if (auth) c.set('jwtAuth' as never, auth as never); await next(); });
  a.use('*', authCensusMiddleware);
  const concepts = new Hono();
  concepts.get('/:id', (c) => c.json({ ok: true }));
  concepts.get('/:id/edges', (c) => c.json({ edges: [] }));
  a.route('/concepts', concepts);
  return a;
}

describe('auth census', () => {
  test('MF: a request is counted under its route pattern and credential type; the concrete id never appears', async () => {
    takeCensusWindow();
    await app(null).request('/concepts/concept_secretid123');
    await app(null).request('/concepts/concept_other/edges');
    await app({ orgId: 'o', authType: 'apikey', jwtToken: '' }).request('/concepts/concept_x');
    const w = takeCensusWindow();
    expect(w).toContainEqual({ method: 'GET', route: '/concepts/:id', auth: 'none', n: 1 });
    expect(w).toContainEqual({ method: 'GET', route: '/concepts/:id/edges', auth: 'none', n: 1 });
    expect(w).toContainEqual({ method: 'GET', route: '/concepts/:id', auth: 'apikey', n: 1 });
    expect(JSON.stringify(w)).not.toContain('concept_secretid123');
  });
  test('CONTROL: a window is reset once taken; an unknown path is counted as unmatched, not by its text', async () => {
    takeCensusWindow();
    expect(takeCensusWindow()).toEqual([]);
    await app(null).request('/nope/concept_leak');
    const w = takeCensusWindow();
    expect(JSON.stringify(w)).not.toContain('concept_leak');
  });
});
