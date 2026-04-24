/**
 * /v2/impulses/resolve: new shapes
 *
 * Covers dispatch for:
 *   - impulseSignatureConcept
 *   - impulseCooccurrenceEdges
 *
 * Uses an in-memory surrealDB.query spy to stand in for the DB so we can
 * focus on routing, validation, and response shape.
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
import { config } from '../src/config';

interface ConceptRow {
  id: string;
  pointer: { type: string; metadata?: Record<string, unknown> };
  shape: string;
  summary: string | null;
  content: string | null;
  source_type: string;
  token_estimate: number | null;
  relevance: number;
  budget: number;
  scope: string;
  org_id: string;
  priority: number;
  times_loaded: number;
  times_succeeded: number;
  times_failed: number;
  public: boolean;
  resolution_snapshot: null;
}

type QueryArgs = [sql: string, params?: Record<string, unknown>];

function makeConcept(id: string, pointerType: string, shape: string, orgId: string): ConceptRow {
  return {
    id,
    pointer: { type: pointerType, metadata: { signature_shape: shape } },
    shape,
    summary: `\`${pointerType}:${shape}\` impulse signature`,
    content: null,
    source_type: 'impulse_signature',
    token_estimate: 0,
    relevance: 0.5,
    budget: 500,
    scope: 'org',
    org_id: orgId,
    priority: 0.5,
    times_loaded: 0,
    times_succeeded: 0,
    times_failed: 0,
    public: false,
    resolution_snapshot: null,
  };
}

describe('/v2/impulses/resolve → impulseSignatureConcept', () => {
  let concepts: ConceptRow[];
  let spy: ReturnType<typeof spyOn>;
  const app = new Hono();
  app.route('/v2/impulses', impulses);

  beforeEach(() => {
    concepts = [];
    spy = spyOn(surrealDB, 'query').mockImplementation(
      async (...args: QueryArgs) => {
        const sql = args[0];
        const params = args[1] || {};

        // upsertBySignature lookup
        if (/^\s*SELECT\s+id\s+FROM\s+concept/i.test(sql)) {
          const pt = params.pointer_type as string;
          const sh = params.shape as string;
          const org = params.org_id as string;
          const match = concepts.find(
            (c) =>
              c.source_type === 'impulse_signature' &&
              c.pointer.type === pt &&
              c.shape === sh &&
              c.org_id === org,
          );
          return match ? [{ id: match.id } as never] : [];
        }

        // upsertBySignature create
        if (/^\s*CREATE\s+type::record\("concept"/i.test(sql)) {
          const row = makeConcept(
            params.id as string,
            (params.pointer as { type: string }).type,
            params.shape as string,
            params.org_id as string,
          );
          concepts.push(row);
          return [row as never];
        }

        // getConceptById
        if (/^\s*SELECT\s+\*\s+FROM\s+type::record\("concept"/i.test(sql)) {
          const id = params.concept_id as string;
          const match = concepts.find((c) => c.id === id);
          return match ? [match as never] : [];
        }

        throw new Error(`Unexpected SQL: ${sql}`);
      },
    );
  });

  afterEach(() => {
    spy.mockRestore();
  });

  test('rejects missing pointer_type/shape', async () => {
    const res = await app.request('/v2/impulses/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pointer: { type: 'impulseSignatureConcept' },
      }),
    });
    expect(res.status).toBe(400);
  });

  test('upserts a signature concept and returns a concept-shaped response', async () => {
    const res = await app.request('/v2/impulses/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pointer: {
          type: 'impulseSignatureConcept',
          pointer_type: 'file',
          shape: 'file',
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.metadata.shape).toBe('concept');
    expect(body.metadata.signature_shape).toBe('impulseSignatureConcept');
    expect(body.metadata.created).toBe(true);
    expect(body.metadata.pointer_type).toBe('file');
    expect(body.metadata.impulse_shape).toBe('file');
    expect(typeof body.metadata.concept_id).toBe('string');
    expect(body.metadata.source_type).toBe('impulse_signature');

    // Second call: created=false, same concept_id
    const res2 = await app.request('/v2/impulses/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pointer: {
          type: 'impulseSignatureConcept',
          pointer_type: 'file',
          shape: 'file',
        },
      }),
    });
    const body2 = await res2.json();
    expect(body2.metadata.created).toBe(false);
    expect(body2.metadata.concept_id).toBe(body.metadata.concept_id);
  });
});

describe('/v2/impulses/resolve → impulseCooccurrenceEdges', () => {
  let spy: ReturnType<typeof spyOn>;
  const app = new Hono();
  app.route('/v2/impulses', impulses);

  const stubRows = [
    {
      from_pointer_type: 'file',
      from_shape: 'file',
      to_pointer_type: 'concept',
      to_shape: 'concept',
      edge_type: 'related_to',
      weight: 0.91,
      times_traversed: 5,
    },
    {
      from_pointer_type: 'file',
      from_shape: 'file',
      to_pointer_type: 'activityExecutionTrace',
      to_shape: 'activityExecutionTrace',
      edge_type: 'related_to',
      weight: 0.42,
      times_traversed: 2,
    },
  ];

  beforeEach(() => {
    spy = spyOn(surrealDB, 'query').mockImplementation(
      async (...args: QueryArgs) => {
        const sql = args[0];
        // getImpulseCooccurrenceEdges builds a multi-condition query over
        // concept_edge with the signature WHERE clauses.
        if (/FROM\s+concept_edge/i.test(sql)) {
          return stubRows as never[];
        }
        throw new Error(`Unexpected SQL in cooccurrence test: ${sql}`);
      },
    );
  });

  afterEach(() => {
    spy.mockRestore();
  });

  test('returns edges transformed to {from_signature, to_signature, ...}', async () => {
    const res = await app.request('/v2/impulses/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pointer: {
          type: 'impulseCooccurrenceEdges',
          min_weight: 0.1,
          limit: 10,
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.metadata.shape).toBe('impulseCooccurrenceEdges');
    expect(body.metadata.count).toBe(2);
    expect(body.metadata.filter.min_weight).toBe(0.1);
    expect(body.metadata.filter.limit).toBe(10);

    expect(Array.isArray(body.content.edges)).toBe(true);
    expect(body.content.edges.length).toBe(2);

    const first = body.content.edges[0];
    expect(first.from_signature).toEqual({ pointer_type: 'file', shape: 'file' });
    expect(first.to_signature).toEqual({ pointer_type: 'concept', shape: 'concept' });
    expect(first.edge_type).toBe('related_to');
    expect(first.weight).toBe(0.91);
    expect(first.times_traversed).toBe(5);
  });

  test('accepts pointer_type+shape filter without error', async () => {
    const res = await app.request('/v2/impulses/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pointer: {
          type: 'impulseCooccurrenceEdges',
          pointer_type: 'file',
          shape: 'file',
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.metadata.filter.pointer_type).toBe('file');
    expect(body.metadata.filter.shape).toBe('file');
  });
});

describe('config.discovery.shapes advertises the new shapes', () => {
  test('includes impulseSignatureConcept and impulseCooccurrenceEdges', () => {
    expect(config.discovery.shapes).toContain('impulseSignatureConcept');
    expect(config.discovery.shapes).toContain('impulseCooccurrenceEdges');
  });
});
