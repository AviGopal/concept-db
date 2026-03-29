/**
 * Lifecycle Hooks
 *
 * Hooks that respond to concept lifecycle events.
 * These run asynchronously and should not block the main operation.
 */

import { logger } from '../utils/logger';
import { lifecycleDispatcher, LifecyclePayload } from './dispatcher';
import { searchConcepts } from '../resolvers/concept';
import { createEdge, edgeExists } from '../resolvers/edge';
import type { Concept, ConceptEdge } from '../models/schemas';

/**
 * Auto-search for related concepts when a new concept is created
 * Creates 'related_to' edges to similar concepts
 */
async function autoSearchRelatedConcepts(payload: LifecyclePayload): Promise<void> {
  const concept = payload.concept as Concept;
  const orgId = payload.orgId;

  if (!concept || !concept.summary) {
    return;
  }

  try {
    // Search for concepts with similar content
    const related = await searchConcepts(
      {
        query: concept.summary.slice(0, 100),
        limit: 5,
        offset: 0,
      },
      orgId
    );

    // Create edges to related concepts (excluding self)
    for (const relatedConcept of related) {
      if (relatedConcept.id === concept.id) continue;

      const exists = await edgeExists(concept.id, relatedConcept.id, 'related_to');
      if (!exists) {
        await createEdge(
          {
            from_concept_id: concept.id,
            to_concept_id: relatedConcept.id,
            edge_type: 'related_to',
            description: 'Auto-discovered relationship',
            weight: 0.3, // Low initial weight for auto-discovered
          },
          orgId
        );
      }
    }

    logger.debug('Auto-searched related concepts', {
      concept_id: concept.id,
      related_count: related.length - 1,
    });
  } catch (error) {
    logger.warn('Auto-search for related concepts failed', {
      concept_id: concept.id,
      error: (error as Error).message,
    });
  }
}

/**
 * Invalidate resolution snapshot when concept content changes
 */
async function invalidateSnapshotIfContentChanged(payload: LifecyclePayload): Promise<void> {
  const concept = payload.concept as Concept;
  const updates = payload.updates as Partial<Concept>;

  if (!concept || !updates) {
    return;
  }

  // If content changed, the snapshot is stale
  if (updates.content && concept.resolution_snapshot) {
    logger.info('Resolution snapshot invalidated due to content change', {
      concept_id: concept.id,
    });
    // The snapshot will be refreshed on next resolve
  }
}

/**
 * Propagate relevance changes to neighbors
 * When a concept's relevance changes significantly, adjust neighbor priorities
 */
async function propagateRelevanceToNeighbors(payload: LifecyclePayload): Promise<void> {
  const edge = payload.edge as ConceptEdge;
  const orgId = payload.orgId;

  if (!edge) {
    return;
  }

  // When a new edge is created, slightly boost both concepts' relevance
  // This is a lightweight way to reward connected concepts
  logger.debug('Edge created, relevance propagation triggered', {
    from: edge.from_concept,
    to: edge.to_concept,
    type: edge.edge_type,
  });

  // Full propagation would require querying both concepts and updating them
  // For now, this is a placeholder for the upkeep activity to handle
}

/**
 * Log resolution snapshots for debugging
 */
async function logResolutionSnapshot(payload: LifecyclePayload): Promise<void> {
  const concept = payload.concept as Concept;
  const snapshot = payload.snapshot;

  if (!concept || !snapshot) {
    return;
  }

  logger.debug('Concept resolved with snapshot', {
    concept_id: concept.id,
    shape: concept.shape,
    snapshot,
  });
}

/**
 * Register all lifecycle hooks
 */
export function registerLifecycleHooks(): void {
  // concept:created hooks
  lifecycleDispatcher.on('concept:created', autoSearchRelatedConcepts);

  // concept:resolved hooks
  lifecycleDispatcher.on('concept:resolved', logResolutionSnapshot);

  // concept:updated hooks
  lifecycleDispatcher.on('concept:updated', invalidateSnapshotIfContentChanged);

  // edge:created hooks
  lifecycleDispatcher.on('edge:created', propagateRelevanceToNeighbors);

  logger.info('Lifecycle hooks registered', {
    events: lifecycleDispatcher.getRegisteredEvents(),
  });
}
