/**
 * A REACHED WALK CREDITS THE CONCEPTS IT RECALLED (B13/B14). concept-db credited a concept only when its id appeared
 * among a completed task's input or output impulse ids (buildUsageRequestsFromTaskCompleted). A walk recalls its
 * lessons through concept search, and nothing linked the recalled ids to the walk's execution, so when the walk
 * reached none of them gained success and when it fell short none gained failure. The concept search now notes
 * what it returned under the walk's execution id (walkRecallLedger), and the observer credits those concepts on the
 * walk's GRADED verdict: reached -> success, not reached -> failure, ungraded -> nothing. The verdict is the event's
 * explicit `reached`, never `success` (exit status).
 * MUST-FAIL at the parent 78b70967: the observer ignores execution_completed, so nothing is recorded.
 */
import { describe, test, expect, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as obs from '../src/services/execution-observer';

type Ledger = { note(id: string, rows: Array<{ id?: unknown; org_id?: unknown }>, org?: string): void; peek(id: string): unknown[] };
const ledger = (obs as unknown as { walkRecallLedger?: Ledger }).walkRecallLedger;
const buildFromVerdict = (obs as unknown as {
  buildUsageRequestsFromWalkVerdict?: (e: unknown, recalled?: string[]) => Array<{ concept_id: string; outcome: string; trace_id: string }>;
}).buildUsageRequestsFromWalkVerdict ?? (() => []); // the parent: a walk verdict credits nothing

function observerWithRecorder() {
  const recordUsage = mock((_req: unknown, _org: string) => Promise.resolve({}));
  const observer = new obs.ExecutionObserver({ orgId: 'observer-org', recordUsage: recordUsage as never });
  const handle = (e: unknown) => (observer as unknown as { handleEvent(e: unknown): Promise<void> }).handleEvent(e);
  return { recordUsage, handle };
}

const verdict = (execution_id: string, extra: Record<string, unknown>) => ({
  type: 'execution_completed',
  data: { execution_id, variant_id: 'v', activity_id: 'walk-activity', success: true, duration_ms: 1, cost: 0, completed_at: 'now', ...extra },
});

describe('a walk verdict credits the concepts the walk recalled', () => {
  test('[MUST-FAIL] a reached walk that recalled X and Y records success usage for X and Y', async () => {
    const { recordUsage, handle } = observerWithRecorder();
    ledger?.note('walk-reached-1', [{ id: 'concept:concept_X', org_id: 'org-a' }, { id: 'concept_Y' }], 'caller-org');
    await handle(verdict('walk-reached-1', { reached: true }));
    expect(recordUsage).toHaveBeenCalledTimes(2);
    const calls = recordUsage.mock.calls.map((c) => [c[0], c[1]]);
    expect(calls).toContainEqual([expect.objectContaining({ concept_id: 'concept_X', trace_id: 'walk-reached-1', outcome: 'success' }), 'org-a']);
    expect(calls).toContainEqual([expect.objectContaining({ concept_id: 'concept_Y', trace_id: 'walk-reached-1', outcome: 'success' }), 'caller-org']);
  });

  test('[MUST-FAIL] a graded walk that did not reach records failure for what it recalled', async () => {
    const { recordUsage, handle } = observerWithRecorder();
    ledger?.note('walk-short-1', [{ id: 'concept_Z' }], 'caller-org');
    await handle(verdict('walk-short-1', { reached: false, success: true }));
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage.mock.calls[0]?.[0]).toMatchObject({ concept_id: 'concept_Z', outcome: 'failure' });
  });

  test('[MUST-FAIL] recalled ids carried on the verdict event itself are credited', () => {
    const reqs = buildFromVerdict(verdict('walk-carried-1', { reached: true, recalled_concept_ids: ['concept:concept_A', 'concept_A', 'concept_B'] }));
    expect(reqs.map((r) => r.concept_id).sort()).toEqual(['concept_A', 'concept_B']);
    expect(reqs.every((r) => r.outcome === 'success' && r.trace_id === 'walk-carried-1')).toBe(true);
  });

  test('[MUST-FAIL] the recall survives an ungraded completion and is credited once by the later graded verdict', async () => {
    const { recordUsage, handle } = observerWithRecorder();
    ledger?.note('walk-late-1', [{ id: 'concept_L' }], 'caller-org');
    await handle(verdict('walk-late-1', {}));
    expect(recordUsage).toHaveBeenCalledTimes(0);
    await handle(verdict('walk-late-1', { reached: true }));
    await handle(verdict('walk-late-1', { reached: true })); // a re-delivered verdict credits nothing twice
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage.mock.calls[0]?.[0]).toMatchObject({ concept_id: 'concept_L', outcome: 'success' });
  });

  test('[CONTROL] an ungraded walk (no reach verdict, even with success:true) records nothing', async () => {
    const { recordUsage, handle } = observerWithRecorder();
    ledger?.note('walk-ungraded-1', [{ id: 'concept_U' }], 'caller-org');
    await handle(verdict('walk-ungraded-1', { success: true }));
    await handle(verdict('walk-ungraded-2', { success: false, recalled_concept_ids: ['concept_V'] }));
    expect(recordUsage).toHaveBeenCalledTimes(0);
    expect(buildFromVerdict(verdict('walk-ungraded-2', { recalled_concept_ids: ['concept_V'] }))).toEqual([]);
  });

  test('[CONTROL] a reached walk that recalled nothing records nothing', async () => {
    const { recordUsage, handle } = observerWithRecorder();
    await handle(verdict('walk-norecall-1', { reached: true }));
    expect(recordUsage).toHaveBeenCalledTimes(0);
  });

  test('[MUST-FAIL] the concept search notes its results under the execution id the walk names', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'routes', 'impulses.ts'), 'utf-8');
    expect(src).toContain("import { walkRecallLedger } from '../services/execution-observer';");
    expect(src).toContain('if (walkExecutionId) walkRecallLedger.note(walkExecutionId, results, orgId);');
  });
});
