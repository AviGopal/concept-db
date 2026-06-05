/**
 * /v2/impulses/resolve: write shapes
 *
 * Covers dispatch for the five write shapes added per
 * docs/specs/impulse-write-resolver.md:
 *   - concept_create_write
 *   - conceptLink_write
 *   - conceptSignatureUpsert_write
 *   - conceptUsage_write
 *   - conceptSequence_write
 *
 * Asserts:
 *   (a) the underlying mutation happened (row written via mock surrealDB)
 *   (b) a `conceptUpkeepAuditLog` impulse was created
 *   (c) lifecycle events fired
 *   (d) missing required pointer payload → 400
 *   (e) `metadata.shape` ends in `_result`
 */

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  spyOn,
} from 'bun:test';
import { Hono } from 'hono';
import { surrealDB } from '../src/db/surreal';
import { impulses } from '../src/routes/impulses';
import {
  lifecycleDispatcher,
  type LifecycleEvent,
} from '../src/lifecycle/dispatcher';

interface ConceptRow {
  id: string;
  pointer: { type: string; metadata?: Record<string, unknown> };
  shape: string;
  summary: string | null;
  content: string | null;
  source_type: string;
  org_id: string;
  // ... plus the rest, kept loose for tests
  [k: string]: unknown;
}

interface EdgeRow {
  id: string;
  from_concept_id: string;
  to_concept_id: string;
  edge_type: string;
  weight: number;
  times_traversed: number;
  description: string | null;
  org_id: string;
}

interface UsageRow {
  id: string;
  concept_id: string;
  trace_id: string;
  outcome: string;
  org_id: string;
}

interface ImpulseRow {
  id: string;
  shape: string;
  pointer: Record<string, unknown>;
  org_id: string;
}

type QueryArgs = [sql: string, params?: Record<string, unknown>];

interface FakeStore {
  concepts: ConceptRow[];
  edges: EdgeRow[];
  usages: UsageRow[];
  impulses: ImpulseRow[];
  // Sequence edge counts (for sequence_next dispatch)
  sequenceCount: number;
}

