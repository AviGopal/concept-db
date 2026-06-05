/**
 * impulse_signature source_type + upsertBySignature tests
 *
 * Exercises `upsertBySignature` against a mocked SurrealDB client so we can
 * assert:
 *   - idempotency: calling twice with the same (pointer_type, shape, org_id)
 *     returns the existing concept and `created: false`
 *   - filtering: different pointer_type, shape, or org_id buckets into a new
 *     signature (no collision)
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { surrealDB } from '../src/db/surreal';
import { upsertBySignature } from '../src/resolvers/concept';
import { SourceTypeSchema } from '../src/models/schemas';

interface SignatureRow {
  id: string;
  pointer: { type: string; metadata?: Record<string, unknown> };
  shape: string;
  source_type: string;
  org_id: string;
}

type QueryArgs = [sql: string, params?: Record<string, unknown>];

/**
 * Build an in-memory surrealDB.query spy that treats the concept table as a
 * list of rows. Supports just the SELECT and CREATE shapes emitted by
 * upsertBySignature.
 */
function installInMemoryQuerySpy(rows: SignatureRow[]) {
  return spyOn(surrealDB, 'query').mockImplementation(
    async (...args: QueryArgs) => {
      const sql = args[0];
      const params = args[1] || {};

      if (/^\s*SELECT\s+id\s+FROM\s+concept/i.test(sql)) {
        const pt = params.pointer_type as string;
        const sh = params.shape as string;
        const org = params.org_id as string;
        const match = rows.find(
          (r) =>
            r.source_type === 'impulse_signature' &&
            r.pointer.type === pt &&
            r.shape === sh &&
            r.org_id === org,
        );
        return match ? [{ id: match.id } as never] : [];
      }

      if (/^\s*CREATE\s+type::thing\("concept"/i.test(sql)) {
        const row: SignatureRow = {
          id: params.id as string,
          pointer: params.pointer as { type: string; metadata?: Record<string, unknown> },
          shape: params.shape as string,
          source_type: 'impulse_signature',
          org_id: params.org_id as string,
        };
        rows.push(row);
        return [row as never];
      }

      throw new Error(`Unexpected SQL in test: ${sql}`);
    },
  );
}

describe('SourceTypeSchema includes impulse_signature', () => {
  test('accepts the new enum value', () => {
    expect(() => SourceTypeSchema.parse('impulse_signature')).not.toThrow();
  });
});

describe('upsertBySignature', () => {
  let rows: SignatureRow[];
  let spy: ReturnType<typeof installInMemoryQuerySpy>;

  beforeEach(() => {
    rows = [];
    spy = installInMemoryQuerySpy(rows);
  });

  afterEach(() => {
    spy.mockRestore();
  });

  test('first call creates, second call returns existing', async () => {
    const first = await upsertBySignature({
      pointerType: 'file',
      shape: 'file',
      orgId: 'org_a',
    });
    expect(first.created).toBe(true);
    expect(first.id).toMatch(/^concept_/);
    expect(rows.length).toBe(1);

    const second = await upsertBySignature({
      pointerType: 'file',
      shape: 'file',
      orgId: 'org_a',
    });
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    // No new row created
    expect(rows.length).toBe(1);
  });

  test('different pointer_type produces distinct concepts', async () => {
    const a = await upsertBySignature({
      pointerType: 'file',
      shape: 'file',
      orgId: 'org_a',
    });
    const b = await upsertBySignature({
      pointerType: 'concept',
      shape: 'file',
      orgId: 'org_a',
    });
    expect(a.id).not.toBe(b.id);
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(rows.length).toBe(2);
  });

  test('different shape produces distinct concepts', async () => {
    const a = await upsertBySignature({
      pointerType: 'file',
      shape: 'file',
      orgId: 'org_a',
    });
    const b = await upsertBySignature({
      pointerType: 'file',
      shape: 'source_code',
      orgId: 'org_a',
    });
    expect(a.id).not.toBe(b.id);
    expect(rows.length).toBe(2);
  });

  test('org isolation: same signature in different org gets its own concept', async () => {
    const a = await upsertBySignature({
      pointerType: 'file',
      shape: 'file',
      orgId: 'org_a',
    });
    const b = await upsertBySignature({
      pointerType: 'file',
      shape: 'file',
      orgId: 'org_b',
    });
    expect(a.id).not.toBe(b.id);
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(rows.length).toBe(2);

    // And within org_b, idempotency still holds
    const b2 = await upsertBySignature({
      pointerType: 'file',
      shape: 'file',
      orgId: 'org_b',
    });
    expect(b2.created).toBe(false);
    expect(b2.id).toBe(b.id);
  });
});
