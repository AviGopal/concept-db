/**
 * SurrealDB Client for concept-db
 * Manages connection to SurrealDB and provides query interface
 */

import { Surreal } from 'surrealdb';
import { config } from '../config';
import { logger } from '../utils/logger';

// SurrealDB 2.x root signin returns a JWT with a TTL (default 1h). When that
// token expires, subsequent queries fail with either "The token has expired"
// or, after the session is dropped, "IAM error: Not enough permissions" — the
// JS client does NOT automatically re-signin. We detect those errors in
// query() and re-authenticate transparently.
const AUTH_ERROR_FRAGMENTS = [
  'token has expired',
  'IAM error',
  'Not enough permissions',
  'No record was returned',
  'Authentication failed',
];

/**
 * SurrealDB's own words: "Failed to commit transaction due to a read or write conflict.
 * This transaction can be retried". Matched on the stable phrases rather than the whole
 * sentence so wording drift does not silently disable the retry — a guard that stops
 * matching is indistinguishable from no guard, which is how this cost 5,797 lessons.
 */
export function isRetryableConflictError(err: unknown): boolean {
  const m = (err as Error)?.message ?? String(err ?? "");
  return /read or write conflict/i.test(m) || /transaction can be retried/i.test(m);
}

/** Bounded: a conflict clears only if the competing txn commits, so back off, don't spin. */
const CONFLICT_RETRY_ATTEMPTS = 3;
const CONFLICT_RETRY_BASE_MS = 40;

function isAuthExpiryError(err: unknown): boolean {
  const msg = (err as Error | undefined)?.message ?? '';
  return AUTH_ERROR_FRAGMENTS.some((f) => msg.includes(f));
}

// Admission control (2026-07-24): a single embedded RocksDB node has no per-query
// memory cap, so N concurrent heavy queries SUM into RAM and OOM instead of queueing.
// Bounds concurrent in-flight db.query() calls; over the cap, callers await a slot.
class QuerySemaphore {
  private slots: number;
  private waiters: Array<() => void> = [];
  constructor(max: number) { this.slots = max; }
  async acquire(): Promise<void> {
    if (this.slots > 0) { this.slots--; return; }
    await new Promise<void>((resolve) => { this.waiters.push(resolve); });
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next(); else this.slots++;
  }
}
const querySem = new QuerySemaphore(Number(process.env.SURREAL_MAX_CONCURRENT_QUERIES ?? 16));

class SurrealDBClient {
  private db: Surreal | null = null;
  private connecting: Promise<void> | null = null;
  private hasCredentials = false;

  async connect(): Promise<void> {
    if (this.db) {
      return;
    }

    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = (async () => {
      try {
        logger.info('Connecting to SurrealDB', {
          url: config.surrealdb.url,
          namespace: config.surrealdb.namespace,
          database: config.surrealdb.database,
        });

        this.db = new Surreal();
        await this.db.connect(config.surrealdb.url);

        // Only signin if credentials are provided and not explicitly disabled
        // Empty string, 'NONE', or missing = skip auth (for SurrealDB with auth: false)
        this.hasCredentials = !!(config.surrealdb.username &&
                               config.surrealdb.password &&
                               config.surrealdb.username.trim() !== '' &&
                               config.surrealdb.password.trim() !== '' &&
                               config.surrealdb.username.toUpperCase() !== 'NONE' &&
                               config.surrealdb.password.toUpperCase() !== 'NONE');

        if (this.hasCredentials) {
          await this.db.signin({
            username: config.surrealdb.username,
            password: config.surrealdb.password,
          });
          logger.debug('Signed in to SurrealDB with credentials');
        } else {
          logger.info('Connecting to SurrealDB without authentication (auth disabled)');
        }

        await this.db.use({
          namespace: config.surrealdb.namespace,
          database: config.surrealdb.database,
        });

        try {
          await this.db.query('INFO FOR NS');
          logger.info('Connected to SurrealDB successfully', {
            namespace: config.surrealdb.namespace,
            database: config.surrealdb.database,
            verified: true
          });
        } catch (verifyError) {
          const err = verifyError as Error;
          this.db = null;
          throw new Error(
            `Cannot access namespace '${config.surrealdb.namespace}': ${err.message}. ` +
            `Ensure the namespace exists and credentials have appropriate permissions.`
          );
        }
      } catch (error) {
        logger.error('Failed to connect to SurrealDB', { error });
        this.db = null;
        throw error;
      } finally {
        this.connecting = null;
      }
    })();

    return this.connecting;
  }

  /**
   * Re-signin on the existing connection. Used to refresh the root JWT after
   * SurrealDB 2.x token expiry (default 1h). Idempotent; no-op when auth is
   * disabled.
   */
  private async reauthenticate(): Promise<void> {
    if (!this.db || !this.hasCredentials) return;
    await this.db.signin({
      username: config.surrealdb.username,
      password: config.surrealdb.password,
    });
    await this.db.use({
      namespace: config.surrealdb.namespace,
      database: config.surrealdb.database,
    });
    logger.debug('Re-signed in to SurrealDB after token expiry');
  }

