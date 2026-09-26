/**
 * Usage Resolver
 *
 * Records concept usage in execution traces and updates learning metrics.
 * Implements Bayesian relevance updates.
 */

import { nanoid } from 'nanoid';
import { surrealDB, queryWithAuth } from '../db/surreal';
import { logger } from '../utils/logger';
import { config } from '../config';
import { normalizeConceptId } from '../services/passive-usage';
import type { RecordUsageRequest, ConceptUsage, Outcome } from '../models/schemas';

/**
 * Canonicalise a caller-supplied concept id before SurrealDB lookup.
 * Concept ids are stored as `concept:concept_<nanoid>` records — i.e.
 * the bare id is `concept_<nanoid>`. Callers sometimes strip the
 * `concept_` segment (because the MCP `concept_usage_stats` input
 * schema says "without the 'concept:' prefix" — ambiguous wording).
 * Without normalisation the `type::thing("concept", $id)` lookup
 * builds the wrong record id and rows appear missing. Fall back to
 * the raw input if normalisation returns null so empty strings still
 * surface as 400s rather than as silent prefix injections.
 */
function canonical(id: string): string {
  return normalizeConceptId(id) ?? id;
}

/**
 * Record concept usage in an execution trace
 */
export async function recordUsage(
  request: RecordUsageRequest,
  orgId: string,
  jwtToken?: string
): Promise<ConceptUsage> {
  // Refuse synthetic attribution at the write chokepoint (covers REST route,
  // passive-usage, and impulse callers): unbound {{...}} placeholder trace_ids
  // carry no execution attribution, and usage rows for nonexistent concepts
  // are orphans that silently corrupt aggregate stats.
  const traceIdRaw = String(request.trace_id ?? '');
  if (traceIdRaw.startsWith('{{') && traceIdRaw.endsWith('}}')) {
    throw new Error('unbound template placeholder trace_id — usage row refused (no synthetic credit)');
  }
  const cidCheck = canonical(request.concept_id);
  const exists = jwtToken
    ? await queryWithAuth<{ id: unknown }>(jwtToken, 'SELECT id FROM concept WHERE id = type::thing("concept", $cid) LIMIT 1', { cid: cidCheck })
    : await surrealDB.query<{ id: unknown }>('SELECT id FROM concept WHERE id = type::thing("concept", $cid) LIMIT 1', { cid: cidCheck });
  if (!Array.isArray(exists) || exists.length === 0) {
    throw new Error(`concept not found: ${cidCheck} — usage row refused`);
  }
  const id = `usage_${nanoid(12)}`;

  // Create usage record. activity_id and task_id are declared `option<string>`
  // in the schema (sql/core/001-concept-tables.surql); SurrealDB's option<T>
  // rejects JS null. Build SET dynamically so we only assign the optional
  // fields when the caller actually provided them — absence becomes NONE.
  const setParts = [
    'id = $id',
    'concept_id = type::thing("concept", $concept_id)',
    'trace_id = $trace_id',
    'outcome = $outcome',
    'org_id = $org_id',
  ];
  const params: Record<string, unknown> = {
    id,
    concept_id: canonical(request.concept_id),
    trace_id: request.trace_id,
    outcome: request.outcome,
    org_id: orgId,
  };
  if (request.activity_id) {
    setParts.push('activity_id = $activity_id');
    params.activity_id = request.activity_id;
  }
  if (request.task_id) {
    setParts.push('task_id = $task_id');
    params.task_id = request.task_id;
  }
  const createSql = `CREATE type::thing("concept_usage", $id) SET ${setParts.join(', ')}`;

  const results = jwtToken
    ? await queryWithAuth<ConceptUsage>(jwtToken, createSql, params)
    : await surrealDB.query<ConceptUsage>(createSql, params);

  const usage = results[0];
  if (!usage) {
    throw new Error('Failed to record usage');
  }

  // Update concept learning metrics
  await updateConceptMetrics(canonical(request.concept_id), request.outcome, jwtToken);

  // Forward to activity API for impulse relevance tracking
  await forwardToActivityApi({ ...request, concept_id: canonical(request.concept_id) }, orgId);

  logger.info('Recorded concept usage', {
    concept_id: request.concept_id,
    trace_id: request.trace_id,
    outcome: request.outcome,
  });

  return usage;
}

/**
 * Update concept learning metrics based on usage outcome
 *
 * Uses Bayesian update: relevance = <float>(times_succeeded + 1) / (times_loaded + 2)
 */
// HOT-COUNTER COALESCING. Every usage used to rewrite the whole concept row (~16 KB with
// its HNSW/FTS-indexed fields), and with blob GC off in this SurrealDB every rewrite is
// permanent garbage: measured 2026-09-26, 417 usages over 134 concepts per 10 minutes,
// ~0.8 GB/day of unreclaimed blobs from this one writer. Deltas are summed per concept and
// flushed as ONE update per concept per window, with the same Bayesian relevance formula.
// A crash loses at most one window of counts; relevance stays eventually consistent.
const CONCEPT_METRICS_FLUSH_MS = 60_000;
type PendingConceptMetrics = { succeeded: number; failed: number; loaded: number };
// Keyed by auth token ("" = root connection), then concept id.
const pendingConceptMetrics = new Map<string, Map<string, PendingConceptMetrics>>();
let conceptMetricsFlushTimer: ReturnType<typeof setTimeout> | null = null;