function installSpy(store: FakeStore) {
  return spyOn(surrealDB, 'query').mockImplementation(
    async (...args: QueryArgs) => {
      const sql = args[0];
      const params = args[1] || {};

      // ---- concept upserts (used by conceptSignatureUpsert_write) ----
      if (
        /^\s*SELECT\s+id\s+FROM\s+concept\b/i.test(sql) &&
        /source_type\s*=\s*'impulse_signature'/i.test(sql)
      ) {
        const pt = params.pointer_type as string;
        const sh = params.shape as string;
        const org = params.org_id as string;
        const match = store.concepts.find(
          (c) =>
            c.source_type === 'impulse_signature' &&
            c.pointer.type === pt &&
            c.shape === sh &&
            c.org_id === org,
        );
        return match ? [{ id: match.id } as never] : [];
      }

      // ---- concept create (used by concept_create_write & signature upsert) ----
      if (/^\s*CREATE\s+type::thing\("concept"/i.test(sql)) {
        // upsertBySignature embeds source_type as a SQL literal, so derive
        // it from the SQL when params.source_type is missing.
        let sourceType = params.source_type as string | undefined;
        if (!sourceType) {
          const m = sql.match(/source_type\s*=\s*'([^']+)'/);
          if (m) sourceType = m[1];
        }
        const row: ConceptRow = {
          id: params.id as string,
          pointer:
            (params.pointer as { type: string; metadata?: Record<string, unknown> }) ||
            { type: 'memo' },
          shape: params.shape as string,
          summary: (params.summary as string) || null,
          content: (params.content as string) || null,
          source_type: (sourceType || 'unknown') as string,
          org_id: params.org_id as string,
          token_estimate: 0,
          relevance: 0.5,
          priority: 0.5,
          budget: 500,
          scope: 'org',
          public: false,
          times_loaded: 0,
          times_succeeded: 0,
          times_failed: 0,
          resolution_snapshot: null,
        };
        store.concepts.push(row);
        return [row as never];
      }

      // ---- concept by id (auto-search hook does this) ----
      if (/^\s*SELECT\s+\*\s+FROM\s+type::thing\("concept"/i.test(sql)) {
        const id = params.concept_id as string;
        const match = store.concepts.find((c) => c.id === id);
        return match ? [match as never] : [];
      }

      // ---- searchConcepts (auto-search hook fires after concept:created) ----
      if (/^\s*SELECT\s+\*\s+FROM\s+concept\b/i.test(sql)) {
        return [] as never[];
      }

      // ---- edge lookup (upsertEdge) ----
      if (/^\s*SELECT\s+id,\s+weight\s+FROM\s+concept_edge/i.test(sql)) {
        const from = params.from_id as string;
        const to = params.to_id as string;
        const et = params.edge_type as string;
        const match = store.edges.find(
          (e) =>
            e.from_concept_id === from &&
            e.to_concept_id === to &&
            e.edge_type === et,
        );
        return match ? [{ id: match.id, weight: match.weight } as never] : [];
      }

      // ---- edgeExists (count query for sequence) ----
      if (/^\s*SELECT\s+count\(\)\s+as\s+cnt\s+FROM\s+concept_edge/i.test(sql)) {
        const from = params.from_id as string;
        const to = params.to_id as string;
        const et = params.edge_type as string;
        const cnt = store.edges.filter(
          (e) =>
            e.from_concept_id === from &&
            e.to_concept_id === to &&
            e.edge_type === et,
        ).length;
        return [{ cnt } as never];
      }

      // ---- edge create ----
      if (/^\s*INSERT\s+INTO\s+concept_edge\s*\{/i.test(sql)) {
        const row: EdgeRow = {
          id: params.id as string,
          from_concept_id: params.from_concept_id as string,
          to_concept_id: params.to_concept_id as string,
          edge_type: params.edge_type as string,
          weight: Number(params.weight),
          times_traversed: 1,
          description: (params.description ?? null) as string | null,
          org_id: params.org_id as string,
        };
        store.edges.push(row);
        return [row as never];
      }

      // ---- edge update ----
      if (/^\s*UPDATE\s+type::thing\("concept_edge"/i.test(sql)) {
        const id = params.edge_id as string;
        const e = store.edges.find((row) => row.id === id);
        if (e && params.weight !== undefined) e.weight = Number(params.weight);
        if (e) e.times_traversed += 1;
        return e ? [e as never] : [];
      }

      // ---- usage create ----
      if (/^\s*CREATE\s+type::thing\("concept_usage"/i.test(sql)) {
        const row: UsageRow = {
          id: params.id as string,
          concept_id: params.concept_id as string,
          trace_id: params.trace_id as string,
          outcome: params.outcome as string,
          org_id: params.org_id as string,
        };
        store.usages.push(row);
        return [row as never];
      }

      // ---- concept metric updates (Bayesian update inside recordUsage) ----
      if (
        /^\s*UPDATE\s+type::thing\("concept"/i.test(sql) &&
        /(times_succeeded|times_failed|relevance)/i.test(sql)
      ) {
        return [] as never[];
      }

      // ---- impulse table ops (audit log emission) ----
      if (/^\s*INSERT\s+INTO\s+impulse\s*\{/i.test(sql)) {
        const row: ImpulseRow = {
          id: params.id as string,
          shape: params.shape as string,
          pointer: params.pointer as Record<string, unknown>,
          org_id: params.org_id as string,
        };
        store.impulses.push(row);
        return [row as never];
      }

      // Fallback: return empty array (e.g. for sequence-edge weight updates).
      return [] as never[];
    },
  );
}

function makeStore(): FakeStore {
  return {
    concepts: [],
    edges: [],
    usages: [],
    impulses: [],
    sequenceCount: 0,
  };
}

const app = new Hono();
app.route('/v2/impulses', impulses);

// Ensure auto-search hook from registerLifecycleHooks doesn't run during these
// tests (it does HTTP-style searches and ends up firing extra concept fetches
// we'd rather not stub). Tests start from a clean dispatcher.
beforeEach(() => {
  lifecycleDispatcher.clear();
});

afterEach(() => {
  lifecycleDispatcher.clear();
});

// recordUsage forwards to activity-api via fetch(). Stub fetch globally so the
// usage-write test doesn't hang on an unreachable host.
let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('{}', { status: 200 })) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('concept_create_write', () => {
  let store: FakeStore;
  let spy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    store = makeStore();
    spy = installSpy(store);
  });

  afterEach(() => spy.mockRestore());

  test('rejects missing conceptData → 400', async () => {
    const res = await app.request('/v2/impulses/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pointer: { type: 'concept_create_write' } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/conceptData/);
  });

  test('valid payload creates concept + audit impulse + fires lifecycle events', async () => {
    const events: LifecycleEvent[] = [];
    lifecycleDispatcher.on('concept:created', async () => {
      events.push('concept:created');
    });
    lifecycleDispatcher.on('impulse:created', async () => {
      events.push('impulse:created');
    });

    const res = await app.request('/v2/impulses/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pointer: {
          type: 'concept_create_write',
          conceptData: {
            source_type: 'memo',
            content: 'hello world',
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      content: string;
      metadata: { shape: string; auditImpulseId: string | null };
    };
    expect(body.success).toBe(true);
    expect(body.metadata.shape).toBe('concept_create_write_result');

    // (a) underlying mutation happened
    expect(store.concepts.length).toBe(1);
    const created = JSON.parse(body.content) as { id: string; content: string };
    expect(created.id).toBe(store.concepts[0].id);

    // (b) audit impulse was created
    expect(store.impulses.length).toBe(1);
    expect(store.impulses[0].shape).toBe('conceptUpkeepAuditLog');
    expect(body.metadata.auditImpulseId).toBe(store.impulses[0].id);

    // (c) lifecycle events fired
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toContain('concept:created');
    expect(events).toContain('impulse:created');
  });
});

describe('conceptLink_write', () => {
  let store: FakeStore;
  let spy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    store = makeStore();
    spy = installSpy(store);
  });

  afterEach(() => spy.mockRestore());

  test('rejects missing linkData → 400', async () => {
    const res = await app.request('/v2/impulses/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pointer: { type: 'conceptLink_write' } }),
    });
    expect(res.status).toBe(400);
  });

  test('creates an edge, audit impulse, returns _result shape', async () => {
    const res = await app.request('/v2/impulses/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pointer: {
          type: 'conceptLink_write',
          linkData: {
            from_concept_id: 'concept_a',
            to_concept_id: 'concept_b',
            edge_type: 'related_to',
            weight: 0.7,
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      content: string;
      metadata: { shape: string; auditImpulseId: string | null };
    };
    expect(body.metadata.shape).toBe('conceptLink_write_result');
    expect(store.edges.length).toBe(1);
    expect(store.impulses.length).toBe(1);
    expect(store.impulses[0].shape).toBe('conceptUpkeepAuditLog');
    expect(body.metadata.auditImpulseId).toBe(store.impulses[0].id);

    const result = JSON.parse(body.content) as {
      created: boolean;
      new_weight: number;
    };
    expect(result.created).toBe(true);
    expect(result.new_weight).toBe(0.7);
  });
});

describe('conceptSignatureUpsert_write', () => {
  let store: FakeStore;
  let spy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    store = makeStore();
    spy = installSpy(store);
  });

  afterEach(() => spy.mockRestore());

  test('rejects missing pointer_type/shape → 400', async () => {
    const res = await app.request('/v2/impulses/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pointer: { type: 'conceptSignatureUpsert_write' } }),
    });
    expect(res.status).toBe(400);
  });

  test('first call creates, second call is idempotent (created=false, same id)', async () => {
    const body1 = await (
      await app.request('/v2/impulses/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pointer: {
            type: 'conceptSignatureUpsert_write',
            pointer_type: 'file',
            shape: 'file',
          },
        }),
      })
    ).json() as {
      success: boolean;
      content: string;
      metadata: { shape: string; auditImpulseId: string | null };
    };

    expect(body1.metadata.shape).toBe('conceptSignatureUpsert_write_result');
    const r1 = JSON.parse(body1.content) as { id: string; created: boolean };
    expect(r1.created).toBe(true);

    const body2 = await (
      await app.request('/v2/impulses/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pointer: {
            type: 'conceptSignatureUpsert_write',
            pointer_type: 'file',
            shape: 'file',
          },
        }),
      })
    ).json() as { content: string };

    const r2 = JSON.parse(body2.content) as { id: string; created: boolean };
    expect(r2.created).toBe(false);
    expect(r2.id).toBe(r1.id);

    // Both calls emit an audit log
    expect(store.impulses.length).toBe(2);
  });
});

