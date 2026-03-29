/**
 * Upkeep Tests
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  upkeepActivities,
  getUpkeepActivity,
} from '../src/upkeep/activities';
import {
  selectActivity,
  updateActivityStats,
  getExpectedValue,
  getConfidenceInterval,
  resetActivityStats,
  getActivitySummary,
} from '../src/upkeep/thompson';

describe('Upkeep Activities', () => {
  test('should have all required activities', () => {
    const activityIds = upkeepActivities.map(a => a.id);

    expect(activityIds).toContain('split-long-concept');
    expect(activityIds).toContain('resolve-island');
    expect(activityIds).toContain('adjust-priority-relevance');
    expect(activityIds).toContain('prune-irrelevant-neighbors');
    expect(activityIds).toContain('decay-stale-relevance');
  });

  test('should get activity by id', () => {
    const activity = getUpkeepActivity('split-long-concept');
    expect(activity).toBeDefined();
    expect(activity?.name).toBe('Split Long Concept');
  });

  test('should return undefined for unknown activity', () => {
    const activity = getUpkeepActivity('unknown');
    expect(activity).toBeUndefined();
  });

  test('all activities should have required properties', () => {
    for (const activity of upkeepActivities) {
      expect(activity.id).toBeDefined();
      expect(activity.name).toBeDefined();
      expect(activity.description).toBeDefined();
      expect(activity.candidateQuery).toBeDefined();
      expect(typeof activity.execute).toBe('function');
      expect(activity.alpha).toBeGreaterThanOrEqual(1);
      expect(activity.beta).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('Thompson Sampling', () => {
  beforeEach(() => {
    // Reset all activity stats before each test
    for (const activity of upkeepActivities) {
      resetActivityStats(activity);
    }
  });

  test('should select an activity', () => {
    const { activity, stats } = selectActivity(upkeepActivities);

    expect(activity).toBeDefined();
    expect(activity.id).toBeDefined();
    expect(stats).toBeDefined();
    expect(stats.length).toBe(upkeepActivities.length);
  });

  test('should have sample values for all activities', () => {
    const { stats } = selectActivity(upkeepActivities);

    for (const stat of stats) {
      expect(stat.sample).toBeDefined();
      expect(stat.sample).toBeGreaterThanOrEqual(0);
      expect(stat.sample).toBeLessThanOrEqual(1);
    }
  });

  test('should update stats on success', () => {
    const activity = upkeepActivities[0];
    const initialAlpha = activity.alpha;

    updateActivityStats(activity, true);

    expect(activity.alpha).toBe(initialAlpha + 1);
    expect(activity.beta).toBe(1); // Unchanged
  });

  test('should update stats on failure', () => {
    const activity = upkeepActivities[0];
    const initialBeta = activity.beta;

    updateActivityStats(activity, false);

    expect(activity.alpha).toBe(1); // Unchanged
    expect(activity.beta).toBe(initialBeta + 1);
  });

  test('should calculate expected value', () => {
    const activity = upkeepActivities[0];

    // Initial: alpha=1, beta=1 => E[X] = 1/2 = 0.5
    expect(getExpectedValue(activity)).toBe(0.5);

    // After success: alpha=2, beta=1 => E[X] = 2/3 ≈ 0.667
    updateActivityStats(activity, true);
    expect(getExpectedValue(activity)).toBeCloseTo(0.667, 2);

    // After failure: alpha=2, beta=2 => E[X] = 2/4 = 0.5
    updateActivityStats(activity, false);
    expect(getExpectedValue(activity)).toBe(0.5);
  });

  test('should calculate confidence interval', () => {
    const activity = upkeepActivities[0];

    const ci = getConfidenceInterval(activity);

    expect(ci.lower).toBeGreaterThanOrEqual(0);
    expect(ci.upper).toBeLessThanOrEqual(1);
    expect(ci.lower).toBeLessThan(ci.upper);
  });

  test('should reset activity stats', () => {
    const activity = upkeepActivities[0];

    updateActivityStats(activity, true);
    updateActivityStats(activity, true);
    updateActivityStats(activity, false);

    expect(activity.alpha).toBeGreaterThan(1);

    resetActivityStats(activity);

    expect(activity.alpha).toBe(1);
    expect(activity.beta).toBe(1);
  });

  test('should get activity summary', () => {
    const summary = getActivitySummary(upkeepActivities);

    expect(summary.length).toBe(upkeepActivities.length);

    for (const item of summary) {
      expect(item.id).toBeDefined();
      expect(item.name).toBeDefined();
      expect(item.expectedValue).toBeDefined();
      expect(item.totalTrials).toBeDefined();
      expect(item.confidenceInterval).toBeDefined();
      expect(item.confidenceInterval.lower).toBeDefined();
      expect(item.confidenceInterval.upper).toBeDefined();
    }
  });

  test('should favor successful activities over time', () => {
    const activity1 = upkeepActivities[0];
    const activity2 = upkeepActivities[1];

    // Simulate activity1 being much more successful
    for (let i = 0; i < 10; i++) {
      updateActivityStats(activity1, true);
    }
    for (let i = 0; i < 10; i++) {
      updateActivityStats(activity2, false);
    }

    expect(getExpectedValue(activity1)).toBeGreaterThan(getExpectedValue(activity2));

    // Over many selections, activity1 should be selected more often
    let activity1Count = 0;
    const iterations = 100;

    for (let i = 0; i < iterations; i++) {
      const { activity } = selectActivity([activity1, activity2]);
      if (activity.id === activity1.id) {
        activity1Count++;
      }
    }

    // Activity1 should be selected significantly more often
    expect(activity1Count).toBeGreaterThan(iterations * 0.7);
  });
});

describe('Source Type Mapping', () => {
  test('should infer shape from source types', async () => {
    // Import dynamically to avoid circular dependencies
    const { getShapeForSource, getAvailableSourceTypes } = await import('../src/sources/unified');

    expect(getShapeForSource('goal')).toBe('goal');
    expect(getShapeForSource('memo')).toBe('memo');
    expect(getShapeForSource('human_input')).toBe('user_request');
    expect(getShapeForSource('search')).toBe('search_result');
    expect(getShapeForSource('llm')).toBe('llm_response');
    expect(getShapeForSource('metabob_annotation')).toBe('code_annotation');
    expect(getShapeForSource('write')).toBe('file_content');
    expect(getShapeForSource('read')).toBe('file_content');
    expect(getShapeForSource('cpg_embedding')).toBe('code_pattern');
    expect(getShapeForSource('extracted')).toBe('extracted_data');
  });

  test('should list all available source types', async () => {
    const { getAvailableSourceTypes } = await import('../src/sources/unified');

    const types = getAvailableSourceTypes();

    expect(types).toContain('goal');
    expect(types).toContain('memo');
    expect(types).toContain('human_input');
    expect(types).toContain('search');
    expect(types).toContain('llm');
    expect(types).toContain('metabob_annotation');
    expect(types).toContain('write');
    expect(types).toContain('read');
    expect(types).toContain('cpg_embedding');
    expect(types).toContain('extracted');
  });
});
