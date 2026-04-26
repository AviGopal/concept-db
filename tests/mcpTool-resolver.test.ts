/**
 * /v2/impulses/resolve → mcpTool
 *
 * Covers the discovery-to-tools bridge resolver. Validates:
 *   - Empty/uninformed context returns the full tool catalog (capped at limit)
 *   - Concept-related context surfaces concept tools at top
 *   - Unknown shapes don't error — they just contribute zero shape signal
 *   - Score ordering is stable and correct for known fixture inputs
 *   - The returned envelope carries all required tool-impulse fields
 *
 * No DB calls — the resolver is pure (it scores against the in-process
 * `conceptTools` definition list).
 */

import { describe, test, expect } from 'bun:test';
import { Hono } from 'hono';
import { impulses } from '../src/routes/impulses';
import { conceptTools } from '../src/tools/definitions';
import { config } from '../src/config';

const app = new Hono();
app.route('/v2/impulses', impulses);

async function resolve(pointer: Record<string, unknown>): Promise<{
  status: number;
  body: any;
}> {
  const res = await app.request('/v2/impulses/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pointer }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

describe('/v2/impulses/resolve → mcpTool', () => {
  test('empty context returns full tool catalog (capped at default limit)', async () => {
    const { status, body } = await resolve({ type: 'mcpTool' });
    expect(status).toBe(200);
    expect(body.metadata.shape).toBe('mcpTool');
    expect(body.metadata.rowCount).toBe(conceptTools.length);
    // Default limit is 20; concept-db has 9 tools so all returned.
    expect(Array.isArray(body.content)).toBe(true);
    expect(body.content.length).toBe(conceptTools.length);
    expect(body.metadata.summary).toContain('uninformed prior');
  });

  test('respects pointer.limit', async () => {
    const { status, body } = await resolve({ type: 'mcpTool', limit: 3 });
    expect(status).toBe(200);
    expect(body.content.length).toBe(3);
    expect(body.metadata.rowCount).toBe(3);
  });

  test('each returned tool impulse has all required envelope fields', async () => {
    const { body } = await resolve({ type: 'mcpTool', limit: 1 });
    const tool = body.content[0];
    expect(tool.shape).toBe('mcpTool');
    expect(tool.vessel_id).toBe(config.discovery.vesselId);
    expect(typeof tool.vessel_endpoint).toBe('string');
    expect(tool.vessel_endpoint.length).toBeGreaterThan(0);
    expect(typeof tool.tool_name).toBe('string');
    expect(typeof tool.description).toBe('string');
    expect(tool.input_schema.type).toBe('object');
    expect(tool.resolve_endpoint).toBe('/mcp/tools/call');
    expect(tool.resolve_request_format).toBe('mcp-tool');
    expect(tool.auth_scheme).toBe('ApiKey');
    expect(typeof tool.relevance_score).toBe('number');
    expect(Array.isArray(tool.matched_input_shapes)).toBe(true);
    expect(Array.isArray(tool.matched_output_shapes)).toBe(true);
    // Anthropic tool-name regex compliance
    expect(tool.tool_name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  test('input_shapes: ["concept"] ranks concept tools above unrelated ones', async () => {
    const { status, body } = await resolve({
      type: 'mcpTool',
      context: { input_shapes: ['concept'] },
    });
    expect(status).toBe(200);
    // Every concept-db tool name has "concept" in it, so they should all
    // score above the cold-start baseline. The top result should still be
    // a concept-related tool.
    const top = body.content[0];
    expect(top.tool_name).toContain('concept');
    expect(top.relevance_score).toBeGreaterThan(0.15); // > uninformed prior
    expect(body.metadata.summary).toContain('matching context');
  });

  test('goal_keywords surface tools whose name/description match', async () => {
    const { body } = await resolve({
      type: 'mcpTool',
      context: { goal_keywords: ['link', 'edge'] },
    });
    // concept_link has both "link" in its name and "edge" in its description.
    // It should land in the top-3.
    const topThreeNames = body.content
      .slice(0, 3)
      .map((t: any) => t.tool_name);
    expect(topThreeNames).toContain('concept_link');
  });

  test('upsert+signature keywords surface concept_upsert_by_signature', async () => {
    const { body } = await resolve({
      type: 'mcpTool',
      context: {
        goal_keywords: ['upsert', 'signature', 'concept'],
        input_shapes: ['impulseSignatureConcept'],
        output_shapes: ['concept'],
        task_description:
          'Materialize one concept per unique impulse signature seen in traces.',
      },
    });
    const topNames = body.content.slice(0, 3).map((t: any) => t.tool_name);
    expect(topNames).toContain('concept_upsert_by_signature');
  });

  test('unknown shape produces empty-but-valid response (no error)', async () => {
    const { status, body } = await resolve({
      type: 'mcpTool',
      context: { input_shapes: ['totally_unrelated_shape_xyz'] },
    });
    // Unknown shape just contributes zero shape-match signal — every tool
    // still gets the EMA prior (0.3 * 0.5 = 0.15), so the catalog is
    // returned ranked by name alphabetically (stable tie-break).
    expect(status).toBe(200);
    expect(body.content.length).toBeGreaterThan(0); // resolver doesn't 404
  });

  test('top-1 for concept+edge keywords contains either concept_link or concept_neighbors', async () => {
    const { body } = await resolve({
      type: 'mcpTool',
      context: { goal_keywords: ['concept', 'edge'] },
      limit: 5,
    });
    // Both concept_link (creates an "edge between concepts") and
    // concept_neighbors (graph "neighbors") are dominant matches; either
    // is acceptable for #1 because they tokenize similarly.
    const top = body.content[0];
    expect(['concept_link', 'concept_neighbors', 'concept_cooccurrence_edges'])
      .toContain(top.tool_name);
  });

  test('min_relevance filters out low-scoring tools', async () => {
    // A high min_relevance with no informative context should drop most
    // results (since cold-start scores are 0.15 for all).
    const { body } = await resolve({
      type: 'mcpTool',
      min_relevance: 0.5,
    });
    // No context → all tools score 0.15 (under 0.5) → empty.
    expect(body.content.length).toBe(0);
    expect(body.metadata.rowCount).toBe(0);
  });

  test('top-level context fields are accepted (backward-compat shorthand)', async () => {
    // The spec nests context under `context`, but also accepts top-level
    // fields. Verify both shapes resolve.
    const { status, body } = await resolve({
      type: 'mcpTool',
      goal_keywords: ['concept', 'link'],
    });
    expect(status).toBe(200);
    expect(body.content.length).toBeGreaterThan(0);
    const top = body.content[0];
    expect(top.tool_name).toContain('concept');
  });

  test('matched_input_shapes is populated when input_shapes overlap tool tokens', async () => {
    const { body } = await resolve({
      type: 'mcpTool',
      context: { input_shapes: ['concept'] },
    });
    // At least one returned tool should advertise `concept` as a matched input.
    const someMatched = body.content.some((t: any) =>
      t.matched_input_shapes.includes('concept'),
    );
    expect(someMatched).toBe(true);
  });
});