describe('conceptUsage_write', () => {
  let store: FakeStore;
  let spy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    store = makeStore();
    spy = installSpy(store);
  });

  afterEach(() => spy.mockRestore());

  test('rejects missing usageData → 400', async () => {
    const res = await app.request('/v2/impulses/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pointer: { type: 'conceptUsage_write' } }),
    });
    expect(res.status).toBe(400);
  });

  test('creates a usage row + audit impulse', async () => {
    const res = await app.request('/v2/impulses/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pointer: {
          type: 'conceptUsage_write',
          usageData: {
            concept_id: 'concept_xyz',
            trace_id: 'trace_123',
            outcome: 'success',
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      content: string;
      metadata: { shape: string; auditImpulseId: string | null };
    };
    expect(body.metadata.shape).toBe('conceptUsage_write_result');
    expect(store.usages.length).toBe(1);
    expect(store.usages[0].concept_id).toBe('concept_xyz');
    expect(store.impulses.length).toBe(1);
    expect(store.impulses[0].shape).toBe('conceptUpkeepAuditLog');
    expect(body.metadata.auditImpulseId).toBe(store.impulses[0].id);
  });
});

describe('conceptSequence_write', () => {
  let store: FakeStore;
  let spy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    store = makeStore();
    spy = installSpy(store);
  });

  afterEach(() => spy.mockRestore());

  test('rejects missing sequenceData → 400', async () => {
    const res = await app.request('/v2/impulses/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pointer: { type: 'conceptSequence_write' } }),
    });
    expect(res.status).toBe(400);
  });

  test('creates sequence edges + audit impulse', async () => {
    const res = await app.request('/v2/impulses/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pointer: {
          type: 'conceptSequence_write',
          sequenceData: {
            concept_ids: ['concept_a', 'concept_b', 'concept_c'],
            trace_id: 'trace_seq_1',
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      content: string;
      metadata: { shape: string; auditImpulseId: string | null };
    };
    expect(body.metadata.shape).toBe('conceptSequence_write_result');
    // Two sequence edges (a→b, b→c)
    expect(store.edges.length).toBe(2);
    expect(store.edges[0].edge_type).toBe('sequence_next');
    // Audit impulse fired
    expect(store.impulses.length).toBe(1);
    expect(body.metadata.auditImpulseId).toBe(store.impulses[0].id);
  });
});

describe('config.discovery.shapes advertises write shapes', () => {
  test('all five write shapes; conceptUpkeepAuditLog is a side-effect impulse, not advertised', async () => {
    const { config } = await import('../src/config');
    expect(config.discovery.shapes).toContain('concept_create_write');
    expect(config.discovery.shapes).toContain('conceptLink_write');
    expect(config.discovery.shapes).toContain('conceptSignatureUpsert_write');
    expect(config.discovery.shapes).toContain('conceptUsage_write');
    expect(config.discovery.shapes).toContain('conceptSequence_write');
    // conceptUpkeepAuditLog is emitted as a side-effect impulse by write resolvers,
    // not resolved via discovery — so it must NOT appear in the advertised shapes array.
    expect(config.discovery.shapes).not.toContain('conceptUpkeepAuditLog');
  });
});
