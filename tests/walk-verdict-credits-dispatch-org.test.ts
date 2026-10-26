/**
 * A WALK VERDICT CREDITS A RECALLED CONCEPT IN ITS OWN ORG, EVEN WHEN NOT LOCALLY LEDGERED. `handleWalkVerdict`
 * credited `orgOf.get(req.concept_id) ?? this.orgId` — `orgOf` comes only from `walkRecallLedger`, which this
 * vessel's own concept search populates, and `this.orgId` defaults to `options.orgId ?? 'system'`
 * (`src/index.ts` constructs `ExecutionObserver` with no `orgId`, so it is always `'system'`). A concept that was
 * recalled elsewhere (named only on the verdict event's `recalled_concept_ids`, never noted into this vessel's
 * ledger) therefore credited in org `'system'`, and `recordUsage` refuses any concept not found in the credited
 * org — "concept not found: <id> — usage row refused". activity-api's `execution_completed` already carries the
 * dispatch's own org as `data.org_id`; the fix reads it as a fallback above `this.orgId`, below the ledger's own
 * (more specific) org when one is known.
 * MUST-FAIL at the parent 2bfd651: an un-ledgered concept credits in 'system' and is refused.
 */
import { describe, test, expect, mock } from 'bun:test';
import { ExecutionObserver, walkRecallLedger } from '../src/services/execution-observer';

function observerWithRecorder() {
  // Mirrors recordUsage's real refusal: a concept only "exists" in the org it actually lives in.
  const existingOrgByConcept: Record<string, string> = { concept_remote: 'organizations:substrate' };
  const recordUsage = mock((req: { concept_id: string }, org: string) => {
    if (existingOrgByConcept[req.concept_id] !== org) {
      return Promise.reject(new Error(`concept not found: ${req.concept_id} — usage row refused`));
    }
    return Promise.resolve({});
  });
  // No orgId passed, matching src/index.ts's real construction — defaults to 'system'.
  const observer = new ExecutionObserver({ recordUsage: recordUsage as never });
  const handle = (e: unknown) => (observer as unknown as { handleEvent(e: unknown): Promise<void> }).handleEvent(e);
  return { recordUsage, handle };
}

const verdict = (execution_id: string, extra: Record<string, unknown>) => ({
  type: 'execution_completed',
  data: { execution_id, activity_id: 'walk-activity', ...extra },
});

describe('a walk verdict credits a recalled concept in the dispatch org, not the vessel default', () => {
  test('[MUST-FAIL] reached:true credits a non-ledgered concept in the event org_id, not system', async () => {
    const { recordUsage, handle } = observerWithRecorder();
    await handle(
      verdict('walk-remote-1', {
        reached: true,
        recalled_concept_ids: ['concept_remote'],
        org_id: 'organizations:substrate',
      }),
    );
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage.mock.calls[0]?.[0]).toMatchObject({ concept_id: 'concept_remote', outcome: 'success' });
    expect(recordUsage.mock.calls[0]?.[1]).toBe('organizations:substrate');
    // The call must not have been rejected: a passing mock resolution here means the row credited, not refused.
    await expect(recordUsage.mock.results[0]?.value).resolves.toEqual({});
  });

  test('[MUST-FAIL] reached:false credits a failure for the same non-ledgered concept', async () => {
    const { recordUsage, handle } = observerWithRecorder();
    await handle(
      verdict('walk-remote-2', {
        reached: false,
        recalled_concept_ids: ['concept_remote'],
        org_id: 'organizations:substrate',
      }),
    );
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage.mock.calls[0]?.[0]).toMatchObject({ concept_id: 'concept_remote', outcome: 'failure' });
    expect(recordUsage.mock.calls[0]?.[1]).toBe('organizations:substrate');
    await expect(recordUsage.mock.results[0]?.value).resolves.toEqual({});
  });

  test('[CONTROL] an unknown concept id is still refused even with an event org_id', async () => {
    const { recordUsage, handle } = observerWithRecorder();
    await handle(
      verdict('walk-unknown-1', {
        reached: true,
        recalled_concept_ids: ['concept_nowhere'],
        org_id: 'organizations:substrate',
      }),
    );
    expect(recordUsage).toHaveBeenCalledTimes(1);
    await expect(recordUsage.mock.results[0]?.value).rejects.toThrow(/usage row refused/);
  });

  test('[CONTROL] a ledgered concept still uses its own ledger org over the event org_id', async () => {
    const { recordUsage, handle } = observerWithRecorder();
    // Note this concept into the shared ledger under a DIFFERENT org than the event carries, then verify the
    // ledger's own org wins (unchanged behavior for the already-working path).
    walkRecallLedger.note('walk-ledgered-1', [{ id: 'concept_remote', org_id: 'org-ledger' }], 'caller-org');
    await handle(verdict('walk-ledgered-1', { reached: true, org_id: 'organizations:substrate' }));
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage.mock.calls[0]?.[1]).toBe('org-ledger');
  });

  test('[CONTROL] an event with no org_id falls back exactly as before (the vessel default)', async () => {
    const { recordUsage, handle } = observerWithRecorder();
    await handle(verdict('walk-noorg-1', { reached: true, recalled_concept_ids: ['concept_remote'] }));
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage.mock.calls[0]?.[1]).toBe('system');
    await expect(recordUsage.mock.results[0]?.value).rejects.toThrow(/usage row refused/);
  });
});
