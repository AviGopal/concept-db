-- =============================================================================
-- concept-db: Upkeep Views
-- Computed views for upkeep activity candidate detection
-- =============================================================================

-- -----------------------------------------------------------------------------
-- oversized_concepts view
-- Concepts that exceed their token budget
-- -----------------------------------------------------------------------------
DEFINE FUNCTION fn::oversized_concepts() {
  RETURN SELECT * FROM concept
    WHERE token_estimate > budget * 1.5
    ORDER BY token_estimate DESC
    LIMIT 50;
};

-- -----------------------------------------------------------------------------
-- island_concepts view
-- Concepts with no edges (isolated)
-- -----------------------------------------------------------------------------
DEFINE FUNCTION fn::island_concepts() {
  LET $connected_ids = array::union(
    (SELECT from_concept FROM concept_edge).map(|$x| $x.from_concept),
    (SELECT to_concept FROM concept_edge).map(|$x| $x.to_concept)
  );

  RETURN SELECT * FROM concept
    WHERE id NOT IN $connected_ids
    AND relevance > 0.3
    ORDER BY created_at DESC
    LIMIT 50;
};

-- -----------------------------------------------------------------------------
-- priority_divergent view
-- Concepts where priority and relevance diverge significantly
-- -----------------------------------------------------------------------------
DEFINE FUNCTION fn::priority_divergent() {
  RETURN SELECT * FROM concept
    WHERE math::abs(priority - relevance) > 0.3
    ORDER BY math::abs(priority - relevance) DESC
    LIMIT 50;
};

-- -----------------------------------------------------------------------------
-- weak_edges view
-- Low-weight edges from high-relevance to low-relevance concepts
-- -----------------------------------------------------------------------------
DEFINE FUNCTION fn::weak_edges() {
  RETURN SELECT e.*, c1.relevance AS from_relevance, c2.relevance AS to_relevance
    FROM concept_edge AS e
    JOIN concept AS c1 ON e.from_concept = c1.id
    JOIN concept AS c2 ON e.to_concept = c2.id
    WHERE c1.relevance > 0.7
      AND c2.relevance < 0.3
      AND e.weight < 0.3
      AND e.edge_type = 'related_to'
    LIMIT 50;
};

-- -----------------------------------------------------------------------------
-- stale_concepts view
-- Concepts with high load count but low success rate
-- -----------------------------------------------------------------------------
DEFINE FUNCTION fn::stale_concepts() {
  RETURN SELECT * FROM concept
    WHERE times_loaded > 10
      AND relevance > 0.5
      AND (times_succeeded / times_loaded) < 0.3
    ORDER BY relevance DESC
    LIMIT 50;
};

-- -----------------------------------------------------------------------------
-- upkeep_stats table
-- Tracks upkeep activity execution history
-- -----------------------------------------------------------------------------
DEFINE TABLE upkeep_stats SCHEMAFULL
  PERMISSIONS FOR select, create WHERE org_id = $auth.org_id OR org_id = 'default';

DEFINE FIELD id ON upkeep_stats TYPE string;
DEFINE FIELD activity_id ON upkeep_stats TYPE string;
DEFINE FIELD executed_at ON upkeep_stats TYPE datetime DEFAULT time::now();
DEFINE FIELD success ON upkeep_stats TYPE bool;
DEFINE FIELD candidates_found ON upkeep_stats TYPE int;
DEFINE FIELD candidates_processed ON upkeep_stats TYPE int;
DEFINE FIELD message ON upkeep_stats TYPE option<string>;
DEFINE FIELD org_id ON upkeep_stats TYPE string DEFAULT 'default';

DEFINE INDEX idx_upkeep_activity ON upkeep_stats FIELDS activity_id;
DEFINE INDEX idx_upkeep_time ON upkeep_stats FIELDS executed_at;
