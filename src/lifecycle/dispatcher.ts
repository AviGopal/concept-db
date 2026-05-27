/**
 * Lifecycle Event Dispatcher
 *
 * Event emitter for concept lifecycle events.
 * Hooks subscribe to events and execute asynchronously.
 */

import { logger } from '../utils/logger';
import { publishConceptEvent } from './bus';

export type LifecycleEvent =
  | 'concept:created'
  | 'concept:resolved'
  | 'concept:updated'
  | 'concept:deleted'
  | 'edge:created'
  | 'edge:updated'
  | 'edge:deleted'
  | 'impulse:created'
  | 'impulse:resolved'
  | 'impulse:expired';

export interface LifecyclePayload {
  concept?: unknown;
  edge?: unknown;
  impulse?: unknown;
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
   * Emit a lifecycle event to all registered handlers AND publish to the
   * substrate event bus (audit iter008 #3 closure / openspec
   * 2026-05-27-neutral-emitter-lifecycle-bus). In-process handlers fire
   * synchronously as before; the bus publish is fire-and-forget.
   *
   * Errors in handlers are caught. Bus publish failures are absorbed by
   * publishConceptEvent (logged once per outage window).
   */
  emit(event: LifecycleEvent, payload: LifecyclePayload): void {
    const handlers = this.handlers.get(event) || [];

    // Bus emit ALWAYS, regardless of whether any in-process handlers are
    // registered. The neutral-emitter principle: emitters broadcast
    // neutrally; consumers register the hooks they need. A substrate
    // subscriber (ribosome, audit, analyzer) may be listening even when
    // no in-process handler is.
    publishConceptEvent(event, payload as Record<string, unknown>);

    if (handlers.length === 0) {
      logger.debug('No in-process handlers for lifecycle event', { event });
      return;
    }

    logger.debug('Emitting lifecycle event to in-process handlers', {
      event,
      handler_count: handlers.length,
    });

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