async function updateConceptMetrics(
  conceptId: string,
  outcome: Outcome,
  jwtToken?: string
): Promise<void> {
  const tokenKey = jwtToken ?? "";
  let byConcept = pendingConceptMetrics.get(tokenKey);
  if (!byConcept) {
    byConcept = new Map<string, PendingConceptMetrics>();
    pendingConceptMetrics.set(tokenKey, byConcept);
  }
  const p = byConcept.get(conceptId) ?? { succeeded: 0, failed: 0, loaded: 0 };
  // Bayesian update on relevance assumes times_loaded == times_succeeded + times_failed
  // (+ neutral loads), so every usage counts as a load.
  p.loaded += 1;
  if (outcome === 'success') p.succeeded += 1;
  else if (outcome === 'failure') p.failed += 1;
  byConcept.set(conceptId, p);
  if (!conceptMetricsFlushTimer) {
    conceptMetricsFlushTimer = setTimeout(flushConceptMetricsTick, CONCEPT_METRICS_FLUSH_MS);
  }
}

function flushConceptMetricsTick(): void {
  void flushConceptMetrics();
}

async function flushConceptMetrics(): Promise<void> {
  // The timer that called this has fired; the next usage arms a fresh one.
  conceptMetricsFlushTimer = null;
  const batches = [...pendingConceptMetrics.entries()];
  pendingConceptMetrics.clear();
  const updateSql = `
    UPDATE type::thing("concept", $concept_id) SET
      times_succeeded = times_succeeded + $ds,
      times_failed = times_failed + $df,
      times_loaded = times_loaded + $dl,
      relevance = <float>(times_succeeded + 1) / (times_loaded + 2)
  `;
  for (const [tokenKey, byConcept] of batches) {
    for (const [conceptId, p] of byConcept) {
      const params = { concept_id: conceptId, ds: p.succeeded, df: p.failed, dl: p.loaded };
      try {
        tokenKey
          ? await queryWithAuth(tokenKey, updateSql, params)
          : await surrealDB.query(updateSql, params);
      } catch (err) {
        logger.warn('Concept metrics flush failed', { concept_id: conceptId, error: String(err) });
      }
    }
  }
}

/**
 * Forward usage to activity-api for impulse relevance tracking
 */
async function forwardToActivityApi(
  request: RecordUsageRequest,
  orgId: string
): Promise<void> {
  // Only forward when there is an activity context — the impulse-relevance
  // endpoint requires activity_variant_id and was_loaded/execution_succeeded.
  // Passive search usage (no activity) updates concept metrics locally only.
  if (!request.activity_id) return;

  try {
    const response = await fetch(`${config.activityApi.url}/v2/activities/impulse-relevance`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.metabob.apiKey ? { 'Authorization': `ApiKey ${config.metabob.apiKey}` } : {}),
      },
      body: JSON.stringify({
        impulse_id: `concept:${request.concept_id}`,
        activity_variant_id: request.activity_id,
        task_id: request.task_id,
        execution_id: request.trace_id,
        was_loaded: true,
        execution_succeeded: request.outcome !== 'failure',
        pointer_type: 'concept',
      }),
      signal: AbortSignal.timeout(config.activityApi.timeout),
    });

    if (!response.ok) {
      logger.warn('Failed to forward usage to activity API', {
        status: response.status,
        concept_id: request.concept_id,
      });
    }
  } catch (error) {
    // Don't fail the usage recording if activity API is unavailable
    logger.warn('Activity API unavailable for usage forwarding', {
      error: (error as Error).message,
      concept_id: request.concept_id,
    });
  }
}

/**
 * Get usage history for a concept
 */
export async function getUsageHistory(
  conceptId: string,
  limit: number = 100,
  jwtToken?: string
): Promise<ConceptUsage[]> {
  const sql = `
    SELECT * FROM concept_usage
    WHERE concept_id = type::thing("concept", $concept_id)
    ORDER BY recorded_at DESC
    LIMIT $limit
  `;

  const normalized = canonical(conceptId);
  return jwtToken
    ? await queryWithAuth<ConceptUsage>(jwtToken, sql, { concept_id: normalized, limit })
    : await surrealDB.query<ConceptUsage>(sql, { concept_id: normalized, limit });
}

/**
 * Get aggregated usage stats for a concept
 */
export async function getUsageStats(
  conceptId: string,
  jwtToken?: string
): Promise<{
  total_uses: number;
  success_rate: number;
  failure_rate: number;
  neutral_rate: number;
}> {
  const sql = `
    SELECT
      count() as total,
      count(outcome = 'success') as successes,
      count(outcome = 'failure') as failures,
      count(outcome = 'neutral') as neutrals
    FROM concept_usage
    WHERE concept_id = type::thing("concept", $concept_id)
    GROUP ALL
  `;

  const normalized = canonical(conceptId);
  const results = jwtToken
    ? await queryWithAuth<{ total: number; successes: number; failures: number; neutrals: number }>(
        jwtToken, sql, { concept_id: normalized }
      )
    : await surrealDB.query<{ total: number; successes: number; failures: number; neutrals: number }>(
        sql, { concept_id: normalized }
      );

  const stats = results[0] || { total: 0, successes: 0, failures: 0, neutrals: 0 };
  const total = stats.total || 1; // Avoid division by zero

  return {
    total_uses: stats.total,
    success_rate: stats.successes / total,
    failure_rate: stats.failures / total,
    neutral_rate: stats.neutrals / total,
  };
}
