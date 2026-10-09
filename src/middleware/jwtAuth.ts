/**
 * JWT Authentication Middleware for concept-db
 *
 * Supports two authentication header formats:
 * - Authorization: Bearer <jwt>  - JWT tokens (validated against SurrealDB)
 * - Authorization: ApiKey <key>  - API keys (validated via identity-vessel)
 *
 * JWT tokens contain org_id for multi-tenant isolation.
 *
 * Reject-by-default: when REQUIRE_AUTH=true, a request to a non-public path
 * with no Authorization header returns 401 MISSING_AUTH, and one whose
 * credentials are not accepted returns 401 INVALID_AUTH. When REQUIRE_AUTH is
 * false every request passes, with a null auth context when unauthenticated.
 * Route handlers still apply their own guards as defense-in-depth.
 */

import { Context, Next } from 'hono';
import { createAuthenticatedClient } from '../db/surreal';
import { config } from '../config';
import { logger } from '../utils/logger';
import { logAuthRefused, callerHint } from '../utils/auth-refusal-log';

export interface JwtAuthContext {
  jwtToken: string;
  orgId: string;
  projectId?: string;
  projectIds?: string[];
  instanceId?: string;
  role?: string;
  authType?: 'jwt' | 'apikey';
  keyId?: string;
  userId?: string;
}

/**
 * Paths that are publicly accessible without valid credentials.
 *
 * An `exact` entry matches only that path. A `prefix` entry (ending in '/')
 * matches every path under it. `methods`, when given, limits the entry to
 * those HTTP methods. The root '/' is exact: as a prefix it would match every
 * path and make every route public.
 *
 * Besides /health and the service index, the public entries are the read-only
 * routes that carry no guard by design (static tool definitions and in-process
 * scheduler state).
 */
interface PublicPath {
  path: string;
  match: 'exact' | 'prefix';
  methods?: readonly string[];
}

const READ_METHODS = ['GET', 'HEAD'] as const;

const PUBLIC_PATHS: readonly PublicPath[] = [
  { path: '/health', match: 'exact' },
  { path: '/', match: 'exact' },
  { path: '/mcp/tools', match: 'exact', methods: READ_METHODS },
  { path: '/mcp/tools/', match: 'prefix', methods: READ_METHODS }, // GET /mcp/tools/:name
  { path: '/upkeep/status', match: 'exact', methods: READ_METHODS },
  { path: '/upkeep/activities', match: 'exact', methods: READ_METHODS },
  { path: '/upkeep/activities/', match: 'prefix', methods: READ_METHODS }, // GET /upkeep/activities/:id
];

export function isPublicPath(path: string, method: string = 'GET'): boolean {
  const m = method.toUpperCase();
  for (const entry of PUBLIC_PATHS) {
    if (entry.methods && !entry.methods.includes(m)) continue;
    if (entry.match === 'exact') {
      if (path === entry.path) return true;
    } else if (path.startsWith(entry.path) && path.length > entry.path.length) {
      return true;
    }
  }
  return false;
}

/**
 * Validate API key via identity-vessel.
 *
 * Only the configured in-fleet identity endpoint is consulted. If it rejects
 * the key, errors, or is unreachable, the key is not accepted.
 */
async function validateApiKey(apiKey: string): Promise<JwtAuthContext | null> {
  return tryIdentityValidation(apiKey, config.metabob.identityEndpoint);
}

