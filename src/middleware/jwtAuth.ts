/**
 * JWT Authentication Middleware for concept-db
 *
 * Supports two authentication header formats:
 * - Authorization: Bearer <jwt>  - JWT tokens (validated against SurrealDB)
 * - Authorization: ApiKey <key>  - API keys (validated via identity-vessel)
 *
 * JWT tokens contain org_id for multi-tenant isolation.
 *
 * Reject-by-default: when REQUIRE_AUTH=true, requests without valid auth on
 * non-public paths return 401. Route handlers can still apply their own
 * `requireAuth` guards as defense-in-depth.
 */

import { Context, Next } from 'hono';
import { createAuthenticatedClient } from '../db/surreal';
import { config } from '../config';
import { logger } from '../utils/logger';

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
 * Paths that are publicly accessible without an Authorization header.
 * Exact match or prefix match (string ending with '/') is used.
 */
const PUBLIC_PATHS: string[] = [
  '/health',
  '/',
];

function isPublicPath(path: string): boolean {
  for (const allowed of PUBLIC_PATHS) {
    if (allowed.endsWith('/')) {
      if (path.startsWith(allowed) || path === allowed.slice(0, -1)) return true;
    } else {
      if (path === allowed) return true;
    }
  }
  return false;
}

/**
 * Validate API key via identity-vessel.
 *
 * Tries the internal cluster URL first, then falls back to the external
 * endpoint (IDENTITY_VESSEL_EXTERNAL_URL) if the primary is unreachable.
 */
async function validateApiKey(apiKey: string): Promise<JwtAuthContext | null> {
  const primaryUrl = config.metabob.identityEndpoint;
  const fallbackUrl =
    process.env.IDENTITY_VESSEL_EXTERNAL_URL || 'https://identity.metabob.com';

  const result = await tryIdentityValidation(apiKey, primaryUrl);
  if (result) return result;

  // If primary failed, try external fallback (only when different)
  if (primaryUrl !== fallbackUrl) {
    logger.info('[ApiKey] Primary identity-vessel unreachable, trying external fallback', {
      primaryUrl,
      fallbackUrl,
    });
    return tryIdentityValidation(apiKey, fallbackUrl);
  }

  return null;
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

  if (!authHeader) {
    if (isPublicPath(c.req.path) || !config.auth.requireAuth) {
      c.set('jwtAuth', null);
      await next();
      return;
    }
    logger.warn('Missing Authorization header on protected path', { path: c.req.path });
    return c.json(
      { error: { code: 'MISSING_AUTH', message: 'Authorization header required' } },
      401,
    );
  }

  // ApiKey branch — validated via identity-vessel
  const apiKeyMatch = authHeader.match(/^ApiKey\s+(.+)$/i);
  if (apiKeyMatch) {
    const apiKey = apiKeyMatch[1];
    logger.debug('Processing ApiKey auth header');

    const jwtAuth = await validateApiKey(apiKey);
    c.set('jwtAuth', jwtAuth);

    if (!jwtAuth && config.auth.requireAuth && !isPublicPath(c.req.path)) {
      logger.warn('ApiKey validation failed on protected path', { path: c.req.path });
      return c.json(
        { error: { code: 'INVALID_AUTH', message: 'API key validation failed' } },
        401,
      );
    }

    await next();
    return;
  }

  // Bearer branch — JWT token validated against SurrealDB
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!bearerMatch) {
    logger.debug('Unrecognized auth header format');
    c.set('jwtAuth', null);
    await next();
    return;
  }

  const token = bearerMatch[1];

  if (!token.includes('.')) {
    c.set('jwtAuth', null);
    await next();
    return;
  }

  const periodCount = (token.match(/\./g) || []).length;
  if (periodCount !== 2) {
    logger.warn('Malformed JWT token structure', { periodCount });
    c.set('jwtAuth', null);
    await next();
    return;
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
      c.set('jwtAuth', null);
      await next();
      return;
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

    c.set('jwtAuth', jwtAuth);

  } catch (error) {
    const err = error as Error;
    logger.debug('JWT authentication failed', { error: err.message });
    c.set('jwtAuth', null);
  }

  await next();
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
