// conceptCreditDecontaminate_write (2026-07-03): deterministic, idempotent repair for
// the credit-inflation defect. Recomputes per-concept usage counters from concept_usage
// rows EXCLUDING synthetic trace_ids (the blanket 'drafter-success-credit' and the
// 'autonomous_backfill_*' cadence ticks), then rewrites times_loaded / times_succeeded /
// times_failed and relevance = (times_succeeded + 1) / (times_loaded + 2).
// dry_run defaults TRUE so the repair is auditable before it mutates.
import { surrealDB } from '../db/surreal';

export interface DecontaminateRequest {
  dry_run?: boolean;
  min_loads?: number;
}

interface ConceptIdRow { id: unknown; times_loaded?: number; times_succeeded?: number }
interface UsageRow { trace_id?: string; outcome?: string }

const SYNTHETIC_EXACT = new Set(['drafter-success-credit']);
const SYNTHETIC_PREFIX = 'autonomous_backfill_';

function bareId(raw: unknown): string {
  return String(raw ?? '').replace(/^concept:/, '').replace(/[⟨⟩]/g, '');
}

export async function decontaminateCredit(request: DecontaminateRequest): Promise<Record<string, unknown>> {
  const dryRun = request.dry_run !== false;
  const minLoads = typeof request.min_loads === 'number' ? request.min_loads : 50;
  const candidates = await surrealDB.query<ConceptIdRow>(
    'SELECT id, times_loaded, times_succeeded FROM concept WHERE times_loaded >= $min LIMIT 500',
    { min: minLoads },
  );
  const repairs: Array<Record<string, unknown>> = [];
  const skipped: Array<Record<string, unknown>> = [];
  for (const row of candidates ?? []) {
    const cid = bareId(row.id);
    if (!cid) continue;
    const usages = await surrealDB.query<UsageRow>(
      'SELECT trace_id, outcome FROM concept_usage WHERE concept_id = type::thing("concept", $cid) LIMIT 100000',
      { cid },
    );
    let loaded = 0; let succeeded = 0; let failed = 0;
    for (const u of usages ?? []) {
      const t = String(u.trace_id ?? '');
      if (SYNTHETIC_EXACT.has(t) || t.startsWith(SYNTHETIC_PREFIX)) continue;
      loaded += 1;
      if (u.outcome === 'success') succeeded += 1;
      else if (u.outcome === 'failure') failed += 1;
    }
    const before = row.times_loaded ?? 0;
    if (loaded === before) continue;
    const relevance = (succeeded + 1) / (loaded + 2);
    if (!dryRun) {
      try {
        await surrealDB.query(
          'UPDATE type::thing("concept", $cid) SET times_loaded = $tl, times_succeeded = $ts, times_failed = $tf, relevance = $rel, created_at = created_at ?? time::now(), updated_at = time::now()',
          { cid, tl: loaded, ts: succeeded, tf: failed, rel: relevance },
        );
      } catch (err) {
        // Legacy rows can fail SCHEMAFULL whole-record revalidation (e.g. out-of-enum
        // source_type). Skip-and-record instead of aborting the whole repair batch.
        skipped.push({ id: cid, error: err instanceof Error ? err.message.slice(0, 160) : String(err) });
        continue;
      }
    }
    repairs.push({ id: cid, loaded_before: before, loaded_after: loaded, succeeded_after: succeeded, relevance_after: relevance });
  }
  return { dry_run: dryRun, min_loads: minLoads, concepts_examined: (candidates ?? []).length, concepts_repaired: repairs.length, update_failed: skipped.length, skipped: skipped.slice(0, 20), repairs: repairs.slice(0, 50) };
}
