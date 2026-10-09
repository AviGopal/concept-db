/**
 * Request auth scope for the root database client.
 *
 * A request handler that may reach a writing resolver enters a scope that
 * records whether the caller is authenticated. Inside an unauthenticated
 * scope the root client (`surrealDB.query`) refuses any statement that
 * changes state, so a writing code path that a route-level guard missed
 * still cannot write without an auth context.
 *
 * The scope propagates through awaits, promise chains and timers armed inside
 * it (AsyncLocalStorage), which covers fire-and-forget follow-up writes and
 * lifecycle hooks started by the request. Code that runs outside any request
 * scope (startup, the upkeep scheduler, the execution observer) is not
 * affected.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { logAuthRefused } from '../utils/auth-refusal-log';

export interface RequestAuthScope {
  authenticated: boolean;
  /** For the refusal log line: the request's route, shape and caller hint. */
  route?: string;
  shape?: string;
  callerHint?: string;
}

const storage = new AsyncLocalStorage<RequestAuthScope>();

export function runInRequestAuthScope<T>(
  authenticated: boolean,
  fn: () => T,
  meta: Omit<RequestAuthScope, 'authenticated'> = {},
): T {
  return storage.run({ ...meta, authenticated }, fn);
}

export function currentRequestAuthScope(): RequestAuthScope | undefined {
  return storage.getStore();
}

/** True when the current code runs inside a request scope with no authenticated caller. */
export function inUnauthenticatedRequestScope(): boolean {
  const scope = storage.getStore();
  return scope !== undefined && scope.authenticated === false;
}

// SurrealQL statements that change state. Matched as whole words after quoted
// string literals and comments are removed, so field names such as
// `updated_at` / `created_at` and literal text do not match.
const WRITE_KEYWORDS = /\b(CREATE|UPDATE|UPSERT|INSERT|DELETE|RELATE|DEFINE|REMOVE|ALTER|REBUILD)\b/i;

export function isWriteStatement(sql: string): boolean {
  const stripped = String(sql)
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  return WRITE_KEYWORDS.test(stripped);
}

export class UnauthenticatedWriteError extends Error {
  readonly code = 'AUTH_REQUIRED';
  constructor() {
    super('Authentication required: refusing a state-changing statement without an authenticated caller');
    this.name = 'UnauthenticatedWriteError';
  }
}

/** Throws when a state-changing statement would run on the root client without an auth context. */
export function assertRootWriteAllowed(sql: string): void {
  if (inUnauthenticatedRequestScope() && isWriteStatement(sql)) {
    const scope = storage.getStore();
    logAuthRefused({
      route: scope?.route ?? 'unknown',
      shape: scope?.shape,
      layer: 'root_write',
      reason: 'state-changing statement without an authenticated caller',
      caller_hint: scope?.callerHint ?? 'unknown',
    });
    throw new UnauthenticatedWriteError();
  }
}
