-- =============================================================================
-- concept-db: Impulse table
-- Universal-data outputs of concept-db's resolvers (audit logs, cached query
-- results, write-resolver acks). Concept-db owns its own impulses; this is
-- distinct from activity-api's `impulse` table.
--
-- Per docs/specs/impulse-write-resolver.md → "concept-db gets an `impulse`
-- table". Stores both persistent records (audit logs with `expires_at = NULL`)
-- and ephemeral records (cached results with `expires_at = time::now() + ttl`).
--
-- A periodic cleanup task (in src/upkeep/) deletes rows where
-- `expires_at < time::now()`.
-- =============================================================================

DEFINE TABLE impulse SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id
    FOR create, update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id;

-- Core fields (matching the canonical impulse pattern used elsewhere)
DEFINE FIELD id ON impulse TYPE string;
DEFINE FIELD pointer ON impulse TYPE object;
DEFINE FIELD shape ON impulse TYPE string;
DEFINE FIELD summary ON impulse TYPE option<string>;
DEFINE FIELD content ON impulse TYPE option<string>;
DEFINE FIELD metadata ON impulse TYPE option<object>;

-- Multi-tenant scoping
DEFINE FIELD org_id ON impulse TYPE string;
DEFINE FIELD project_id ON impulse TYPE option<string>;

-- Provenance
DEFINE FIELD created_at ON impulse TYPE datetime DEFAULT time::now();
DEFINE FIELD created_by_activity_id ON impulse TYPE option<string>;
DEFINE FIELD created_by_resolver_id ON impulse TYPE option<string>;

-- TTL marker. NULL = persistent. Cleanup task deletes rows where
-- `expires_at < time::now()`.
DEFINE FIELD expires_at ON impulse TYPE option<datetime>;

-- Indexes
DEFINE INDEX idx_impulse_org ON impulse FIELDS org_id;
DEFINE INDEX idx_impulse_shape ON impulse FIELDS shape;
DEFINE INDEX idx_impulse_created ON impulse FIELDS created_at;
DEFINE INDEX idx_impulse_expires ON impulse FIELDS expires_at;
DEFINE INDEX idx_impulse_activity ON impulse FIELDS created_by_activity_id;
