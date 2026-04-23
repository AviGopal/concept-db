/**
 * Execution Observer Tests
 *
 * Unit tests for:
 *   - Event-handler mapping: task.completed → recordUsage request shape
 *   - Reconnect backoff schedule (exponential, capped)
 *
 * These tests avoid spinning up a real WebSocket or hitting SurrealDB; we
 * inject a mock `recordUsage` and drive the observer through its public API.
 */

import { describe, test, expect, mock } from 'bun:test';
import {
  ExecutionObserver,
  buildUsageRequestsFromTaskCompleted,
  extractConceptRefs,
  type TaskCompletedEvent,
} from '../src/services/execution-observer';
import { config } from '../src/config';

describe('extractConceptRefs', () => {
  test('returns empty array for undefined/invalid input', () => {
    expect(extractConceptRefs(undefined)).toEqual([]);
    expect(extractConceptRefs([])).toEqual([]);
  });

  test('extracts explicit concept_id field', () => {
    const refs = extractConceptRefs([
      { concept_id: 'concept_abc', resolver_id: 'concept-db' },
    ]);
    expect(refs).toEqual(['concept_abc']);
  });

  test('extracts from impulse_id with concept: prefix', () => {
    const refs = extractConceptRefs([
      { impulse_id: 'concept:abc123', shape: 'concept' },
    ]);
    expect(refs).toEqual(['abc123']);
  });

  test('keeps concept_ prefixed impulse ids as-is', () => {
    const refs = extractConceptRefs([
      { impulse_id: 'concept_abc123', shape: 'concept' },
    ]);
    expect(refs).toEqual(['concept_abc123']);
  });

  test('skips non-concept resolutions', () => {
    const refs = extractConceptRefs([
      { impulse_id: 'activityTemplate:xyz', shape: 'activityTemplate' },
      { impulse_id: 'file:/tmp/foo', shape: 'file' },
    ]);
    expect(refs).toEqual([]);
  });

  test('deduplicates repeated concept refs', () => {
    const refs = extractConceptRefs([
      { concept_id: 'concept_abc' },
      { impulse_id: 'concept:concept_abc', shape: 'concept' },
      { concept_id: 'concept_abc' },
    ]);
    expect(refs).toEqual(['concept_abc']);
  });
});

describe('buildUsageRequestsFromTaskCompleted', () => {
  test('returns empty array when no concept refs', () => {
    const event: TaskCompletedEvent = {
      type: 'task.completed',
      data: {
        execution_id: 'exec_1',
        task_id: 'task_1',
        success: true,
      },
    };
    expect(buildUsageRequestsFromTaskCompleted(event)).toEqual([]);
  });

  test('maps success=true to outcome="success"', () => {
    const event: TaskCompletedEvent = {
      type: 'task.completed',
      data: {
        execution_id: 'exec_1',
        task_id: 'task_1',
        success: true,
        activity_id: 'activity_1',
        impulse_resolutions: [{ concept_id: 'concept_abc' }],
      },
    };
    const [req] = buildUsageRequestsFromTaskCompleted(event);
    expect(req).toEqual({
      concept_id: 'concept_abc',
      trace_id: 'exec_1',
      activity_id: 'activity_1',
      task_id: 'task_1',
      outcome: 'success',
    });
  });

  test('maps success=false to outcome="failure"', () => {
    const event: TaskCompletedEvent = {
      type: 'task.completed',
      data: {
        execution_id: 'exec_2',
        task_id: 'task_2',
        success: false,
        impulse_resolutions: [{ concept_id: 'concept_xyz' }],
      },
    };
    const [req] = buildUsageRequestsFromTaskCompleted(event);
    expect(req.outcome).toBe('failure');
    expect(req.trace_id).toBe('exec_2');
    expect(req.task_id).toBe('task_2');
    // activity_id may be absent on broadcaster events.
    expect(req.activity_id).toBeUndefined();
  });

  test('produces one request per distinct concept', () => {
    const event: TaskCompletedEvent = {
      type: 'task.completed',
      data: {
        execution_id: 'exec_3',
        task_id: 'task_3',
        success: true,
        impulse_resolutions: [
          { concept_id: 'concept_a' },
          { concept_id: 'concept_b' },
          { concept_id: 'concept_a' }, // duplicate
          { impulse_id: 'file:/tmp/foo', shape: 'file' }, // irrelevant
        ],
      },
    };
    const requests = buildUsageRequestsFromTaskCompleted(event);
    expect(requests.length).toBe(2);
    expect(requests.map((r) => r.concept_id).sort()).toEqual([
      'concept_a',
      'concept_b',
    ]);
  });
});

