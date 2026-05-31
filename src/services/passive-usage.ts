/**
 * Passive usage recording.
 *
 * When a consumer surfaces concepts via a read-only entry point (REST
 * `/concepts/search`, REST `/concepts/:id/neighbors`, MCP `concept_search`,
 * MCP `concept_neighbors`), those results were loaded into the consumer's
 * reasoning context — that is, by definition, a "load" event. Without a
 * usage row, `times_loaded` never increments and the Bayesian relevance
 * update never fires, so the concept graph stays frozen at its prior even
 * after thousands of MCP look-ups.
 *
 * Reads default to outcome=`neutral`. If a downstream activity execution
 * uses the concept and observes an outcome, it can write a `success` /
 * `failure` row via `concept_record_usage` — the two pathways compose.
 *
 * Recording is fire-and-forget: any failure (concept missing locally, DB
 * transient, identity-vessel JWT issue forwarding to activity-api) is
 * logged but never propagated to the read response.
 */

import { nanoid } from 'nanoid';
import { logger } from '../utils/logger';
import { recordUsage } from '../resolvers/usage';
import type { Concept } from '../models/schemas';

/**
 * Strip the SurrealDB `concept:` table prefix and any unicode-bracket
 * wrapping that SurrealDB applies to ids containing non-alphanumeric
 * characters. Returns the bare id (e.g. `concept_xkrH3DvKplQd`) that
 * `concept_usage` rows + `recordUsage` expect, or null if `rawId` is
 * empty or not a string.
 */
export function normalizeConceptId(rawId: unknown): string | null {
  if (typeof rawId !== 'string' || rawId.length === 0) return null;
  const stripped = rawId.replace(/^concept:/, '').replace(/^⟨|⟩$/g, '');
  return stripped.length > 0 ? stripped : null;
}

/**
 * Fire-and-forget passive usage recording for concepts surfaced from a
 * search-style endpoint. Groups all rows from one call under a synthetic
 * `mcp_<source>_<nanoid>` trace id so they can be filtered out of real
 * execution-trace usage in the history view.
 */
export function recordPassiveUsageForResults(
  source: string,
  concepts: Concept[],
  orgId: string,
  jwtToken: string | undefined,
): void {
  if (!Array.isArray(concepts) || concepts.length === 0) return;
  const traceId = `mcp_${source}_${nanoid(8)}`;
  for (const c of concepts) {
    const conceptId = normalizeConceptId((c as { id?: unknown })?.id);
    if (!conceptId) continue;
    void recordUsage(
      {
        concept_id: conceptId,
        trace_id: traceId,
        outcome: 'neutral',
      },
      orgId,
      jwtToken,
    ).catch((error: unknown) => {
      logger.warn('[passive-usage] recordUsage failed', {
        source,
        concept_id: conceptId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
