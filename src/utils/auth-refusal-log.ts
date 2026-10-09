/**
 * One greppable log line per auth refusal: `[auth-refused]`.
 *
 * Fields: route, shape (when known), layer, reason and a caller hint. The
 * caller hint comes from transport/peer headers (x-libp2p-*, x-forwarded-for,
 * x-substrate-vessel), else the remote address when the server exposes it,
 * else "unknown". The Authorization header and any header whose name suggests
 * it may carry a secret are never read into the line.
 */

import type { Context } from 'hono';
import { logger } from './logger';

export const AUTH_REFUSED_PREFIX = '[auth-refused]';

export type AuthRefusalLayer = 'shape_guard' | 'root_write' | 'middleware';

export interface AuthRefusal {
  route: string;
  shape?: string;
  layer: AuthRefusalLayer;
  reason: string;
  caller_hint: string;
}

const SECRET_NAME = /auth|token|key|secret|signature|cookie|password|credential|session|bearer/i;
const MAX_VALUE = 120;

function safeValue(v: string): string | null {
  const t = v.trim();
  if (!t) return null;
  // Header values that look like a scheme + credential are dropped, not trimmed.
  if (/^(apikey|bearer|basic|token)\s/i.test(t)) return null;
  return t.replace(/[^\w.:,\-\/\[\] ]/g, '?').slice(0, MAX_VALUE);
}

function headerHints(headers: Headers): string[] {
  const out: string[] = [];
  headers.forEach((value, rawName) => {
    const name = rawName.toLowerCase();
    if (name === 'authorization' || SECRET_NAME.test(name)) return;
    const wanted =
      name.startsWith('x-libp2p-') || name === 'x-forwarded-for' || name === 'x-substrate-vessel';
    if (!wanted) return;
    const v = safeValue(value);
    if (v) out.push(`${name}=${v}`);
  });
  return out.sort();
}

/** Transport/peer hint for a request; never includes credentials. */
export function callerHint(c: Context): string {
  try {
    const hints = headerHints(c.req.raw.headers);
    if (hints.length) return hints.join(' ');
  } catch {
    /* fall through */
  }
  try {
    // Bun.serve passes the server as env; requestIP gives the peer address.
    const env = c.env as { requestIP?: (r: Request) => { address?: string } | null } | undefined;
    const addr = env?.requestIP?.(c.req.raw)?.address;
    if (addr) return `remote=${safeValue(addr) ?? 'unknown'}`;
  } catch {
    /* fall through */
  }
  return 'unknown';
}

export function logAuthRefused(r: AuthRefusal): void {
  const ctx: Record<string, unknown> = {
    route: r.route,
    layer: r.layer,
    reason: r.reason,
    caller_hint: r.caller_hint,
  };
  if (r.shape !== undefined) ctx.shape = String(r.shape).slice(0, MAX_VALUE);
  logger.warn(AUTH_REFUSED_PREFIX, ctx);
}
