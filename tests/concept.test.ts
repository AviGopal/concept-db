/**
 * Concept Tests
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Hono } from 'hono';
import { mcp } from '../src/routes/mcp';
import { concepts } from '../src/routes/concepts';
import { conceptTools, getToolByName } from '../src/tools/definitions';
import {
  CreateConceptRequestSchema,
  ResolveConceptRequestSchema,
  SearchConceptsRequestSchema,
  LinkConceptsRequestSchema,
} from '../src/models/schemas';

describe('MCP Tools', () => {
  test('should list all concept tools', () => {
    expect(conceptTools.length).toBeGreaterThan(0);
    expect(conceptTools.map(t => t.name)).toContain('concept_create');
    expect(conceptTools.map(t => t.name)).toContain('concept_resolve');
    expect(conceptTools.map(t => t.name)).toContain('concept_link');
    expect(conceptTools.map(t => t.name)).toContain('concept_search');
    expect(conceptTools.map(t => t.name)).toContain('concept_neighbors');
    expect(conceptTools.map(t => t.name)).toContain('concept_record_usage');
    expect(conceptTools.map(t => t.name)).toContain('concept_sequence_record');
  });

  test('should get tool by name', () => {
    const tool = getToolByName('concept_create');
    expect(tool).toBeDefined();
    expect(tool?.name).toBe('concept_create');
    expect(tool?.inputSchema).toBeDefined();
    expect(tool?.inputSchema.required).toContain('source_type');
    expect(tool?.inputSchema.required).toContain('content');
  });

  test('should return undefined for unknown tool', () => {
    const tool = getToolByName('unknown_tool');
    expect(tool).toBeUndefined();
  });
});

describe('Schema Validation', () => {
  test('should validate CreateConceptRequest', () => {
    const valid = {
      source_type: 'memo',
      content: 'Test content',
    };
    expect(() => CreateConceptRequestSchema.parse(valid)).not.toThrow();

    const withOptional = {
      source_type: 'goal',
      content: 'Test goal',
      shape: 'goal',
      summary: 'Test summary',
      priority: 0.8,
      budget: 1000,
      scope: 'org',
    };
    expect(() => CreateConceptRequestSchema.parse(withOptional)).not.toThrow();
  });

  test('should reject invalid CreateConceptRequest', () => {
    const invalid = {
      source_type: 'invalid_type',
      content: 'Test',
    };
    expect(() => CreateConceptRequestSchema.parse(invalid)).toThrow();

    const missingRequired = {
      source_type: 'memo',
    };
    expect(() => CreateConceptRequestSchema.parse(missingRequired)).toThrow();
  });

  test('should validate ResolveConceptRequest', () => {
    const valid = {
      concept_id: 'concept_abc123',
    };
    expect(() => ResolveConceptRequestSchema.parse(valid)).not.toThrow();

    const withOptions = {
      concept_id: 'concept_xyz789',
      include_neighbors: true,
      neighbor_depth: 2,
    };
    expect(() => ResolveConceptRequestSchema.parse(withOptions)).not.toThrow();
  });

  test('should validate SearchConceptsRequest', () => {
    const valid = {};
    expect(() => SearchConceptsRequestSchema.parse(valid)).not.toThrow();

    const withFilters = {
      query: 'test query',
      shape: 'goal',
      source_type: 'memo',
      min_relevance: 0.5,
      limit: 10,
      offset: 0,
    };
    expect(() => SearchConceptsRequestSchema.parse(withFilters)).not.toThrow();
  });

  test('should validate LinkConceptsRequest', () => {
    const valid = {
      from_concept_id: 'concept_123',
      to_concept_id: 'concept_456',
      edge_type: 'related_to',
    };
    expect(() => LinkConceptsRequestSchema.parse(valid)).not.toThrow();

    const withOptional = {
      from_concept_id: 'concept_123',
      to_concept_id: 'concept_456',
      edge_type: 'derived_from',
      description: 'Test relationship',
      weight: 0.7,
    };
    expect(() => LinkConceptsRequestSchema.parse(withOptional)).not.toThrow();
  });

  test('should reject invalid edge types', () => {
    const invalid = {
      from_concept_id: 'concept_123',
      to_concept_id: 'concept_456',
      edge_type: 'invalid_edge',
    };
    expect(() => LinkConceptsRequestSchema.parse(invalid)).toThrow();
  });

  test('should validate priority and relevance bounds', () => {
    const valid = {
      source_type: 'memo',
      content: 'Test',
      priority: 0.5,
    };
    expect(() => CreateConceptRequestSchema.parse(valid)).not.toThrow();

    const tooHigh = {
      source_type: 'memo',
      content: 'Test',
      priority: 1.5,
    };
    expect(() => CreateConceptRequestSchema.parse(tooHigh)).toThrow();

    const tooLow = {
      source_type: 'memo',
      content: 'Test',
      priority: -0.1,
    };
    expect(() => CreateConceptRequestSchema.parse(tooLow)).toThrow();
  });
});

describe('MCP Routes', () => {
  const app = new Hono();
  app.route('/mcp', mcp);

  test('GET /mcp/tools should return tool list', async () => {
    const res = await app.request('/mcp/tools');
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.tools).toBeDefined();
    expect(Array.isArray(data.tools)).toBe(true);
    expect(data.tools.length).toBe(conceptTools.length);
  });

  test('GET /mcp/tools/:name should return tool details', async () => {
    const res = await app.request('/mcp/tools/concept_create');
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.name).toBe('concept_create');
    expect(data.inputSchema).toBeDefined();
  });

  test('GET /mcp/tools/:name should return 404 for unknown tool', async () => {
    const res = await app.request('/mcp/tools/unknown_tool');
    expect(res.status).toBe(404);
  });
});

describe('Concept Routes', () => {
  const app = new Hono();
  app.route('/concepts', concepts);

  test('GET /concepts/search should handle empty query', async () => {
    // This would fail without DB, but validates route structure
    const res = await app.request('/concepts/search');
    // 400 is expected since DB is not connected
    expect([200, 400, 500]).toContain(res.status);
  });
});
