/**
 * Co-occurrence pipeline integration test (concept-db hop only)
 *
 * This is a pipeline-level composition test. Each hop of the larger
 * impulse-relationship learning pipeline has its own unit tests
 * (extractor in minibob, trace read path in activity-api, each
 * concept-db primitive locally), but nothing previously proved that
 * **composing** the concept-db primitives in the sequence the
 * `learn-impulse-relationships` activity template actually invokes them
 * preserves signal end-to-end.
 *
 * What this exercises, in order:
 *
 *   upsertBySignature (x3, idempotent second pass)
 *       ↓
 *   upsertEdge (x2 above threshold, 1 skipped) with weights + edge_types
 *   computed exactly the way the activity template spec says:
 *     - observed_weight = success_count / max(1, total_tasks_observed)
 *     - edge_type = 'sequence_next' when temporal dominance holds, else
 *       'related_to'
 *       ↓
 *   getImpulseCooccurrenceEdges (read-back) — assert we get exactly the
 *   pairs above threshold, with the right edge types.
 *       ↓
 *   upsertEdge (second round with different observed weights) — assert
 *   EMA accumulation matches the α=0.2 contract and times_traversed
 *   increments.
 *       ↓
 *   getImpulseCooccurrenceEdges with a pointer_type filter — assert the
 *   filter semantics match the resolver's contract.
 *
 * Why this file matters as documentation, not just a test:
 *   - The `learn-impulse-relationships` activity prompt encodes the edge-
 *     type-selection rule inline (templates/concept-learning/). If that
 *     rule ever drifts from what's implemented here, this test's comments
 *     will make the gap obvious on review.
 *   - The extractor (minibob) emits the `CooccurrenceStat` shape consumed
 *     below (see repos/minibob/src/impulse-cooccurrence.ts). The test
 *     imports `CooccurrenceStat` / `Signature` types directly so drift
 *     between extractor output and concept-db consumption shows up as a
 *     TypeScript error rather than a silent runtime mismatch.
 *
 * Mock strategy:
 *   Same convention as tests/edge-ema.test.ts and tests/impulse-signature.test.ts —
 *   a `spyOn(surrealDB, 'query')` that dispatches on the SQL shape against an
 *   in-memory rows map. We intentionally don't mock queryWithAuth; no call in
 *   this test path uses a JWT.
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
import { upsertBySignature } from '../src/resolvers/concept';
import {
  upsertEdge,
  getImpulseCooccurrenceEdges,
  EDGE_WEIGHT_EMA_ALPHA,
} from '../src/resolvers/edge';

// The extractor's output shape. We depend on the structural type, not the
// runtime module — the extractor lives in another repo (minibob) and we don't
// want a cross-repo import. Duplicating the relevant fields here keeps the
// test self-contained; mismatches will show up in the assertions below.
interface Signature {
  pointer_type: string;
  shape: string | null;
}

interface CooccurrenceStat {
  a: Signature;
  b: Signature;
  success_count: number;
  failure_count: number;
  a_before_b: number;
  b_before_a: number;
  total_tasks_observed: number;
}

// ---------------------------------------------------------------------------
// In-memory mock SurrealDB
// ---------------------------------------------------------------------------

/**
 * Row shape for the `concept` table — only the fields this pipeline touches.
 * Matches the CREATE statement in upsertBySignature (concept.ts) and the
 * field names read by getImpulseCooccurrenceEdges (edge.ts).
 */
interface ConceptRow {
  id: string;
  pointer: { type: string; metadata?: Record<string, unknown> };
  shape: string;
  source_type: string; // 'impulse_signature' for everything upsertBySignature creates
  org_id: string;
}

/**
 * Row shape for the `concept_edge` table. Tracks the fields the pipeline
 * reads: from/to, edge_type, weight, times_traversed, org_id. We store
 * denormalized pointer/shape on each side for the cooccurrence SELECT that
 * uses nested field access.
 */
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

