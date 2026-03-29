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
import type { RecordUsageRequest, ConceptUsage, Outcome } from '../models/schemas';

/**
 * Record concept usage in an execution trace
 */
export async function recordUsage(
  request: RecordUsageRequest,
  orgId: string,
  jwtToken?: string
): Promise<ConceptUsage> {
  const id = `usage_${nanoid(12)}`;

  // Create usage record
  const createSql = `
    CREATE type::record("concept_usage", $id) SET
      id = $id,
      concept_id = type::record("concept", $concept_id),
      trace_id = $trace_id,
      activity_id = $activity_id,
      task_id = $task_id,
      outcome = $outcome,
      org_id = $org_id
  `;

  const params = {
    id,
    concept_id: request.concept_id,
    trace_id: request.trace_id,
    activity_id: request.activity_id || null,
    task_id: request.task_id || null,
    outcome: request.outcome,
    org_id: orgId,
  };

  const results = jwtToken
    ? await queryWithAuth<ConceptUsage>(jwtToken, createSql, params)
    : await surrealDB.query<ConceptUsage>(createSql, params);

  const usage = results[0];
  if (!usage) {
    throw new Error('Failed to record usage');
  }

  // Update concept learning metrics
  await updateConceptMetrics(request.concept_id, request.outcome, jwtToken);

  // Forward to activity API for impulse relevance tracking
  await forwardToActivityApi(request, orgId);

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
 * Uses Bayesian update: relevance = (times_succeeded + 1) / (times_loaded + 2)
 */
async function updateConceptMetrics(
  conceptId: string,
  outcome: Outcome,
  jwtToken?: string
): Promise<void> {
  let updateSql: string;

  if (outcome === 'success') {
    updateSql = `
      UPDATE type::record("concept", $concept_id) SET
        times_succeeded = times_succeeded + 1,
        relevance = (times_succeeded + 2) / (times_loaded + 2)
    `;
  } else if (outcome === 'failure') {
    updateSql = `
      UPDATE type::record("concept", $concept_id) SET
        times_failed = times_failed + 1,
        relevance = (times_succeeded + 1) / (times_loaded + 2)
    `;
  } else {
    // neutral - no change to success/fail counts, but recalculate relevance
    updateSql = `
      UPDATE type::record("concept", $concept_id) SET
        relevance = (times_succeeded + 1) / (times_loaded + 2)
    `;
  }

  jwtToken
    ? await queryWithAuth(jwtToken, updateSql, { concept_id: conceptId })
    : await surrealDB.query(updateSql, { concept_id: conceptId });
}

/**
 * Forward usage to metabob-activity-api for impulse relevance tracking
 */
async function forwardToActivityApi(
  request: RecordUsageRequest,
  orgId: string
): Promise<void> {
  try {
    const response = await fetch(`${config.activityApi.url}/v2/activities/impulse-relevance`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        impulse_id: `concept:${request.concept_id}`,
        trace_id: request.trace_id,
        activity_id: request.activity_id,
        task_id: request.task_id,
        outcome: request.outcome,
        org_id: orgId,
        source: 'concept-db',
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
    WHERE concept_id = type::record("concept", $concept_id)
    ORDER BY recorded_at DESC
    LIMIT $limit
  `;

  return jwtToken
    ? await queryWithAuth<ConceptUsage>(jwtToken, sql, { concept_id: conceptId, limit })
    : await surrealDB.query<ConceptUsage>(sql, { concept_id: conceptId, limit });
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
    WHERE concept_id = type::record("concept", $concept_id)
    GROUP ALL
  `;

  const results = jwtToken
    ? await queryWithAuth<{ total: number; successes: number; failures: number; neutrals: number }>(
        jwtToken, sql, { concept_id: conceptId }
      )
    : await surrealDB.query<{ total: number; successes: number; failures: number; neutrals: number }>(
        sql, { concept_id: conceptId }
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