  async query<T = unknown>(sql: string, params?: Record<string, unknown>): Promise<T[]> {
    await this.connect();

    if (!this.db) {
      throw new Error('SurrealDB not connected');
    }

    const run = async () => {
      logger.debug('Executing SurrealDB query', { sql, params });
      await querySem.acquire();
      let result;
      try { result = await this.db!.query(sql, params); } finally { querySem.release(); }
      const firstResult = Array.isArray(result) && result.length > 0 ? result[0] : [];
      return firstResult as T[];
    };

    try {
      return await run();
    } catch (error) {
      // SurrealDB 2.x root signin yields a JWT with TTL. On expiry the next
      // query fails with either "token has expired" (token still parseable)
      // or "IAM error: Not enough permissions" (session dropped). Re-signin
      // and retry exactly once before surfacing the error.
      if (isAuthExpiryError(error) && this.hasCredentials) {
        logger.info('SurrealDB auth expired; reauthenticating and retrying once', {
          error: (error as Error).message,
        });
        try {
          await this.reauthenticate();
          return await run();
        } catch (retryError) {
          const rerr = retryError as Error;
          logger.error('SurrealDB query failed after reauthenticate', {
            sql,
            params,
            namespace: config.surrealdb.namespace,
            database: config.surrealdb.database,
            error: rerr.message,
          });
          throw new Error(
            `Query failed in ${config.surrealdb.namespace}.${config.surrealdb.database}: ${rerr.message}`
          );
        }
      }

      // RETRY A CONFLICT THE DATABASE ITSELF CALLS RETRYABLE.
      //
      // SurrealDB returns "Failed to commit transaction due to a read or write conflict.
      // This transaction can be retried" under concurrent writes. Nothing acted on that
      // instruction, so the conflict surfaced to callers as a hard 400 and the write was
      // simply lost.
      //
      // Measured on the live fleet 2026-08-31: six identical concept_create_write POSTs
      // alternated 200/400/200/400/200/400 — a deterministic every-other-write failure, not
      // an occasional blip. Half of all concept writes were being discarded. The visible
      // cost was the compose-lesson corpus: 5,797 classified compose failures since
      // 2026-07-03 produced ONE stored lesson, so the drafter kept re-making mistakes the
      // substrate had already diagnosed and written guidance for.
      //
      // Bounded and backed off, because a conflict resolves only if the competing
      // transaction gets a chance to commit; retrying instantly just re-collides. Reads are
      // safe to retry (idempotent) and so are the CREATE/UPSERT writes here, which carry
      // their own ids — a retry after a genuinely-failed commit cannot double-insert.
      if (isRetryableConflictError(error)) {
        for (let attempt = 1; attempt <= CONFLICT_RETRY_ATTEMPTS; attempt++) {
          await new Promise((r) => setTimeout(r, CONFLICT_RETRY_BASE_MS * attempt));
          try {
            const out = await run();
            logger.info('SurrealDB transaction conflict resolved on retry', { attempt });
            return out;
          } catch (retryError) {
            if (!isRetryableConflictError(retryError) || attempt === CONFLICT_RETRY_ATTEMPTS) {
              const rerr = retryError as Error;
              logger.error('SurrealDB query failed after conflict retries', {
                sql, attempts: attempt, error: rerr.message,
              });
              throw new Error(
                `Query failed in ${config.surrealdb.namespace}.${config.surrealdb.database}: ${rerr.message}`
              );
            }
          }
        }
      }

      const err = error as Error;
      logger.error('SurrealDB query failed', {
        sql,
        params,
        namespace: config.surrealdb.namespace,
        database: config.surrealdb.database,
        error: err.message
      });

      throw new Error(
        `Query failed in ${config.surrealdb.namespace}.${config.surrealdb.database}: ${err.message}`
      );
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
      logger.info('Closed SurrealDB connection');
    }
  }

  async getInstance(): Promise<Surreal> {
    await this.connect();
    if (!this.db) {
      throw new Error('SurrealDB not connected');
    }
    return this.db;
  }
}

export const surrealDB = new SurrealDBClient();

/**
 * Create a request-scoped SurrealDB client authenticated with a JWT token.
 */
export async function createAuthenticatedClient(jwtToken: string): Promise<Surreal> {
  const db = new Surreal();

  try {
    await db.connect(config.surrealdb.url);
    await db.use({
      namespace: config.surrealdb.namespace,
      database: config.surrealdb.database,
    });

    await db.authenticate(jwtToken);
  } catch (e) {
    // connect() succeeds before use()/authenticate() can fail — without this,
    // the underlying socket leaks (never reaches a caller's try/finally).
    try { await db.close(); } catch {}
    throw e;
  }

  return db;
}

/**
 * Execute a query with user-scoped authentication.
 */
export async function queryWithAuth<T = unknown>(
  jwtToken: string,
  sql: string,
  params?: Record<string, unknown>
): Promise<T[]> {
  const db = await createAuthenticatedClient(jwtToken);

  try {
    logger.debug('Executing authenticated query', { sql, params });
    const result = await db.query(sql, params);
    const firstResult = Array.isArray(result) && result.length > 0 ? result[0] : [];
    return firstResult as T[];
  } finally {
    await db.close();
  }
}
