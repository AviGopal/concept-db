/**
 * Impulse Resolver
 *
 * Manages concept-db's own `impulse` table. The table stores universal-data
 * outputs of resolvers — audit logs (persistent, `expires_at = NULL`), cached
 * query results (ephemeral, `expires_at = time::now() + ttl`), and ack
 * envelopes from write-shape calls.
 *
 * Per docs/specs/impulse-write-resolver.md: vessels own their data. Concept-db
 * does NOT write into activity-api's `impulse` table; it has its own.
 */

import { nanoid } from 'nanoid';
import { surrealDB, queryWithAuth } from '../db/surreal';
import { logger } from '../utils/logger';
import { lifecycleDispatcher } from '../lifecycle/dispatcher';
import type { CreateImpulseRequest, Impulse } from '../models/schemas';

export interface CreateImpulseOptions {
  jwtToken?: string;
  /**
   * If false, the impulse is NOT persisted to the table — only a
   * `impulse:created` lifecycle event is emitted with the in-memory payload.
   * Useful for read-resolver outputs that callers may opt-in to persist.
   * Default: true.
   *
   * Per the spec: "Implement a writeImpulseToTable(...) helper that takes a
   * persist: boolean flag (default true for write resolvers, false for
   * read-resolver outputs)".
   */
  persist?: boolean;
}

/**
 * Insert a row into the `impulse` table (or, if `opts.persist === false`,
 * just emit `impulse:created` with the in-memory payload).
 *
 * Returns the persisted (or constructed) Impulse.
 */
export async function createImpulse(
  req: CreateImpulseRequest,
  orgId: string,
  opts: CreateImpulseOptions = {},
): Promise<Impulse> {
  const persist = opts.persist !== false; // default: true
  const jwtToken = opts.jwtToken;

  const id = `impulse_${nanoid(12)}`;
  const nowIso = new Date().toISOString();

  const constructed: Impulse = {
    id,
    pointer: req.pointer,
    shape: req.shape,
    summary: req.summary ?? null,
    content: req.content ?? null,
    metadata: req.metadata ?? null,
    org_id: orgId,
    project_id: req.project_id ?? null,
    created_at: nowIso,
    created_by_activity_id: req.created_by_activity_id ?? null,
    created_by_resolver_id: req.created_by_resolver_id ?? null,
    expires_at: req.expires_at ?? null,
  };

  if (!persist) {
    logger.debug('Created ephemeral impulse (not persisted)', {
      id,
      shape: req.shape,
      org_id: orgId,
    });
    lifecycleDispatcher.emit('impulse:created', {
      impulse: constructed,
      orgId,
      persisted: false,
    });
    return constructed;
  }

  const params: Record<string, unknown> = {
    id,
    pointer: req.pointer,
    shape: req.shape,
    summary: req.summary ?? null,
    content: req.content ?? null,
    metadata: req.metadata ?? null,
    org_id: orgId,
    project_id: req.project_id ?? null,
    created_by_activity_id: req.created_by_activity_id ?? null,
    created_by_resolver_id: req.created_by_resolver_id ?? null,
    expires_at: req.expires_at ?? null,
  };

  const sql = `
    INSERT INTO impulse {
      id: type::thing("impulse", $id),
      pointer: $pointer,
      shape: $shape,
      summary: $summary,
      content: $content,
      metadata: $metadata,
      org_id: $org_id,
      project_id: $project_id,
      created_by_activity_id: $created_by_activity_id,
      created_by_resolver_id: $created_by_resolver_id,
      expires_at: $expires_at
    }
  `;

  const results = jwtToken
    ? await queryWithAuth<Impulse>(jwtToken, sql, params)
    : await surrealDB.query<Impulse>(sql, params);

  const created = results[0] ?? constructed;

  logger.info('Created impulse', {
    id,
    shape: req.shape,
    org_id: orgId,
    expires_at: req.expires_at ?? null,
  });

  lifecycleDispatcher.emit('impulse:created', {
    impulse: created,
    orgId,
    persisted: true,
  });

  return created;
}

