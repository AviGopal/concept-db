/**
 * Thompson Sampling for Upkeep Activity Selection
 *
 * Uses Beta distribution to balance exploration vs exploitation
 * when selecting which upkeep activity to run.
 */

import rbeta from '@stdlib/random-base-beta';
import { logger } from '../utils/logger';
import type { UpkeepActivity } from './activities';

export interface ActivityStats {
  activityId: string;
  alpha: number;  // Success count + 1
  beta: number;   // Failure count + 1
  sample?: number;
}

/**
 * Sample from Beta distribution
 */
function sampleBeta(alpha: number, beta: number): number {
  return rbeta(alpha, beta);
}

/**
 * Select an activity using Thompson Sampling
 */
export function selectActivity(activities: UpkeepActivity[]): {
  activity: UpkeepActivity;
  stats: ActivityStats[];
} {
  const stats: ActivityStats[] = activities.map(activity => ({
    activityId: activity.id,
    alpha: activity.alpha,
    beta: activity.beta,
    sample: sampleBeta(activity.alpha, activity.beta),
  }));

  // Select activity with highest sample
  stats.sort((a, b) => (b.sample || 0) - (a.sample || 0));
  const selected = stats[0];

  const activity = activities.find(a => a.id === selected.activityId)!;

  logger.debug('Thompson Sampling selection', {
    selected: selected.activityId,
    sample: selected.sample,
    all_samples: stats.map(s => ({ id: s.activityId, sample: s.sample?.toFixed(3) })),
  });

  return { activity, stats };
}

/**
 * Update activity stats based on outcome
 */
export function updateActivityStats(
  activity: UpkeepActivity,
  success: boolean
): void {
  if (success) {
    activity.alpha += 1;
  } else {
    activity.beta += 1;
  }

  logger.debug('Updated activity stats', {
    activity_id: activity.id,
    alpha: activity.alpha,
    beta: activity.beta,
    expected_value: activity.alpha / (activity.alpha + activity.beta),
  });
}

/**
 * Get expected value (mean) for an activity
 */
export function getExpectedValue(activity: UpkeepActivity): number {
  return activity.alpha / (activity.alpha + activity.beta);
}

/**
 * Get confidence interval for an activity
 */
export function getConfidenceInterval(
  activity: UpkeepActivity,
  confidence: number = 0.95
): { lower: number; upper: number } {
  // Approximate using normal distribution for large sample sizes
  const n = activity.alpha + activity.beta - 2;
  const mean = getExpectedValue(activity);
  const variance = (activity.alpha * activity.beta) /
    ((activity.alpha + activity.beta) ** 2 * (activity.alpha + activity.beta + 1));
  const stddev = Math.sqrt(variance);

  // Z-score for 95% confidence
  const z = confidence === 0.95 ? 1.96 : 2.576; // 95% or 99%

  return {
    lower: Math.max(0, mean - z * stddev),
    upper: Math.min(1, mean + z * stddev),
  };
}

/**
 * Reset activity stats (for testing or rebalancing)
 */
export function resetActivityStats(activity: UpkeepActivity): void {
  activity.alpha = 1;
  activity.beta = 1;
}

/**
 * Get summary statistics for all activities
 */
export function getActivitySummary(activities: UpkeepActivity[]): {
  id: string;
  name: string;
  expectedValue: number;
  totalTrials: number;
  confidenceInterval: { lower: number; upper: number };
}[] {
  return activities.map(activity => ({
    id: activity.id,
    name: activity.name,
    expectedValue: getExpectedValue(activity),
    totalTrials: activity.alpha + activity.beta - 2,
    confidenceInterval: getConfidenceInterval(activity),
  }));
}
