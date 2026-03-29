/**
 * JWT Authentication Middleware for concept-db
 *
 * Detects JWT tokens from Authorization header and extracts claims.
 * JWT tokens contain org_id for multi-tenant isolation.
 */

import { Context, Next } from 'hono';
import { createAuthenticatedClient } from '../db/surreal';
import { logger } from '../utils/logger';

export interface JwtAuthContext {
  jwtToken: string;
  orgId: string;
  projectId?: string;
  projectIds?: string[];
  instanceId?: string;
  role?: string;
}

/**
 * JWT authentication middleware
 */
export async function jwtAuthMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');

  if (!authHeader) {
    c.set('jwtAuth', null);
    await next();
    return;
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    c.set('jwtAuth', null);
    await next();
    return;
  }

  const token = match[1];

  // Detect if this is a JWT token (contains periods)
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