/**
 * Convenience wrapper. Per the spec recommendation:
 *   - Default persist = true (write resolvers persist their audit/output)
 *   - Read resolvers wanting to cache results pass `persist: true` plus a TTL
 *   - Read resolvers that want pure pass-through pass `persist: false`
 *
 * As of this initial cut, no read resolvers wire this in — it's available for
 * future use (e.g. `impulseCooccurrenceEdges` could cache its output here if
 * a caller opts in).
 */
export async function writeImpulseToTable(
  req: CreateImpulseRequest,
  orgId: string,
  opts: CreateImpulseOptions = {},
): Promise<Impulse> {
  return createImpulse(req, orgId, opts);
}

/**
 * Fetch a single impulse by id, scoped to org. Emits `impulse:resolved` on
 * a successful read.
 */
export async function getImpulseById(
  id: string,
  orgId: string,
  jwtToken?: string,
): Promise<Impulse | null> {
  const sql = `SELECT * FROM type::thing("impulse", $id) WHERE org_id = $org_id`;
  const params = { id, org_id: orgId };

  const results = jwtToken
    ? await queryWithAuth<Impulse>(jwtToken, sql, params)
    : await surrealDB.query<Impulse>(sql, params);

  const impulse = results[0] ?? null;

  if (impulse) {
    lifecycleDispatcher.emit('impulse:resolved', {
      impulse,
      orgId,
    });
  }

  return impulse;
}

/**
 * Soft-expire an impulse by setting `expires_at = now()`. The actual delete
 * is performed by `pruneExpiredImpulses`.
 *
 * Per the spec: "soft-expire by setting expires_at = now() (don't delete; let
 * upkeep prune later)".
 */
export async function expireImpulse(
  id: string,
  orgId: string,
  jwtToken?: string,
): Promise<Impulse | null> {
  const sql = `
    UPDATE type::thing("impulse", $id) SET expires_at = time::now()
    WHERE org_id = $org_id
  `;
  const params = { id, org_id: orgId };

  const results = jwtToken
    ? await queryWithAuth<Impulse>(jwtToken, sql, params)
    : await surrealDB.query<Impulse>(sql, params);

  const updated = results[0] ?? null;

  if (updated) {
    logger.info('Soft-expired impulse', { id, org_id: orgId });
    // Note: `impulse:expired` is fired by pruneExpiredImpulses when the row
    // is actually deleted, not on soft-expiry. The seam is documented in the
    // spec.
  }

  return updated;
}

/**
 * Delete impulse rows whose `expires_at < now()`. Called from upkeep on a
 * schedule. Returns the number of rows deleted.
 *
 * Emits `impulse:expired` per row deleted (so subscribers can react). We
 * fetch first, then delete, so the lifecycle payload carries the impulse.
 */
export async function pruneExpiredImpulses(
  orgId: string,
  batchLimit: number = 100,
  jwtToken?: string,
): Promise<number> {
  const findSql = `
    SELECT * FROM impulse
    WHERE org_id = $org_id
      AND expires_at IS NOT NONE
      AND expires_at < time::now()
    LIMIT $limit
  `;

  const expired = jwtToken
    ? await queryWithAuth<Impulse>(jwtToken, findSql, {
        org_id: orgId,
        limit: batchLimit,
      })
    : await surrealDB.query<Impulse>(findSql, {
        org_id: orgId,
        limit: batchLimit,
      });

  if (expired.length === 0) {
    return 0;
  }

  const ids = expired.map((row) => String(row.id).replace(/^impulse:/, ''));

  const deleteSql = `
    DELETE FROM impulse
    WHERE org_id = $org_id AND id IN $ids
  `;

  jwtToken
    ? await queryWithAuth(jwtToken, deleteSql, { org_id: orgId, ids })
    : await surrealDB.query(deleteSql, { org_id: orgId, ids });

  logger.info('Pruned expired impulses', {
    count: expired.length,
    org_id: orgId,
  });

  for (const impulse of expired) {
    lifecycleDispatcher.emit('impulse:expired', {
      impulse,
      orgId,
    });
  }

  return expired.length;
}
