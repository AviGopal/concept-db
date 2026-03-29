/**
 * Lifecycle Event Dispatcher
 *
 * Event emitter for concept lifecycle events.
 * Hooks subscribe to events and execute asynchronously.
 */

import { logger } from '../utils/logger';

export type LifecycleEvent =
  | 'concept:created'
  | 'concept:resolved'
  | 'concept:updated'
  | 'concept:deleted'
  | 'edge:created'
  | 'edge:updated'
  | 'edge:deleted';

export interface LifecyclePayload {
  concept?: unknown;
  edge?: unknown;
  snapshot?: unknown;
  updates?: unknown;
  orgId: string;
  [key: string]: unknown;
}

type LifecycleHandler = (payload: LifecyclePayload) => Promise<void>;

class LifecycleDispatcher {
  private handlers: Map<LifecycleEvent, LifecycleHandler[]> = new Map();

  /**
   * Register a handler for a lifecycle event
   */
  on(event: LifecycleEvent, handler: LifecycleHandler): void {
    const existing = this.handlers.get(event) || [];
    existing.push(handler);
    this.handlers.set(event, existing);
    logger.debug('Registered lifecycle handler', { event, total: existing.length });
  }

  /**
   * Remove a handler for a lifecycle event
   */
  off(event: LifecycleEvent, handler: LifecycleHandler): void {
    const existing = this.handlers.get(event) || [];
    const filtered = existing.filter(h => h !== handler);
    this.handlers.set(event, filtered);
  }

  /**
   * Emit a lifecycle event to all registered handlers
   * Handlers are executed asynchronously and errors are caught
   */
  emit(event: LifecycleEvent, payload: LifecyclePayload): void {
    const handlers = this.handlers.get(event) || [];

    if (handlers.length === 0) {
      logger.debug('No handlers for lifecycle event', { event });
      return;
    }

    logger.debug('Emitting lifecycle event', { event, handler_count: handlers.length });

    // Execute all handlers asynchronously
    for (const handler of handlers) {
      handler(payload).catch(error => {
        logger.error('Lifecycle handler error', {
          event,
          error: (error as Error).message,
        });
      });
    }
  }

  /**
   * Get all registered events
   */
  getRegisteredEvents(): LifecycleEvent[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * Clear all handlers (useful for testing)
   */
  clear(): void {
    this.handlers.clear();
  }
}

// Singleton instance
export const lifecycleDispatcher = new LifecycleDispatcher();