describe('ExecutionObserver: recordUsage dispatch', () => {
  test('invokes recordUsage for each concept ref on task.completed', async () => {
    const recordUsage = mock(() => Promise.resolve({}));
    const observer = new ExecutionObserver({
      orgId: 'test-org',
      recordUsage: recordUsage as never,
    });

    const event: TaskCompletedEvent = {
      type: 'task.completed',
      data: {
        execution_id: 'exec_abc',
        task_id: 'task_abc',
        success: true,
        activity_id: 'activity_abc',
        impulse_resolutions: [
          { concept_id: 'concept_1' },
          { concept_id: 'concept_2' },
        ],
      },
    };

    // Reach into the private handler via the public surface: simulate the
    // WS `message` event by calling the private method through a cast.
    // This is the least-ceremony way to exercise dispatch in a unit test.
    await (observer as unknown as {
      handleTaskCompleted(e: TaskCompletedEvent): Promise<void>;
    }).handleTaskCompleted(event);

    expect(recordUsage).toHaveBeenCalledTimes(2);
    const firstCall = recordUsage.mock.calls[0];
    expect(firstCall?.[0]).toMatchObject({
      trace_id: 'exec_abc',
      task_id: 'task_abc',
      activity_id: 'activity_abc',
      outcome: 'success',
    });
    expect(firstCall?.[1]).toBe('test-org');
  });

  test('swallows recordUsage failures without throwing', async () => {
    const recordUsage = mock(() => Promise.reject(new Error('db down')));
    const observer = new ExecutionObserver({
      recordUsage: recordUsage as never,
    });

    const event: TaskCompletedEvent = {
      type: 'task.completed',
      data: {
        execution_id: 'exec_err',
        task_id: 'task_err',
        success: false,
        impulse_resolutions: [{ concept_id: 'concept_x' }],
      },
    };

    await expect(
      (
        observer as unknown as {
          handleTaskCompleted(e: TaskCompletedEvent): Promise<void>;
        }
      ).handleTaskCompleted(event),
    ).resolves.toBeUndefined();

    expect(recordUsage).toHaveBeenCalledTimes(1);
  });
});

describe('ExecutionObserver: reconnect backoff', () => {
  test('getNextBackoffMs doubles up to the cap', () => {
    const observer = new ExecutionObserver();
    observer.resetBackoff();

    const initial = config.observer.reconnectInitialMs;
    const max = config.observer.reconnectMaxMs;

    const schedule: number[] = [];
    // Collect enough iterations to saturate the cap.
    const iterations = Math.ceil(Math.log2(max / initial)) + 3;
    for (let i = 0; i < iterations; i++) {
      schedule.push(observer.getNextBackoffMs());
    }

    // First value is the initial delay.
    expect(schedule[0]).toBe(initial);
    // Schedule is non-decreasing.
    for (let i = 1; i < schedule.length; i++) {
      const prev = schedule[i - 1]!;
      expect(schedule[i]!).toBeGreaterThanOrEqual(prev);
    }
    // Eventually caps at max.
    expect(schedule[schedule.length - 1]).toBe(max);
    // Early values follow the doubling pattern until the cap.
    const second = schedule[1]!;
    expect(second).toBe(Math.min(initial * 2, max));
  });

  test('resetBackoff returns to initial delay', () => {
    const observer = new ExecutionObserver();
    observer.resetBackoff();
    // Advance a few steps.
    observer.getNextBackoffMs();
    observer.getNextBackoffMs();
    observer.getNextBackoffMs();

    observer.resetBackoff();
    expect(observer.getNextBackoffMs()).toBe(config.observer.reconnectInitialMs);
  });
});
