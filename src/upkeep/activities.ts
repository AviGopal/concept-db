/**
 * Upkeep Activities
 *
 * Autonomous activities that maintain concept health.
 * These are subject to Thompson Sampling and create traces.
 */

import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';
import { createEdge, deleteEdge } from '../resolvers/edge';
import { updateConcept } from '../resolvers/concept';
import type { Concept, ConceptEdge } from '../models/schemas';

export interface UpkeepActivity {
  id: string;
  name: string;
  description: string;
  // Query to find candidates for this activity
  candidateQuery: string;
  // Execute the activity on a candidate
  execute: (candidate: unknown, orgId: string) => Promise<UpkeepResult>;
  // Thompson Sampling parameters
  alpha: number;  // Success count + 1
  beta: number;   // Failure count + 1
}

export interface UpkeepResult {
  success: boolean;
  message: string;
  changes?: {
    type: 'created' | 'updated' | 'deleted';
    entity: string;
    id: string;
  }[];
}

/**
 * Split long concepts into children
 * Trigger: token_estimate > budget * 1.5
 */
const splitLongConcept: UpkeepActivity = {
  id: 'split-long-concept',
  name: 'Split Long Concept',
  description: 'Split concepts that exceed their token budget into smaller derived concepts',
  candidateQuery: `
    SELECT * FROM concept
    WHERE token_estimate > budget * 1.5
    ORDER BY token_estimate DESC
    LIMIT 10
  `,
  alpha: 1,
  beta: 1,
  async execute(candidate: unknown, orgId: string): Promise<UpkeepResult> {
    const concept = candidate as Concept;

    // For now, just reduce the budget and mark as needing manual split
    // A more sophisticated implementation would use an LLM to split
    const newBudget = Math.ceil(concept.budget * 1.5);

    await updateConcept(
      concept.id,
      { budget: newBudget },
      orgId
    );

    logger.info('Adjusted budget for oversized concept', {
      concept_id: concept.id,
      old_budget: concept.budget,
      new_budget: newBudget,
      token_estimate: concept.token_estimate,
    });

    return {
      success: true,
      message: `Adjusted budget from ${concept.budget} to ${newBudget}`,
      changes: [{
        type: 'updated',
        entity: 'concept',
        id: concept.id,
      }],
    };
  },
};

/**
 * Resolve island concepts (no edges)
 * Trigger: Concept has no edges
 */
const resolveIsland: UpkeepActivity = {
  id: 'resolve-island',
  name: 'Resolve Island Concept',
  description: 'Find related concepts for isolated concepts with no edges',
  candidateQuery: `
    SELECT * FROM concept
    WHERE relevance > 0.3
      AND (SELECT count() FROM concept_edge WHERE from_concept = concept.id OR to_concept = concept.id GROUP ALL)[0].count == 0
    ORDER BY created_at DESC
    LIMIT 10
  `,
  alpha: 1,
  beta: 1,
  async execute(candidate: unknown, orgId: string): Promise<UpkeepResult> {
    const concept = candidate as Concept;

    // Search for related concepts
    const searchSql = `
      SELECT *, string::similarity::fuzzy(summary, $summary) AS similarity
      FROM concept
      WHERE id != $concept_id
      ORDER BY similarity DESC
      LIMIT 1
    `;

    const related = await surrealDB.query<Concept & { similarity: number }>(searchSql, {
      concept_id: concept.id,
      summary: concept.summary || '',
    });

    if (related.length === 0 || related[0].similarity < 0.3) {
      return {
        success: false,
        message: 'No related concepts found',
      };
    }

    const relatedConcept = related[0];

    // Create a related_to edge
    const edge = await createEdge(
      {
        from_concept_id: concept.id,
        to_concept_id: relatedConcept.id,
        edge_type: 'related_to',
        description: `Auto-linked by upkeep (similarity: ${relatedConcept.similarity.toFixed(2)})`,
        weight: relatedConcept.similarity,
      },
      orgId
    );

    logger.info('Resolved island concept', {
      concept_id: concept.id,
      linked_to: relatedConcept.id,
      similarity: relatedConcept.similarity,
    });

    return {
      success: true,
      message: `Linked to ${relatedConcept.id} with similarity ${relatedConcept.similarity.toFixed(2)}`,
      changes: [{
        type: 'created',
        entity: 'edge',
        id: edge.id,
      }],
    };
  },
};

/**
 * Adjust priority to match relevance
 * Trigger: |priority - relevance| > 0.3
 */
