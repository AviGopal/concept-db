/**
 * Impulse table tests
 *
 * Exercises the new `impulse` table resolvers (createImpulse, getImpulseById,
 * expireImpulse, pruneExpiredImpulses) and their lifecycle event emissions
 * against a mocked SurrealDB. Also covers the persist-vs-ephemeral seam.
 */

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  spyOn,
} from 'bun:test';
import { surrealDB } from '../src/db/surreal';
import {
  createImpulse,
  getImpulseById,
  expireImpulse,
  pruneExpiredImpulses,
  writeImpulseToTable,
} from '../src/resolvers/impulse';
import {
  lifecycleDispatcher,
  type LifecycleEvent,
  type LifecyclePayload,
} from '../src/lifecycle/dispatcher';
import { ImpulseSchema } from '../src/models/schemas';

interface ImpulseRow {
  id: string;
  pointer: Record<string, unknown>;
  shape: string;
  summary: string | null;
  content: string | null;
  metadata: Record<string, unknown> | null;
  org_id: string;
  project_id: string | null;
  created_at: string;
  created_by_activity_id: string | null;
  created_by_resolver_id: string | null;
  expires_at: string | null;
}

type QueryArgs = [sql: string, params?: Record<string, unknown>];

function installImpulseSpy(rows: ImpulseRow[]) {
  return spyOn(surrealDB, 'query').mockImplementation(
    async (...args: QueryArgs) => {
      const sql = args[0];
      const params = args[1] || {};

      // CREATE
      if (/^\s*INSERT\s+INTO\s+impulse\s*\{/i.test(sql)) {
        const row: ImpulseRow = {
          id: params.id as string,
          pointer: params.pointer as Record<string, unknown>,
          shape: params.shape as string,
          summary: (params.summary ?? null) as string | null,
          content: (params.content ?? null) as string | null,
          metadata: (params.metadata ?? null) as Record<string, unknown> | null,
          org_id: params.org_id as string,
          project_id: (params.project_id ?? null) as string | null,
          created_at: new Date().toISOString(),
          created_by_activity_id: (params.created_by_activity_id ?? null) as string | null,
          created_by_resolver_id: (params.created_by_resolver_id ?? null) as string | null,
          expires_at: (params.expires_at ?? null) as string | null,
        };
        rows.push(row);
        return [row as never];
      }

      // SELECT by id (org-scoped)
      if (/^\s*SELECT\s+\*\s+FROM\s+type::thing\("impulse"/i.test(sql)) {
        const id = params.id as string;
        const orgId = params.org_id as string;
        const match = rows.find((r) => r.id === id && r.org_id === orgId);
        return match ? [match as never] : [];
      }

      // UPDATE — expireImpulse
      if (
        /^\s*UPDATE\s+type::thing\("impulse"/i.test(sql) &&
        /expires_at\s*=\s*time::now\(\)/i.test(sql)
      ) {
        const id = params.id as string;
        const orgId = params.org_id as string;
        const row = rows.find((r) => r.id === id && r.org_id === orgId);
        if (!row) return [];
        row.expires_at = new Date().toISOString();
        return [row as never];
      }

      // SELECT for prune (expires_at < now())
      if (
        /SELECT\s+\*\s+FROM\s+impulse/i.test(sql) &&
        /expires_at/i.test(sql)
      ) {
        const orgId = params.org_id as string;
        const limit = (params.limit as number) ?? 100;
        const now = Date.now();
        const expired = rows.filter(
          (r) =>
            r.org_id === orgId &&
            r.expires_at !== null &&
            new Date(r.expires_at).getTime() < now,
        );
        return expired.slice(0, limit) as never[];
      }

      // DELETE for prune
      if (/^\s*DELETE\s+FROM\s+impulse/i.test(sql)) {
        const orgId = params.org_id as string;
        const ids = params.ids as string[];
        for (const id of ids) {
          const idx = rows.findIndex((r) => r.id === id && r.org_id === orgId);
          if (idx >= 0) rows.splice(idx, 1);
        }
        return [];
      }

      throw new Error(`Unexpected SQL in impulse-table test: ${sql}`);
    },
  );
}

describe('impulse table — CRUD round-trip', () => {
  let rows: ImpulseRow[];
  let spy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    rows = [];
    spy = installImpulseSpy(rows);
  });

  afterEach(() => {
    spy.mockRestore();
    lifecycleDispatcher.clear();
  });

  test('createImpulse persists a row and emits impulse:created', async () => {
    const events: { event: LifecycleEvent; payload: LifecyclePayload }[] = [];
    lifecycleDispatcher.on('impulse:created', async (payload) => {
      events.push({ event: 'impulse:created', payload });
    });

    const created = await createImpulse(
      {
        shape: 'conceptUpkeepAuditLog',
        pointer: { operation: 'create', target_table: 'concept' },
        summary: 'test audit log',
      },
      'org_a',
    );

    expect(created.id).toMatch(/^impulse_/);
    expect(created.shape).toBe('conceptUpkeepAuditLog');
    expect(created.org_id).toBe('org_a');
    expect(created.expires_at).toBeNull();
    expect(rows.length).toBe(1);

    // Schema check
    expect(() => ImpulseSchema.parse(created)).not.toThrow();

    // Event fired with persisted=true
    // Allow the async handler to run before asserting
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.length).toBe(1);
    expect((events[0].payload as { persisted?: boolean }).persisted).toBe(true);
  });

  test('getImpulseById fetches by id, scoped to org, emits impulse:resolved', async () => {
    const events: LifecycleEvent[] = [];
    lifecycleDispatcher.on('impulse:resolved', async () => {
      events.push('impulse:resolved');
    });

    const created = await createImpulse(
      { shape: 's', pointer: { x: 1 } },
      'org_a',
    );

    const fetched = await getImpulseById(created.id, 'org_a');
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);

    // Wrong org → null, no resolved event
    const wrongOrg = await getImpulseById(created.id, 'org_b');
    expect(wrongOrg).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.length).toBe(1); // Only the org_a fetch emitted
  });

  test('expireImpulse soft-expires (sets expires_at, does not delete)', async () => {
    const created = await createImpulse(
      { shape: 's', pointer: {} },
      'org_a',
    );
    expect(created.expires_at).toBeNull();

    const expired = await expireImpulse(created.id, 'org_a');
    expect(expired).not.toBeNull();
    expect(expired!.expires_at).not.toBeNull();
    // Row still in mock storage
    expect(rows.length).toBe(1);
  });

  test('pruneExpiredImpulses deletes past-due rows and emits impulse:expired', async () => {
    const events: { id: string }[] = [];
    lifecycleDispatcher.on('impulse:expired', async (payload) => {
      const imp = payload.impulse as { id: string };
      events.push({ id: imp.id });
    });

    // 1 expired (yesterday), 1 future, 1 NULL (persistent)
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const expired1 = await createImpulse(
      { shape: 's', pointer: {}, expires_at: past },
      'org_a',
    );
    await createImpulse(
      { shape: 's', pointer: {}, expires_at: future },
      'org_a',
    );
    await createImpulse({ shape: 's', pointer: {} }, 'org_a'); // NULL expiry

    const deleted = await pruneExpiredImpulses('org_a', 100);
    expect(deleted).toBe(1);
    expect(rows.length).toBe(2); // future + persistent remain

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.length).toBe(1);
    expect(events[0].id).toBe(expired1.id);
  });
});

