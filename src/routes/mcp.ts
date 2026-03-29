/**
 * MCP Routes
 *
 * Exposes MCP tools interface for concept-db.
 */

import { Hono } from 'hono';
import { conceptTools, getToolByName } from '../tools/definitions';
import { handleToolCall } from '../tools/handler';
import { getJwtAuthFromContext } from '../middleware/jwtAuth';
import { logger } from '../utils/logger';
import { config } from '../config';

const mcp = new Hono();

/**
 * List available tools
 * GET /mcp/tools
 */
mcp.get('/tools', (c) => {
  return c.json({
    tools: conceptTools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  });
});

/**
 * Get tool details
 * GET /mcp/tools/:name
 */
mcp.get('/tools/:name', (c) => {
  const name = c.req.param('name');
  const tool = getToolByName(name);

  if (!tool) {
    return c.json({ error: `Tool not found: ${name}` }, 404);
  }

  return c.json(tool);
});

/**
 * Call a tool
 * POST /mcp/tools/call
 */
mcp.post('/tools/call', async (c) => {
  const jwtAuth = getJwtAuthFromContext(c);

  // Require authentication if configured
  if (config.auth.requireAuth && !jwtAuth) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const orgId = jwtAuth?.orgId || 'default';

  let body: { tool: string; arguments: Record<string, unknown> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { tool, arguments: args } = body;

  if (!tool) {
    return c.json({ error: 'Tool name required' }, 400);
  }

  const toolDef = getToolByName(tool);
  if (!toolDef) {
    return c.json({ error: `Unknown tool: ${tool}` }, 404);
  }

  logger.info('MCP tool call received', {
    tool,
    org_id: orgId,
    has_auth: !!jwtAuth,
  });

  const result = await handleToolCall(tool, args || {}, orgId, jwtAuth?.jwtToken);

  if (!result.success) {
    return c.json({ error: result.error }, 400);
  }

  return c.json({
    tool,
    result: result.result,
  });
});

/**
 * Batch tool calls
 * POST /mcp/tools/batch
 */
mcp.post('/tools/batch', async (c) => {
  const jwtAuth = getJwtAuthFromContext(c);

  if (config.auth.requireAuth && !jwtAuth) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const orgId = jwtAuth?.orgId || 'default';

  let body: { calls: Array<{ tool: string; arguments: Record<string, unknown> }> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.calls || !Array.isArray(body.calls)) {
    return c.json({ error: 'calls array required' }, 400);
  }

  const results = await Promise.all(
    body.calls.map(async (call) => {
      const toolDef = getToolByName(call.tool);
      if (!toolDef) {
        return { tool: call.tool, success: false, error: `Unknown tool: ${call.tool}` };
      }

      const result = await handleToolCall(call.tool, call.arguments || {}, orgId, jwtAuth?.jwtToken);
      return { tool: call.tool, ...result };
    })
  );

  return c.json({ results });
});

export { mcp };
