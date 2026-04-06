/**
 * concept-db: Concept Management Vessel
 *
 * A vessel that manages concepts as impulses with graph relationships.
 * Exposes MCP tools, runs autonomous upkeep activities via Thompson Sampling,
 * and integrates with the impulse/trace learning system.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';

import { config } from './config';
import { logger } from './utils/logger';
import { surrealDB } from './db/surreal';
import { jwtAuthMiddleware } from './middleware/jwtAuth';
import { registerLifecycleHooks } from './lifecycle/hooks';
import { startScheduler, stopScheduler, getSchedulerStatus } from './upkeep/scheduler';
import { VesselHeartbeat } from './vessel-heartbeat';

// Routes
import { mcp } from './routes/mcp';
import { concepts } from './routes/concepts';
import { upkeep } from './routes/upkeep';

const app = new Hono();

// Middleware
app.use('*', cors({
  origin: config.cors.origins,
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

// Request logging (only in development)
if (config.logLevel === 'debug') {
  app.use('*', honoLogger());
}

// JWT authentication middleware
app.use('*', jwtAuthMiddleware);

// Health check
app.get('/health', async (c) => {
  try {
    // Check database connection (INFO FOR DB is valid SurrealDB syntax)
    await surrealDB.query('INFO FOR DB');

    const status = getSchedulerStatus();

    return c.json({
      status: 'healthy',
      service: 'concept-db',
      version: '0.1.0',
      database: 'connected',
      upkeep: {
        scheduler_running: status.running,
        enabled: status.enabled,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const err = error as Error;
    return c.json({
      status: 'unhealthy',
      service: 'concept-db',
      database: 'disconnected',
      error: err.message,
      timestamp: new Date().toISOString(),
    }, 503);
  }
});

// Mount routes
app.route('/mcp', mcp);
app.route('/concepts', concepts);
app.route('/upkeep', upkeep);

// Root endpoint
app.get('/', (c) => {
  return c.json({
    service: 'concept-db',
    version: '0.1.0',
    description: 'Concept management vessel with graph relationships',
    endpoints: {
      health: '/health',
      mcp: {
        tools: '/mcp/tools',
        call: '/mcp/tools/call',
        batch: '/mcp/tools/batch',
      },
      concepts: {
        create: 'POST /concepts',
        fromSource: 'POST /concepts/from-source',
        search: 'GET /concepts/search',
        get: 'GET /concepts/:id',
        resolve: 'POST /concepts/:id/resolve',
        update: 'PATCH /concepts/:id',
        neighbors: 'GET /concepts/:id/neighbors',
        edges: 'GET /concepts/:id/edges',
        link: 'POST /concepts/:id/link',
        usage: 'POST /concepts/:id/usage',
        usageHistory: 'GET /concepts/:id/usage',
        stats: 'GET /concepts/:id/stats',
        sequence: 'GET /concepts/:id/sequence',
        recordSequence: 'POST /concepts/sequences',
      },
      upkeep: {
        status: 'GET /upkeep/status',
        activities: 'GET /upkeep/activities',
        trigger: 'POST /upkeep/trigger',
        start: 'POST /upkeep/scheduler/start',
        stop: 'POST /upkeep/scheduler/stop',
      },
    },
  });
});

// 404 handler
app.notFound((c) => {
  return c.json({
    error: 'Not found',
    path: c.req.path,
  }, 404);
});

// Error handler
app.onError((err, c) => {
  logger.error('Unhandled error', {
    path: c.req.path,
    method: c.req.method,
    error: err.message,
    stack: err.stack,
  });

  return c.json({
    error: 'Internal server error',
    message: err.message,
  }, 500);
});

// Vessel heartbeat instance (global for shutdown)
let vesselHeartbeat: VesselHeartbeat | null = null;

// Startup
async function startup() {
  logger.info('Starting concept-db vessel', {
    port: config.port,
    host: config.host,
    upkeep_enabled: config.upkeep.enabled,
  });

  try {
    // Connect to database
    await surrealDB.connect();
    logger.info('Database connected');

    // Register lifecycle hooks
    registerLifecycleHooks();

    // Start upkeep scheduler
    if (config.upkeep.enabled) {
      startScheduler();
    }

    // Start vessel heartbeat (SPEC-004)
    // Note: This requires JWT token to authenticate with activity-api
    // For now, we'll only start heartbeat if JWT_TOKEN env var is provided
    const jwtToken = process.env.JWT_TOKEN;
    if (jwtToken) {
      const vesselId = process.env.VESSEL_ID || 'concept-db';
      const endpoint = process.env.VESSEL_ENDPOINT || `http://${config.host}:${config.port}`;

      vesselHeartbeat = new VesselHeartbeat({
        vesselId,
        vesselName: 'Concept Database',
        endpoint,
        activityApiUrl: config.activityApi.url,
        jwtToken,
        shapes: ['concept'],
        capabilities: [
          {
            type: 'impulse-resolver',
            shapes: ['concept'],
          },
          {
            type: 'mcp-server',
            mcp: {
              protocol: '2024-11-05',
              tools: ['concept_create', 'concept_resolve', 'concept_link'],
            },
          },
        ],
        ttl: 300, // 5 minutes
      });

      await vesselHeartbeat.start();
      logger.info('Vessel heartbeat started');
    } else {
      logger.warn('JWT_TOKEN not provided, vessel heartbeat disabled');
    }

    logger.info('concept-db vessel started', {
      port: config.port,
      host: config.host,
    });

  } catch (error) {
    const err = error as Error;
    logger.error('Startup failed', { error: err.message });
    process.exit(1);
  }
}

// Shutdown
async function shutdown() {
  logger.info('Shutting down concept-db vessel');

  // Stop vessel heartbeat
  if (vesselHeartbeat) {
    await vesselHeartbeat.stop();
    logger.info('Vessel heartbeat stopped');
  }

  stopScheduler();

  try {
    await surrealDB.close();
    logger.info('Database connection closed');
  } catch (error) {
    logger.warn('Error closing database connection', { error: (error as Error).message });
  }

  process.exit(0);
}

// Signal handlers
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start the server
startup();

export default {
  port: config.port,
  hostname: config.host,
  fetch: app.fetch,
};