const adjustPriorityRelevance: UpkeepActivity = {
  id: 'adjust-priority-relevance',
  name: 'Adjust Priority-Relevance',
  description: 'Align priority with relevance when they diverge significantly',
  candidateQuery: `
    SELECT *, math::abs(priority - relevance) AS divergence FROM concept
    WHERE math::abs(priority - relevance) > 0.3
    ORDER BY divergence DESC
    LIMIT 20
  `,
  alpha: 1,
  beta: 1,
  async execute(candidate: unknown, orgId: string): Promise<UpkeepResult> {
    const concept = candidate as Concept;

    // EMA adjustment: new_priority = old_priority * 0.7 + relevance * 0.3
    const newPriority = concept.priority * 0.7 + concept.relevance * 0.3;

    await updateConcept(
      concept.id,
      { priority: newPriority },
      orgId
    );

    logger.info('Adjusted priority to match relevance', {
      concept_id: concept.id,
      old_priority: concept.priority,
      new_priority: newPriority,
      relevance: concept.relevance,
    });

    return {
      success: true,
      message: `Adjusted priority from ${concept.priority.toFixed(2)} to ${newPriority.toFixed(2)}`,
      changes: [{
        type: 'updated',
        entity: 'concept',
        id: concept.id,
      }],
    };
  },
};

/**
 * Prune weak edges from highly relevant concepts
 * Trigger: High relevance concept + low relevance neighbor + low weight edge
 */
const pruneIrrelevantNeighbors: UpkeepActivity = {
  id: 'prune-irrelevant-neighbors',
  name: 'Prune Irrelevant Neighbors',
  description: 'Remove weak edges connecting high-relevance concepts to low-relevance ones',
  candidateQuery: `
    SELECT *,
      from_concept.relevance AS from_relevance,
      to_concept.relevance AS to_relevance
    FROM concept_edge
    WHERE from_concept.relevance > 0.7
      AND to_concept.relevance < 0.3
      AND weight < 0.3
      AND edge_type = 'related_to'
    LIMIT 10
  `,
  alpha: 1,
  beta: 1,
  async execute(candidate: unknown, _orgId: string): Promise<UpkeepResult> {
    const edge = candidate as ConceptEdge & { from_relevance: number; to_relevance: number };

    await deleteEdge(edge.id);

    logger.info('Pruned weak edge', {
      edge_id: edge.id,
      from_relevance: edge.from_relevance,
      to_relevance: edge.to_relevance,
      weight: edge.weight,
    });

    return {
      success: true,
      message: `Pruned edge with weight ${edge.weight.toFixed(2)}`,
      changes: [{
        type: 'deleted',
        entity: 'edge',
        id: edge.id,
      }],
    };
  },
};

/**
 * Decay rarely used concept relevance
 * Trigger: times_loaded > 10 AND relevance > 0.5 AND no usage in last 7 days
 */
const decayStaleRelevance: UpkeepActivity = {
  id: 'decay-stale-relevance',
  name: 'Decay Stale Relevance',
  description: 'Gradually reduce relevance of concepts that are loaded but rarely succeed',
  candidateQuery: `
    SELECT * FROM concept
    WHERE times_loaded > 10
      AND relevance > 0.5
      AND (times_succeeded / times_loaded) < 0.3
    ORDER BY relevance DESC
    LIMIT 10
  `,
  alpha: 1,
  beta: 1,
  async execute(candidate: unknown, orgId: string): Promise<UpkeepResult> {
    const concept = candidate as Concept;

    // Decay relevance by 10%
    const newRelevance = concept.relevance * 0.9;

    await updateConcept(
      concept.id,
      { relevance: newRelevance },
      orgId
    );

    logger.info('Decayed stale relevance', {
      concept_id: concept.id,
      old_relevance: concept.relevance,
      new_relevance: newRelevance,
      success_rate: concept.times_succeeded / concept.times_loaded,
    });

    return {
      success: true,
      message: `Decayed relevance from ${concept.relevance.toFixed(2)} to ${newRelevance.toFixed(2)}`,
      changes: [{
        type: 'updated',
        entity: 'concept',
        id: concept.id,
      }],
    };
  },
};

/**
 * All upkeep activities
 */
export const upkeepActivities: UpkeepActivity[] = [
  splitLongConcept,
  resolveIsland,
  adjustPriorityRelevance,
  pruneIrrelevantNeighbors,
  decayStaleRelevance,
];

/**
 * Get activity by ID
 */
export function getUpkeepActivity(id: string): UpkeepActivity | undefined {
  return upkeepActivities.find(a => a.id === id);
}
