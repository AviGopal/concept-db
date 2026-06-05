/**
 * upsertEdge EMA tests
 *
 * Exercises `upsertEdge` against a mocked SurrealDB client:
 *   - first call creates an edge with weight=0.3, times_traversed=1
 *   - second call with weight=0.9 applies EMA with alpha=0.2:
 *       new_weight = 0.8 * 0.3 + 0.2 * 0.9 = 0.24 + 0.18 = 0.42
 *     and increments times_traversed to 2
 *   - description is replaced only when provided on the new call
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { surrealDB } from '../src/db/surreal';
import { upsertEdge, EDGE_WEIGHT_EMA_ALPHA } from '../src/resolvers/edge';

interface EdgeRow {
  id: string;
  from_concept_id: string;
  to_concept_id: string;
  edge_type: string;
  description: string | null;
  weight: number;
  times_traversed: number;
  org_id: string;
}

type QueryArgs = [sql: string, params?: Record<string, unknown>];

function installEdgeQuerySpy(rows: EdgeRow[]) {
  return spyOn(surrealDB, 'query').mockImplementation(
    async (...args: QueryArgs) => {
      const sql = args[0];
      const params = args[1] || {};

      // Lookup for existing edge
      if (/^\s*SELECT\s+id,\s+weight\s+FROM\s+concept_edge/i.test(sql)) {
        const from = params.from_id as string;
        const to = params.to_id as string;
        const et = params.edge_type as string;
        const match = rows.find(
          (r) =>
            r.from_concept_id === from &&
            r.to_concept_id === to &&
            r.edge_type === et,
        );
        return match ? [{ id: match.id, weight: match.weight } as never] : [];
      }

      // Create a new edge
      if (/^\s*INSERT\s+INTO\s+concept_edge\s*\{/i.test(sql)) {
        const row: EdgeRow = {
          id: params.id as string,
          from_concept_id: params.from_concept_id as string,
          to_concept_id: params.to_concept_id as string,
          edge_type: params.edge_type as string,
          description: (params.description ?? null) as string | null,
          weight: Number(params.weight),
          times_traversed: 1,
          org_id: params.org_id as string,
        };
        rows.push(row);
        return [row as never];
      }

      // Update existing edge weight, traversal, optional description
      if (/^\s*UPDATE\s+type::thing\("concept_edge"/i.test(sql)) {
        const edgeId = params.edge_id as string;
        const row = rows.find((r) => r.id === edgeId);
        if (!row) throw new Error(`Edge not found in mock: ${edgeId}`);
        if (params.weight !== undefined) row.weight = Number(params.weight);
        // times_traversed increments unconditionally per upsertEdge logic
        row.times_traversed += 1;
        if (params.description !== undefined) {
          row.description = params.description as string;
        }
        return [row as never];
      }

      throw new Error(`Unexpected SQL in edge test: ${sql}`);
    },
  );
}

describe('EDGE_WEIGHT_EMA_ALPHA', () => {
  test('is 0.2 per spec', () => {
    expect(EDGE_WEIGHT_EMA_ALPHA).toBe(0.2);
  });
});

describe('upsertEdge EMA behaviour', () => {
  let rows: EdgeRow[];
  let spy: ReturnType<typeof installEdgeQuerySpy>;

  beforeEach(() => {
    rows = [];
    spy = installEdgeQuerySpy(rows);
  });

  afterEach(() => {
    spy.mockRestore();
  });

  test('creates edge on first call with weight=0.3, times_traversed=1', async () => {
    const result = await upsertEdge(
      {
        from_concept_id: 'concept_sig_a',
        to_concept_id: 'concept_sig_b',
        edge_type: 'related_to',
        weight: 0.3,
      },
      'org_a',
    );

    expect(result.created).toBe(true);
    expect(result.new_weight).toBe(0.3);
    expect(result.previous_weight).toBeUndefined();

    expect(rows.length).toBe(1);
    expect(rows[0]!.weight).toBe(0.3);
    expect(rows[0]!.times_traversed).toBe(1);
  });

  test('applies EMA on second call: 0.3 -> 0.42 for observed=0.9', async () => {
    await upsertEdge(
      {
        from_concept_id: 'concept_sig_a',
        to_concept_id: 'concept_sig_b',
        edge_type: 'related_to',
        weight: 0.3,
      },
      'org_a',
    );

    const second = await upsertEdge(
      {
        from_concept_id: 'concept_sig_a',
        to_concept_id: 'concept_sig_b',
        edge_type: 'related_to',
        weight: 0.9,
      },
      'org_a',
    );

    expect(second.created).toBe(false);
    expect(second.previous_weight).toBeCloseTo(0.3, 10);
    // EMA: 0.8 * 0.3 + 0.2 * 0.9 = 0.24 + 0.18 = 0.42
    expect(second.new_weight).toBeCloseTo(0.42, 10);

    expect(rows.length).toBe(1);
    expect(rows[0]!.weight).toBeCloseTo(0.42, 10);
    expect(rows[0]!.times_traversed).toBe(2);
  });

  test('description is preserved when not provided, replaced when provided', async () => {
    await upsertEdge(
      {
        from_concept_id: 'a',
        to_concept_id: 'b',
        edge_type: 'related_to',
        weight: 0.5,
        description: 'initial',
      },
      'org_a',
    );
    expect(rows[0]!.description).toBe('initial');

    // Second call without description: description untouched
    await upsertEdge(
      {
        from_concept_id: 'a',
        to_concept_id: 'b',
        edge_type: 'related_to',
        weight: 0.5,
      },
      'org_a',
    );
    expect(rows[0]!.description).toBe('initial');

    // Third call with new description: replaced
    await upsertEdge(
      {
        from_concept_id: 'a',
        to_concept_id: 'b',
        edge_type: 'related_to',
        weight: 0.5,
        description: 'updated',
      },
      'org_a',
    );
    expect(rows[0]!.description).toBe('updated');
    expect(rows[0]!.times_traversed).toBe(3);
  });

  test('distinct (from,to,edge_type) tuples create separate edges', async () => {
    await upsertEdge(
      {
        from_concept_id: 'a',
        to_concept_id: 'b',
        edge_type: 'related_to',
        weight: 0.5,
      },
      'org_a',
    );
    await upsertEdge(
      {
        from_concept_id: 'a',
        to_concept_id: 'b',
        edge_type: 'derived_from',
        weight: 0.7,
      },
      'org_a',
    );
    await upsertEdge(
      {
        from_concept_id: 'a',
        to_concept_id: 'c',
        edge_type: 'related_to',
        weight: 0.4,
      },
      'org_a',
    );

    expect(rows.length).toBe(3);
  });
});
