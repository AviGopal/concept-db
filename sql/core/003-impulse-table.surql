-- =============================================================================
-- concept-db: Impulse table (NON-OWNING, shared-DB safe)
--
-- IMPORTANT: concept-db runs against the SHARED activity-system/learning_loop
-- database, where **activity-api owns the `impulse` table** (authoritative
-- definition in activity-api sql/schemas/020-paradigm-core-tables.surql:
-- SCHEMAFULL, org_id/project_id tenant-isolation PERMISSIONS, and every field +
-- index below already present, including `expires_at`).
--
-- A prior version of this file redefined `impulse` as `DEFINE TABLE impulse
-- SCHEMAFULL` (no IF NOT EXISTS). On apply that CLOBBERED activity-api's table
-- definition — stripping its tenant-isolation PERMISSIONS and racing its schema
-- on every concept-db (re)start (a shared-DB schema war + write-amplification).
-- concept-db is a *consumer* of `impulse` (src/resolvers/impulse.ts
-- INSERT/SELECT/DELETE), not its owner.
--
-- Everything here is now `IF NOT EXISTS` so it is purely additive: in the shared
-- deployment activity-api's definition already exists and every statement is a
-- no-op (no clobber, no permission strip, no duplicate-index churn); on a
-- hypothetical standalone concept-db DB it creates a minimal, permissive
-- (SCHEMALESS) table concept-db's resolvers can still use.
-- =============================================================================

DEFINE TABLE IF NOT EXISTS impulse SCHEMALESS
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id
    FOR create, update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id;

-- Core fields (matching the canonical impulse pattern used elsewhere)
DEFINE FIELD IF NOT EXISTS id ON impulse TYPE string;
DEFINE FIELD IF NOT EXISTS pointer ON impulse TYPE object;
DEFINE FIELD IF NOT EXISTS shape ON impulse TYPE string;
DEFINE FIELD IF NOT EXISTS summary ON impulse TYPE option<string>;
DEFINE FIELD IF NOT EXISTS content ON impulse TYPE option<string>;
DEFINE FIELD IF NOT EXISTS metadata ON impulse TYPE option<object>;

-- Multi-tenant scoping
DEFINE FIELD IF NOT EXISTS org_id ON impulse TYPE string;
DEFINE FIELD IF NOT EXISTS project_id ON impulse TYPE option<string>;

-- Provenance
DEFINE FIELD IF NOT EXISTS created_at ON impulse TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS created_by_activity_id ON impulse TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_by_resolver_id ON impulse TYPE option<string>;

-- TTL marker. NULL = persistent. Cleanup task deletes rows where
-- `expires_at < time::now()`.
DEFINE FIELD IF NOT EXISTS expires_at ON impulse TYPE option<datetime>;

-- Indexes (already present on activity-api's authoritative table — IF NOT EXISTS
-- so we never create duplicates that would add write-amplification).
DEFINE INDEX IF NOT EXISTS idx_impulse_org ON impulse FIELDS org_id;
DEFINE INDEX IF NOT EXISTS idx_impulse_shape ON impulse FIELDS shape;
DEFINE INDEX IF NOT EXISTS idx_impulse_created ON impulse FIELDS created_at;
DEFINE INDEX IF NOT EXISTS idx_impulse_expires ON impulse FIELDS expires_at;
DEFINE INDEX IF NOT EXISTS idx_impulse_activity ON impulse FIELDS created_by_activity_id;
