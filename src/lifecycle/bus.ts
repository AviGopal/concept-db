/**
 * Substrate event bus publisher for concept-db lifecycle events.
 *
 * Per openspec change 2026-05-27-neutral-emitter-lifecycle-bus and audit
 * iter008 #3 (investigation-026, 2026-05-27T08:50Z): concept-db's internal
 * lifecycle events previously fired only on the in-process EventEmitter
 * (dispatcher.ts), trapping them from any other vessel. This module mirrors
 * the pattern that closed iter008 #4 for ias-executor-ts engine events and
 * for discovery-vessel registration events — publish to activity-api's
 * POST /v2/events/publish so any subscribed vessel (ribosome, audit, future
 * analyzers) can react.
 *
 * Semantics:
 *   - Fire-and-forget. Errors logged once per outage window; in-process
 *     dispatcher mutation always succeeds regardless of bus availability.
 *   - 2-second HTTP timeout.
 *   - Disabled when ACTIVITY_API_ENDPOINT is unset (logs once at module load).
 *
 * Event-name mapping (3-segment form so subscribers can filter trivially):
 *   concept:created   → concept_db.concept.created
 *   concept:resolved  → concept_db.concept.resolved
 *   concept:updated   → concept_db.concept.updated
 *   concept:deleted   → concept_db.concept.deleted
 *   edge:created      → concept_db.edge.created
 *   edge:updated      → concept_db.edge.updated
 *   edge:deleted      → concept_db.edge.deleted
 *   impulse:created   → concept_db.impulse.created
 *   impulse:resolved  → concept_db.impulse.resolved
 *   impulse:expired   → concept_db.impulse.expired
 */

import { logger } from '../utils/logger';

// Resolved on each call so tests can override env vars at runtime. The cost
// of re-reading process.env is negligible (microseconds) compared to the
// fire-and-forget HTTP publish.
function busConfig(): {
  endpoint: string;
  apiKey: string;
  sourceVesselId: string;
} {
  return {
    endpoint: process.env.ACTIVITY_API_ENDPOINT
      ?? process.env.ACTIVITY_API_URL
      ?? '',
    apiKey: process.env.METABOB_API_KEY ?? '',
    sourceVesselId: process.env.VESSEL_ID ?? 'concept-db',
  };
}

let outageLogged = false;

/**
 * Map an in-process lifecycle event name (`<noun>:<verb>`) to its substrate
 * bus form (`concept_db.<noun>.<verb>`). Returns null if the input doesn't
 * match the expected colon-separated form.
 */
export function mapEventTypeToBusForm(eventType: string): string | null {
  const parts = eventType.split(':');
  if (parts.length !== 2) return null;
  const [noun, verb] = parts;
  if (!noun || !verb) return null;
  return `concept_db.${noun}.${verb}`;
}

/**
 * Fire-and-forget publish to the substrate bus. Never throws.
 */
export function publishConceptEvent(
  eventType: string,
  data: Record<string, unknown>,
): void {
  const cfg = busConfig();
  if (!cfg.endpoint) return;

  const busType = mapEventTypeToBusForm(eventType);
  if (!busType) {
    if (!outageLogged) {
      logger.warn('[concept-db] cannot map event type to bus form', { eventType });
      outageLogged = true;
    }
    return;
  }

  void (async () => {
    try {
      const res = await fetch(`${cfg.endpoint}/v2/events/publish`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.apiKey ? { Authorization: `ApiKey ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({
          type: busType,
          source_vessel_id: cfg.sourceVesselId,
          data: {
            ...data,
            original_event_type: eventType,
          },
        }),
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) {
        if (!outageLogged) {
          logger.warn(
            `[concept-db] event bus publish HTTP ${res.status} for ${busType} (suppressing further logs)`,
          );
          outageLogged = true;
        }
      } else if (outageLogged) {
        logger.info('[concept-db] event bus recovered');
        outageLogged = false;
      }
    } catch (err) {
      if (!outageLogged) {
        logger.warn(
          `[concept-db] event bus publish failed for ${busType}: ${(err as Error).message} ` +
            '(suppressing further logs)',
        );
        outageLogged = true;
      }
    }
  })();
}
