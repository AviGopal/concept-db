/**
 * AUTH CENSUS: which callers reach this vessel with which credential, by ROUTE PATTERN (never an id, a body or a key).
 * One line per minute with the window's counts per (method, route, auth), so the set of callers that arrive with NO
 * credential is measured before anyone decides on enforcing authentication (gap
 * concept-db-accepts-unauthenticated-callers-as-org-default), and a caller that silently falls back to an
 * unauthenticated read is visible.
 */
import type { Context, Next } from 'hono';
import { getJwtAuthFromContext } from '../middleware/jwtAuth';
import { logger } from '../utils/logger';

export type CensusAuth = 'apikey' | 'jwt' | 'none';
const counts = new Map<string, number>();

/** The matched route pattern (e.g. "/concepts/:id"), never the concrete path. */
export function routePatternOf(c: Context): string {
  const routes = (c.req as unknown as { matchedRoutes?: Array<{ method: string; path: string }> }).matchedRoutes ?? [];
  for (let i = routes.length - 1; i >= 0; i--) if (routes[i]!.method !== 'ALL') return routes[i]!.path;
  return '(unmatched)';
}

export function authOf(c: Context): CensusAuth {
  const a = getJwtAuthFromContext(c);
  return !a ? 'none' : a.authType === 'apikey' ? 'apikey' : 'jwt';
}

export async function authCensusMiddleware(c: Context, next: Next): Promise<void> {
  await next();
  try {
    const key = `${c.req.method} ${routePatternOf(c)} ${authOf(c)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  } catch { /* the census never affects a request */ }
}

/** The window so far, and reset it. */
export function takeCensusWindow(): Array<{ method: string; route: string; auth: CensusAuth; n: number }> {
  const out = [...counts.entries()].map(([k, n]) => {
    const [method, route, auth] = k.split(' ') as [string, string, CensusAuth];
    return { method, route, auth, n };
  });
  counts.clear();
  return out.sort((a, b) => b.n - a.n);
}

export function startAuthCensus(everyMs = 60_000): void {
  const t = setInterval(() => {
    const w = takeCensusWindow();
    if (w.length > 0) logger.info('[auth-census] window', { window_s: Math.round(everyMs / 1000), none: w.filter((x) => x.auth === 'none').reduce((a, x) => a + x.n, 0), entries: w.slice(0, 40) });
  }, everyMs);
  (t as { unref?: () => void }).unref?.();
}