describe('impulse table — multi-tenant isolation', () => {
  let rows: ImpulseRow[];
  let spy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    rows = [];
    spy = installImpulseSpy(rows);
  });

  afterEach(() => {
    spy.mockRestore();
    lifecycleDispatcher.clear();
  });

  test('getImpulseById in wrong org returns null', async () => {
    const created = await createImpulse(
      { shape: 's', pointer: {} },
      'org_a',
    );
    const got = await getImpulseById(created.id, 'org_b');
    expect(got).toBeNull();
  });

  test('pruneExpiredImpulses scopes to the given org', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    await createImpulse({ shape: 's', pointer: {}, expires_at: past }, 'org_a');
    await createImpulse({ shape: 's', pointer: {}, expires_at: past }, 'org_b');

    const deletedA = await pruneExpiredImpulses('org_a', 100);
    expect(deletedA).toBe(1);
    expect(rows.length).toBe(1);
    expect(rows[0].org_id).toBe('org_b');
  });
});

describe('writeImpulseToTable — persist vs ephemeral', () => {
  let rows: ImpulseRow[];
  let spy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    rows = [];
    spy = installImpulseSpy(rows);
  });

  afterEach(() => {
    spy.mockRestore();
    lifecycleDispatcher.clear();
  });

  test('persist=true (default) inserts row and emits impulse:created', async () => {
    const events: { persisted: unknown }[] = [];
    lifecycleDispatcher.on('impulse:created', async (payload) => {
      events.push({ persisted: payload.persisted });
    });

    await writeImpulseToTable({ shape: 's', pointer: {} }, 'org_a');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(rows.length).toBe(1);
    expect(events.length).toBe(1);
    expect(events[0].persisted).toBe(true);
  });

  test('persist=false skips insert but still emits impulse:created', async () => {
    const events: { persisted: unknown; impulseId: string }[] = [];
    lifecycleDispatcher.on('impulse:created', async (payload) => {
      const imp = payload.impulse as { id: string };
      events.push({ persisted: payload.persisted, impulseId: imp.id });
    });

    const ephemeral = await writeImpulseToTable(
      { shape: 's', pointer: {} },
      'org_a',
      { persist: false },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    // SQL was never invoked
    expect(rows.length).toBe(0);
    expect(events.length).toBe(1);
    expect(events[0].persisted).toBe(false);
    expect(events[0].impulseId).toBe(ephemeral.id);
  });
});
