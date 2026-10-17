/**
 * THE SYSTEM ORG: the org that writes the fleet's shared vocabulary (the shape index) and the only writer the shared
 * scope trusts. It is concept-db's OWN key's org AS THE IDENTITY VESSEL VALIDATES IT, resolved at use time (bootstrap
 * identity, not behaviour). It is never a fallback org: an unauthenticated caller is handled as org 'default', which
 * no validated key yields, so no unauthenticated caller can write a row the shared scope trusts.
 * FAIL CLOSED: when the key cannot be validated, there is NO trusted org: searches read the caller's org only and the
 * shape index does not sync (both say so), rather than trusting a guessed org.
 */
import { config } from '../config';
import { logger } from '../utils/logger';

export type ValidateKey = (apiKey: string) => Promise<{ orgId: string } | null>;

/** Orgs a validated key can never be: the unauthenticated fallback and an empty id. */
const NEVER_TRUSTED = new Set(['', 'default']);

let cached: string | null = null;

export async function systemOrgId(validate?: ValidateKey, apiKey: string = config.metabob.apiKey): Promise<string | null> {
  if (cached) return cached;
  if (!apiKey) { logger.warn('[system-org] no own key: the shared scope trusts no org'); return null; }
  const v = validate ?? (await import('../middleware/jwtAuth')).validateApiKey;
  let org: string | null = null;
  try { org = (await v(apiKey))?.orgId ?? null; } catch { org = null; }
  if (!org || NEVER_TRUSTED.has(org)) { logger.warn('[system-org] own key not validated: the shared scope trusts no org', { org_id: org }); return null; }
  cached = org;
  return org;
}

/** test seam */
export function resetSystemOrgCache(): void { cached = null; }