async function tryIdentityValidation(
  apiKey: string,
  identityUrl: string,
): Promise<JwtAuthContext | null> {
  try {
    const response = await fetch(`${identityUrl}/v1/auth/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        impulse: {
          type: 'authentication',
          pointer: { type: 'apiKey', apiKey },
        },
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      logger.warn('[ApiKey] Identity vessel validation failed', {
        url: identityUrl,
        status: response.status,
      });
      return null;
    }

    const result = (await response.json()) as {
      success: boolean;
      data?: {
        authenticated: boolean;
        orgId: string;
        userId?: string;
        keyId?: string;
        scopes?: string[];
        reason?: string;
      };
    };

    if (!result.success || !result.data?.authenticated) {
      logger.warn('[ApiKey] Identity vessel rejected key', {
        url: identityUrl,
        reason: result.data?.reason,
      });
      return null;
    }

    logger.info('[ApiKey] Identity vessel validated key', {
      url: identityUrl,
      orgId: result.data.orgId,
      keyId: result.data.keyId,
    });

    return {
      // Use empty jwtToken so downstream callers that call queryWithAuth()
      // fall through to surrealDB.query() (root-credentials path) rather
      // than attempting db.authenticate(<api-key>) which always fails.
      // The API key has already been validated by identity-vessel — the
      // caller IS authenticated. This mirrors activity-api's apikey fall-through pattern.
      jwtToken: '',
      orgId: result.data.orgId,
      userId: result.data.userId,
      keyId: result.data.keyId,
      authType: 'apikey',
    };
  } catch (error) {
    logger.warn('[ApiKey] Identity vessel unreachable', {
      url: identityUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * JWT authentication middleware
 */
export async function jwtAuthMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  const enforce = config.auth.requireAuth && !isPublicPath(c.req.path, c.req.method);

  if (!authHeader) {
    c.set('jwtAuth', null);
    if (enforce) {
      logAuthRefused({
        route: `${c.req.method} ${c.req.path}`,
        layer: 'middleware',
        reason: 'MISSING_AUTH',
        caller_hint: callerHint(c),
      });
      return c.json(
        { error: { code: 'MISSING_AUTH', message: 'Authorization header required' } },
        401,
      );
    }
    await next();
    return;
  }

  const jwtAuth = await resolveAuthHeader(authHeader);
  c.set('jwtAuth', jwtAuth);

  if (!jwtAuth && enforce) {
    logAuthRefused({
      route: `${c.req.method} ${c.req.path}`,
      layer: 'middleware',
      reason: 'INVALID_AUTH',
      caller_hint: callerHint(c),
    });
    return c.json(
      { error: { code: 'INVALID_AUTH', message: 'Credential validation failed' } },
      401,
    );
  }

  await next();
}

/**
 * Resolve an Authorization header to an auth context, or null when the
 * credentials are absent, malformed or not accepted.
 */
async function resolveAuthHeader(authHeader: string): Promise<JwtAuthContext | null> {
  // ApiKey branch — validated via identity-vessel
  const apiKeyMatch = authHeader.match(/^ApiKey\s+(.+)$/i);
  if (apiKeyMatch) {
    logger.debug('Processing ApiKey auth header');
    return validateApiKey(apiKeyMatch[1]);
  }

  // Bearer branch — JWT token validated against SurrealDB
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!bearerMatch) {
    logger.debug('Unrecognized auth header format');
    return null;
  }

  const token = bearerMatch[1];

  if (!token.includes('.')) {
    return null;
  }

  const periodCount = (token.match(/\./g) || []).length;
  if (periodCount !== 2) {
    logger.warn('Malformed JWT token structure', { periodCount });
    return null;
  }

  try {
    const db = await createAuthenticatedClient(token);

    const result = await db.query<[{
      id: string;
      org_id?: string;
      user_id?: string;
      scopes?: string[];
      project_ids?: string[];
      project_id?: string;
      instance_id?: string;
      role?: string;
    }]>(`RETURN {
      id: $auth.id,
      org_id: $auth.org_id,
      user_id: $auth.user_id,
      scopes: $auth.scopes,
      project_ids: $auth.project_ids,
      project_id: $auth.project_id,
      instance_id: $auth.instance_id,
      role: $auth.role
    }`);
    const auth = result[0] || null;

    await db.close();

    if (!auth) {
      logger.warn('JWT valid but no auth claims found');
      return null;
    }

    const jwtAuth: JwtAuthContext = {
      jwtToken: token,
      orgId: String(auth.org_id || '').replace(/^organizations:/, ''),
      projectId: auth.project_id ? String(auth.project_id).replace(/^projects:/, '') : undefined,
      projectIds: Array.isArray(auth.project_ids)
        ? auth.project_ids.map((p: unknown) => String(p).replace(/^projects:/, ''))
        : undefined,
      instanceId: auth.instance_id,
      role: auth.role,
      authType: 'jwt',
    };

    logger.debug('JWT authentication successful', {
      orgId: jwtAuth.orgId,
      projectId: jwtAuth.projectId,
    });

    return jwtAuth;
  } catch (error) {
    const err = error as Error;
    logger.debug('JWT authentication failed', { error: err.message });
    return null;
  }
}

/**
 * Helper to extract JWT auth context from request
 */
export function getJwtAuthFromContext(c: Context): JwtAuthContext | null {
  return c.get('jwtAuth') as JwtAuthContext | null;
}

/**
 * Check if request has valid JWT authentication
 */
export function hasJwtAuth(c: Context): boolean {
  const jwtAuth = getJwtAuthFromContext(c);
  return jwtAuth !== null && jwtAuth.jwtToken !== undefined;
}

/**
 * Require JWT authentication - returns 401 if not authenticated
 */
export function requireJwtAuth(c: Context): JwtAuthContext {
  const jwtAuth = getJwtAuthFromContext(c);
  if (!jwtAuth) {
    throw new Error('Authentication required');
  }
  return jwtAuth;
}
