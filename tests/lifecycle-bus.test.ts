/**
 * Tests for the bus emit path in dispatcher.ts + bus.ts.
 * Closes audit iter008 #3: concept-db internal events should reach the
 * substrate event bus, not just in-process handlers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mapEventTypeToBusForm } from '../src/lifecycle/bus';

describe('mapEventTypeToBusForm', () => {
  it('maps colon-separated names to concept_db.<noun>.<verb>', () => {
    expect(mapEventTypeToBusForm('concept:created')).toBe('concept_db.concept.created');
    expect(mapEventTypeToBusForm('concept:resolved')).toBe('concept_db.concept.resolved');
    expect(mapEventTypeToBusForm('concept:updated')).toBe('concept_db.concept.updated');
    expect(mapEventTypeToBusForm('concept:deleted')).toBe('concept_db.concept.deleted');
    expect(mapEventTypeToBusForm('edge:created')).toBe('concept_db.edge.created');
    expect(mapEventTypeToBusForm('edge:updated')).toBe('concept_db.edge.updated');
    expect(mapEventTypeToBusForm('edge:deleted')).toBe('concept_db.edge.deleted');
    expect(mapEventTypeToBusForm('impulse:created')).toBe('concept_db.impulse.created');
    expect(mapEventTypeToBusForm('impulse:resolved')).toBe('concept_db.impulse.resolved');
    expect(mapEventTypeToBusForm('impulse:expired')).toBe('concept_db.impulse.expired');
  });

  it('returns null for malformed inputs', () => {
    expect(mapEventTypeToBusForm('concept')).toBeNull();
    expect(mapEventTypeToBusForm('a:b:c')).toBeNull();
    expect(mapEventTypeToBusForm(':resolved')).toBeNull();
    expect(mapEventTypeToBusForm('concept:')).toBeNull();
  });
});

describe('LifecycleDispatcher bus emit integration', () => {
  let publishCalls: Array<{ url: string; body: any }> = [];
  let originalFetch: typeof fetch;

  beforeEach(() => {
    publishCalls = [];
    process.env.ACTIVITY_API_URL = 'http://test-bus:8080';
    process.env.METABOB_API_KEY = 'test-key';
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      publishCalls.push({ url: String(url), body });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('dispatcher.emit publishes to bus AND calls in-process handlers', async () => {
    // Use dynamic import so the module re-reads env vars at construction time.
    const dispatcherModule = await import('../src/lifecycle/dispatcher');
    const { lifecycleDispatcher } = dispatcherModule;
    lifecycleDispatcher.clear();

    let inProcessCalled = false;
    lifecycleDispatcher.on('concept:created', async () => { inProcessCalled = true; });

    lifecycleDispatcher.emit('concept:created', {
      orgId: 'test-org',
      concept: { id: 'c1', shape: 'goal' },
    });

    // Allow microtasks to run (fire-and-forget bus emit + in-process handler).
    await new Promise(r => setTimeout(r, 20));

    expect(inProcessCalled).toBe(true);
    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0].url).toBe('http://test-bus:8080/v2/events/publish');
    expect(publishCalls[0].body.type).toBe('concept_db.concept.created');
    expect(publishCalls[0].body.source_vessel_id).toBe(process.env.VESSEL_ID ?? 'concept-db');
    expect(publishCalls[0].body.data.orgId).toBe('test-org');
    expect(publishCalls[0].body.data.original_event_type).toBe('concept:created');

    lifecycleDispatcher.clear();
  });

  it('dispatcher.emit publishes to bus even when no in-process handlers registered', async () => {
    const { lifecycleDispatcher } = await import('../src/lifecycle/dispatcher');
    lifecycleDispatcher.clear();

    lifecycleDispatcher.emit('edge:created', {
      orgId: 'test-org',
      edge: { from: 'c1', to: 'c2' },
    });

    await new Promise(r => setTimeout(r, 20));
    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0].body.type).toBe('concept_db.edge.created');

    lifecycleDispatcher.clear();
  });
});