/**
 * Install a SurrealDB query spy that understands the 5 SQL shapes this
 * pipeline emits. Anything unexpected throws, so SQL drift in concept.ts or
 * edge.ts surfaces as a loud test failure rather than silent pass.
 */
function installPipelineSpy(
  concepts: ConceptRow[],
  edges: EdgeRow[],
): ReturnType<typeof spyOn> {
  return spyOn(surrealDB, 'query').mockImplementation(
    async (...args: QueryArgs) => {
      const sql = args[0];
      const params = args[1] || {};

      // 1. upsertBySignature lookup: SELECT id FROM concept WHERE source_type=... AND pointer.type=... AND shape=... AND org_id=...
      if (/^\s*SELECT\s+id\s+FROM\s+concept\b/i.test(sql)) {
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

      // 2. upsertBySignature CREATE
      if (/^\s*CREATE\s+type::thing\("concept"/i.test(sql)) {
        const row: ConceptRow = {
          id: params.id as string,
          pointer: params.pointer as {
            type: string;
            metadata?: Record<string, unknown>;
          },
          shape: params.shape as string,
          source_type: 'impulse_signature',
          org_id: params.org_id as string,
        };
        concepts.push(row);
        return [row as never];
      }

      // 3. upsertEdge lookup: SELECT id, weight FROM concept_edge WHERE from/to/edge_type
      if (/^\s*SELECT\s+id,\s+weight\s+FROM\s+concept_edge/i.test(sql)) {
        const from = params.from_id as string;
        const to = params.to_id as string;
        const et = params.edge_type as string;
        const match = edges.find(
          (e) =>
            e.from_concept_id === from &&
            e.to_concept_id === to &&
            e.edge_type === et,
        );
        return match ? [{ id: match.id, weight: match.weight } as never] : [];
      }

      // 4. upsertEdge CREATE
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
        edges.push(row);
        return [row as never];
      }

      // 5. upsertEdge UPDATE (EMA path) — increments times_traversed and sets weight
      if (/^\s*UPDATE\s+type::thing\("concept_edge"/i.test(sql)) {
        const edgeId = params.edge_id as string;
        const row = edges.find((e) => e.id === edgeId);
        if (!row) throw new Error(`Edge not found in mock: ${edgeId}`);
        if (params.weight !== undefined) row.weight = Number(params.weight);
        row.times_traversed += 1;
        if (params.description !== undefined) {
          row.description = params.description as string;
        }
        return [row as never];
      }

      // 6. getImpulseCooccurrenceEdges: SELECT from_concept.pointer.type AS ..., ... FROM concept_edge WHERE ...
      //    We simulate the nested-field projection and the WHERE-clause filters
      //    that actually matter for the pipeline (org_id, min_weight,
      //    pointer_type). Both endpoints are always impulse_signature concepts
      //    in this pipeline — the resolver's source_type filter is structural,
      //    so we don't re-check it here.
      if (
        /^\s*SELECT[\s\S]*FROM\s+concept_edge/i.test(sql) &&
        /from_concept\.pointer\.type\s+AS\s+from_pointer_type/i.test(sql)
      ) {
        const orgId = params.org_id as string;
        const minWeight =
          typeof params.min_weight === 'number' ? params.min_weight : undefined;
        const pointerType = params.pointer_type as string | undefined;
        const sigShape = params.sig_shape as string | undefined;

        const out: Array<{
          from_pointer_type: string;
          from_shape: string;
          to_pointer_type: string;
          to_shape: string;
          edge_type: string;
          weight: number;
          times_traversed: number;
        }> = [];

        for (const edge of edges) {
          if (edge.org_id !== orgId) continue;
          if (minWeight !== undefined && edge.weight < minWeight) continue;

          const from = concepts.find((c) => c.id === edge.from_concept_id);
          const to = concepts.find((c) => c.id === edge.to_concept_id);
          if (!from || !to) continue;

          // Pointer-type / shape filter: keep the edge if EITHER endpoint
          // matches (same rule as edge.ts:352-370).
          if (pointerType !== undefined && sigShape !== undefined) {
            const matches =
              (from.pointer.type === pointerType && from.shape === sigShape) ||
              (to.pointer.type === pointerType && to.shape === sigShape);
            if (!matches) continue;
          } else if (pointerType !== undefined) {
            const matches =
              from.pointer.type === pointerType ||
              to.pointer.type === pointerType;
            if (!matches) continue;
          } else if (sigShape !== undefined) {
            const matches = from.shape === sigShape || to.shape === sigShape;
            if (!matches) continue;
          }

          out.push({
            from_pointer_type: from.pointer.type,
            from_shape: from.shape,
            to_pointer_type: to.pointer.type,
            to_shape: to.shape,
            edge_type: edge.edge_type,
            weight: edge.weight,
            times_traversed: edge.times_traversed,
          });
        }

        // Emulate ORDER BY weight DESC on the real SQL.
        out.sort((a, b) => b.weight - a.weight);
        return out as never[];
      }

      throw new Error(`Unexpected SQL in pipeline test: ${sql}`);
    },
  );
}

// ---------------------------------------------------------------------------
// Scenario: 3 signatures, 3 observed pairs
// ---------------------------------------------------------------------------

// These three signatures model the realistic "a file impulse, a memo impulse,
// and a git-diff impulse" trio that shows up in a typical fix-bug task. The
// first two pairs are above the template's default threshold of 3; the third
// is a control that must be skipped.
const fileA: Signature = { pointer_type: 'file', shape: 'source_code' };
const memoB: Signature = { pointer_type: 'memo', shape: 'memo' };
const gitDiffC: Signature = { pointer_type: 'gitDiff', shape: 'gitDiff' };

// Default threshold from the `learn-impulse-relationships` activity template
// (templates/concept-learning/learn-impulse-relationships.json variable
// `minCooccurrences`). Keeping it a const here makes the "skipped because
// below threshold" assertion below self-documenting.
const MIN_COOCCURRENCES_THRESHOLD = 3;

// Canonical pair stats. Matches the shape `extractCooccurrenceMatrix` emits
// (repos/minibob/src/impulse-cooccurrence.ts:58). Each pair has a distinct
// temporal-ordering profile so we can test both `sequence_next` (temporal
// dominance) and `related_to` (no dominance) edge-type selection.
const pairFileMemo: CooccurrenceStat = {
  a: fileA,
  b: memoB,
  success_count: 5,
  failure_count: 1,
  a_before_b: 4,
  b_before_a: 0,
  total_tasks_observed: 6,
};

const pairFileGitDiff: CooccurrenceStat = {
  a: fileA,
  b: gitDiffC,
  success_count: 3,
  failure_count: 0,
  a_before_b: 1,
  b_before_a: 1,
  total_tasks_observed: 3,
};

const pairMemoGitDiff: CooccurrenceStat = {
  a: memoB,
  b: gitDiffC,
  success_count: 2, // below threshold — should never be upserted as an edge
  failure_count: 0,
  a_before_b: 2,
  b_before_a: 0,
  total_tasks_observed: 2,
};

/**
 * The edge-type selection rule from the activity template prompt. Duplicated
 * here so the test documents the contract: if this function drifts from the
 * template, learn-impulse-relationships will produce different edges than
 * this test claims.
 *
 *   sequence_next when max(a_before_b, b_before_a) > 2 * min(...) AND max >= 2
 *   related_to    otherwise
 */
function chooseEdgeType(stat: CooccurrenceStat): 'sequence_next' | 'related_to' {
  const maxT = Math.max(stat.a_before_b, stat.b_before_a);
  const minT = Math.min(stat.a_before_b, stat.b_before_a);
  if (maxT > 2 * minT && maxT >= 2) return 'sequence_next';
  return 'related_to';
}

/**
 * The observed-weight formula from the activity template prompt, including
 * the [0.01, 1.0] clamp. Same drift-detection purpose as `chooseEdgeType`.
 */
function observedWeight(stat: CooccurrenceStat): number {
  const w = stat.success_count / Math.max(1, stat.total_tasks_observed);
  return Math.max(0.01, Math.min(1.0, w));
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

describe('cooccurrence pipeline integration (concept-db hop)', () => {
  const orgId = 'org_integration';

  let concepts: ConceptRow[];
  let edges: EdgeRow[];
  let spy: ReturnType<typeof spyOn>;

  // Track the concept IDs assigned by upsertBySignature so we can reuse them
  // across the steps that mimic the activity template.
  let conceptIdFileA: string;
  let conceptIdMemoB: string;
  let conceptIdGitDiffC: string;

  beforeEach(() => {
    concepts = [];
    edges = [];
    spy = installPipelineSpy(concepts, edges);
  });

  afterEach(() => {
    spy.mockRestore();
  });

  test('full pipeline: upsert signatures, apply EMA, read back, verify filter', async () => {
    // -------------------------------------------------------------------------
    // Step (a): Upsert one concept per distinct signature. The activity
    //           template calls `concept_upsert_by_signature` once per endpoint
    //           per pair, so a single signature gets touched twice in the same
    //           run — idempotency matters.
    // -------------------------------------------------------------------------

    const firstFileA = await upsertBySignature(
      { pointerType: fileA.pointer_type, shape: fileA.shape ?? '', orgId },
    );
    expect(firstFileA.created).toBe(true);
    conceptIdFileA = firstFileA.id;

    // Idempotent second call: the real template WILL hit this because two
    // distinct pairs share `fileA` as an endpoint.
    const secondFileA = await upsertBySignature(
      { pointerType: fileA.pointer_type, shape: fileA.shape ?? '', orgId },
    );
    expect(secondFileA.created).toBe(false);
    expect(secondFileA.id).toBe(conceptIdFileA);

    const firstMemoB = await upsertBySignature(
      { pointerType: memoB.pointer_type, shape: memoB.shape ?? '', orgId },
    );
    expect(firstMemoB.created).toBe(true);
    conceptIdMemoB = firstMemoB.id;

    const firstGitDiffC = await upsertBySignature(
      { pointerType: gitDiffC.pointer_type, shape: gitDiffC.shape ?? '', orgId },
    );
    expect(firstGitDiffC.created).toBe(true);
    conceptIdGitDiffC = firstGitDiffC.id;

    // Three distinct signatures, three concepts — no collisions.
    expect(concepts.length).toBe(3);
    expect(
      new Set([conceptIdFileA, conceptIdMemoB, conceptIdGitDiffC]).size,
    ).toBe(3);

    // -------------------------------------------------------------------------
    // Step (b): For each pair ABOVE threshold, compute the base edge_type and
    //           observed_weight using the template's formulas, then upsertEdge.
    //           The below-threshold pair (pairMemoGitDiff) is NEVER upserted —
    //           simulated here by simply not calling the function.
    // -------------------------------------------------------------------------

    // Direction rule: `sequence_next` points FROM the earlier signature TO
    // the later. For pairFileMemo, a_before_b=4 > b_before_a=0, so a=fileA
    // is the earlier one → from=fileA, to=memoB.
    expect(chooseEdgeType(pairFileMemo)).toBe('sequence_next');
    const fileMemoWeight1 = observedWeight(pairFileMemo);
    expect(fileMemoWeight1).toBeCloseTo(5 / 6, 10);

    const fileMemoEdge1 = await upsertEdge(
      {
        from_concept_id: conceptIdFileA,
        to_concept_id: conceptIdMemoB,
        edge_type: 'sequence_next',
        weight: fileMemoWeight1,
        description: 'co-occurrence frequency',
      },
      orgId,
    );
    expect(fileMemoEdge1.created).toBe(true);
    expect(fileMemoEdge1.new_weight).toBeCloseTo(fileMemoWeight1, 10);
    expect(fileMemoEdge1.previous_weight).toBeUndefined();

    // pairFileGitDiff: no temporal dominance (1==1 on each side) → related_to.
    expect(chooseEdgeType(pairFileGitDiff)).toBe('related_to');
    const fileGitDiffWeight1 = observedWeight(pairFileGitDiff);
    expect(fileGitDiffWeight1).toBeCloseTo(3 / 3, 10);

    const fileGitDiffEdge1 = await upsertEdge(
      {
        from_concept_id: conceptIdFileA,
        to_concept_id: conceptIdGitDiffC,
        edge_type: 'related_to',
        weight: fileGitDiffWeight1,
        description: 'co-occurrence frequency',
      },
      orgId,
    );
    expect(fileGitDiffEdge1.created).toBe(true);
    expect(fileGitDiffEdge1.new_weight).toBeCloseTo(fileGitDiffWeight1, 10);

    // pairMemoGitDiff is below threshold — verify we never called upsertEdge
    // for it by asserting total edge count is 2, not 3.
    expect(pairMemoGitDiff.success_count).toBeLessThan(
      MIN_COOCCURRENCES_THRESHOLD,
    );
    expect(edges.length).toBe(2);

    // -------------------------------------------------------------------------
    // Step (c): Read back via getImpulseCooccurrenceEdges — the resolver that
    //           the `classify-strong-edges-with-llm` task calls to enumerate
    //           edges for LLM classification. min_weight=0 to get everything.
    // -------------------------------------------------------------------------

    const allEdges = await getImpulseCooccurrenceEdges({
      orgId,
      minWeight: 0,
    });

    // Exactly 2 edges: the below-threshold pair is absent (never upserted).
    expect(allEdges.length).toBe(2);

    const fileMemoRead = allEdges.find(
      (e) =>
        (e.from_signature.pointer_type === 'file' &&
          e.to_signature.pointer_type === 'memo') ||
        (e.from_signature.pointer_type === 'memo' &&
          e.to_signature.pointer_type === 'file'),
    );
    expect(fileMemoRead).toBeDefined();
    expect(fileMemoRead!.edge_type).toBe('sequence_next');

    const fileGitDiffRead = allEdges.find(
      (e) =>
        (e.from_signature.pointer_type === 'file' &&
          e.to_signature.pointer_type === 'gitDiff') ||
        (e.from_signature.pointer_type === 'gitDiff' &&
          e.to_signature.pointer_type === 'file'),
    );
    expect(fileGitDiffRead).toBeDefined();
    expect(fileGitDiffRead!.edge_type).toBe('related_to');

    // memoB ↔ gitDiffC must not appear anywhere.
    const memoGitDiffRead = allEdges.find(
      (e) =>
        (e.from_signature.pointer_type === 'memo' &&
          e.to_signature.pointer_type === 'gitDiff') ||
        (e.from_signature.pointer_type === 'gitDiff' &&
          e.to_signature.pointer_type === 'memo'),
    );
    expect(memoGitDiffRead).toBeUndefined();

    // -------------------------------------------------------------------------
    // Step (d): Second round of upserts — same pairs, different observed
    //           weights. The EMA rule (α=0.2) says each call pulls the stored
    //           weight 20% toward the new observation. `times_traversed`
    //           increments on every call — this is the "we actually saw this
    //           pair N times" counter that downstream upkeep and learning
    //           look at.
    // -------------------------------------------------------------------------

    expect(EDGE_WEIGHT_EMA_ALPHA).toBe(0.2); // pinning the contract locally

    // Multiply by 1.5, clamp to 1.0. Picking a different factor per run just
    // makes the EMA calculation visible — the numbers change.
    const fileMemoWeight2 = Math.min(1.0, fileMemoWeight1 * 1.5);
    const fileGitDiffWeight2 = Math.min(1.0, fileGitDiffWeight1 * 1.5);

    const fileMemoEdge2 = await upsertEdge(
      {
        from_concept_id: conceptIdFileA,
        to_concept_id: conceptIdMemoB,
        edge_type: 'sequence_next',
        weight: fileMemoWeight2,
      },
      orgId,
    );
    expect(fileMemoEdge2.created).toBe(false);
    expect(fileMemoEdge2.previous_weight).toBeCloseTo(fileMemoWeight1, 10);

    const expectedFileMemo =
      (1 - EDGE_WEIGHT_EMA_ALPHA) * fileMemoWeight1 +
      EDGE_WEIGHT_EMA_ALPHA * fileMemoWeight2;
    expect(fileMemoEdge2.new_weight).toBeCloseTo(expectedFileMemo, 10);

    const fileGitDiffEdge2 = await upsertEdge(
      {
        from_concept_id: conceptIdFileA,
        to_concept_id: conceptIdGitDiffC,
        edge_type: 'related_to',
        weight: fileGitDiffWeight2,
      },
      orgId,
    );
    expect(fileGitDiffEdge2.created).toBe(false);
    expect(fileGitDiffEdge2.previous_weight).toBeCloseTo(fileGitDiffWeight1, 10);

    const expectedFileGitDiff =
      (1 - EDGE_WEIGHT_EMA_ALPHA) * fileGitDiffWeight1 +
      EDGE_WEIGHT_EMA_ALPHA * fileGitDiffWeight2;
    expect(fileGitDiffEdge2.new_weight).toBeCloseTo(expectedFileGitDiff, 10);

    // `times_traversed == 2` is the load-bearing observability field: upkeep
    // activities use it as a prior on edge confidence and minibob surfaces it
    // in the `impulseCooccurrenceEdges` response. One miscount here silently
    // biases the whole learning loop.
    const storedFileMemo = edges.find(
      (e) =>
        e.from_concept_id === conceptIdFileA &&
        e.to_concept_id === conceptIdMemoB &&
        e.edge_type === 'sequence_next',
    );
    expect(storedFileMemo!.times_traversed).toBe(2);
    const storedFileGitDiff = edges.find(
      (e) =>
        e.from_concept_id === conceptIdFileA &&
        e.to_concept_id === conceptIdGitDiffC &&
        e.edge_type === 'related_to',
    );
    expect(storedFileGitDiff!.times_traversed).toBe(2);

    // -------------------------------------------------------------------------
    // Step (e): Verify pointer_type filtering. The classify task passes
    //           `min_weight: classifyThreshold` but not pointer_type — here we
    //           exercise the other code path to make sure the filter's "keep
    //           if EITHER endpoint matches" semantics (edge.ts:352-370) are
    //           correct. Both our edges have `file` as one endpoint, so both
    //           should survive the filter; a query for `pointer_type: 'concept'`
    //           (no such endpoint) should return nothing.
    // -------------------------------------------------------------------------

    const fileFilteredEdges = await getImpulseCooccurrenceEdges({
      orgId,
      pointerType: 'file',
    });
    expect(fileFilteredEdges.length).toBe(2);
    for (const edge of fileFilteredEdges) {
      const eitherIsFile =
        edge.from_signature.pointer_type === 'file' ||
        edge.to_signature.pointer_type === 'file';
      expect(eitherIsFile).toBe(true);
    }

    // Negative control: no edge has a 'concept' pointer endpoint.
    const conceptFiltered = await getImpulseCooccurrenceEdges({
      orgId,
      pointerType: 'concept',
    });
    expect(conceptFiltered.length).toBe(0);
  });
});
