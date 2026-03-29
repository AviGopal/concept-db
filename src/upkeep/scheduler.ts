/**
 * Upkeep Scheduler
 *
 * Runs upkeep activities on a schedule.
 * Uses Thompson Sampling to select activities and records traces.
 */

import { config } from '../config';
import { logger } from '../utils/logger';
import { surrealDB } from '../db/surreal';
import { upkeepActivities, UpkeepResult } from './activities';
import { selectActivity, updateActivityStats, getActivitySummary } from './thompson';
import { nanoid } from 'nanoid';

interface UpkeepRun {
  id: string;
  activity_id: string;
  activity_name: string;
  started_at: string;
  completed_at?: string;
  success: boolean;
  message: string;
  candidates_found: number;
  candidates_processed: number;
  changes: UpkeepResult['changes'];
}

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

/**
 * Run a single upkeep cycle
 */
export async function runUpkeepCycle(): Promise<UpkeepRun[]> {
  if (isRunning) {
    logger.debug('Upkeep cycle already in progress, skipping');
    return [];
  }

  isRunning = true;
  const runs: UpkeepRun[] = [];

  try {
    logger.info('Starting upkeep cycle');

    // Select activity using Thompson Sampling
    const { activity, stats } = selectActivity(upkeepActivities);

    logger.info('Selected upkeep activity', {
      activity_id: activity.id,
      activity_name: activity.name,
      selection_stats: stats.slice(0, 3).map(s => ({
        id: s.activityId,
        sample: s.sample?.toFixed(3),
      })),
    });

    // Find candidates for this activity
    const candidates = await surrealDB.query<unknown>(activity.candidateQuery);

    if (candidates.length === 0) {
      logger.debug('No candidates for activity', { activity_id: activity.id });
      return runs;
    }

    logger.info('Found upkeep candidates', {
      activity_id: activity.id,
      count: candidates.length,
    });

    // Process candidates up to batch size
    const batch = candidates.slice(0, config.upkeep.batchSize);
    let successCount = 0;
    let failureCount = 0;

    for (const candidate of batch) {
      const runId = `upkeep_${nanoid(8)}`;
      const startedAt = new Date().toISOString();

      try {
        // Execute the activity
        // Use 'default' org for upkeep activities (system-level)
        const result = await activity.execute(candidate, 'default');

        const run: UpkeepRun = {
          id: runId,
          activity_id: activity.id,
          activity_name: activity.name,
          started_at: startedAt,
          completed_at: new Date().toISOString(),
          success: result.success,
          message: result.message,
          candidates_found: candidates.length,
          candidates_processed: 1,
          changes: result.changes,
        };

        runs.push(run);

        if (result.success) {
          successCount++;
        } else {
          failureCount++;
        }

        // Record trace to activity API
        await recordUpkeepTrace(run);

      } catch (error) {
        const err = error as Error;
        logger.error('Upkeep execution failed', {
          activity_id: activity.id,
          error: err.message,
        });
        failureCount++;

        runs.push({
          id: runId,
          activity_id: activity.id,
          activity_name: activity.name,
          started_at: startedAt,
          completed_at: new Date().toISOString(),
          success: false,
          message: err.message,
          candidates_found: candidates.length,
          candidates_processed: 1,
          changes: [],
        });
      }
    }

    // Update Thompson Sampling stats based on overall success rate
    const overallSuccess = successCount > failureCount;
    updateActivityStats(activity, overallSuccess);

    logger.info('Upkeep cycle completed', {
      activity_id: activity.id,
      success_count: successCount,
      failure_count: failureCount,
      overall_success: overallSuccess,
    });

  } catch (error) {
    const err = error as Error;
    logger.error('Upkeep cycle failed', { error: err.message });
  } finally {
    isRunning = false;
  }

  return runs;
}

/**
 * Record upkeep trace to activity API
 */
async function recordUpkeepTrace(run: UpkeepRun): Promise<void> {
  try {
    const response = await fetch(`${config.activityApi.url}/v2/activities/execution-traces`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        trace_id: run.id,
        activity_id: run.activity_id,
        template_id: `upkeep:${run.activity_id}`,
        session_id: 'upkeep-scheduler',
        started_at: run.started_at,
        completed_at: run.completed_at,
        success: run.success,
        error_message: run.success ? null : run.message,
        metadata: {
          type: 'upkeep',
          candidates_found: run.candidates_found,
          candidates_processed: run.candidates_processed,
          changes: run.changes,
        },
      }),
      signal: AbortSignal.timeout(config.activityApi.timeout),
    });

    if (!response.ok) {
      logger.warn('Failed to record upkeep trace', {
        status: response.status,
        run_id: run.id,
      });
    }
  } catch (error) {
    logger.warn('Activity API unavailable for trace recording', {
      error: (error as Error).message,
      run_id: run.id,
    });
  }
}

/**
 * Start the upkeep scheduler
 */
export function startScheduler(): void {
  if (schedulerInterval) {
    logger.warn('Upkeep scheduler already running');
    return;
  }

  if (!config.upkeep.enabled) {
    logger.info('Upkeep scheduler disabled by configuration');
    return;
  }

  logger.info('Starting upkeep scheduler', {
    interval_ms: config.upkeep.intervalMs,
    batch_size: config.upkeep.batchSize,
  });

  // Run immediately on start
  runUpkeepCycle().catch(err => {
    logger.error('Initial upkeep cycle failed', { error: err.message });
  });

  // Schedule periodic runs
  schedulerInterval = setInterval(() => {
    runUpkeepCycle().catch(err => {
      logger.error('Scheduled upkeep cycle failed', { error: err.message });
    });
  }, config.upkeep.intervalMs);
}

/**
 * Stop the upkeep scheduler
 */
export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    logger.info('Upkeep scheduler stopped');
  }
}

/**
 * Get scheduler status
 */
export function getSchedulerStatus(): {
  running: boolean;
  interval_ms: number;
  enabled: boolean;
  is_executing: boolean;
  activity_summary: ReturnType<typeof getActivitySummary>;
} {
  return {
    running: schedulerInterval !== null,
    interval_ms: config.upkeep.intervalMs,
    enabled: config.upkeep.enabled,
    is_executing: isRunning,
    activity_summary: getActivitySummary(upkeepActivities),
  };
}

/**
 * Trigger an upkeep cycle manually
 */
export async function triggerUpkeep(): Promise<UpkeepRun[]> {
  return runUpkeepCycle();
}
