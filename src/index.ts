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
import { discoveryClient } from './services/discovery-client';
import { ExecutionObserver } from './services/execution-observer';
import { embeddingService } from './services/embedding';

// Passive listener for activity-api execution events. Constructed at module
// load; lifecycle is driven by startup()/shutdown().
const executionObserver = new ExecutionObserver();

// Routes
import { mcp } from './routes/mcp';
import { concepts } from './routes/concepts';
import { upkeep } from './routes/upkeep';
import { impulses } from './routes/impulses';

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
      embedding: embeddingService.getStatus(),
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
app.route('/v2/impulses', impulses);

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
      impulses: {
        resolve: 'POST /v2/impulses/resolve',
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

    // Discovery-vessel registration (replaces deprecated /v2/vessels/register).
    // Non-blocking: failures log and continue; the vessel keeps serving
    // requests even if discovery-vessel is unreachable.
    if (discoveryClient.isEnabled()) {
      discoveryClient.register()
        .then((success) => {
          if (success) {
            logger.info('[Discovery] Initial registration successful');
          } else {
            logger.warn('[Discovery] Initial registration failed (will retry)');
          }
        })
        .catch((error) => {
          logger.error('[Discovery] Initial registration error', {
            error: error instanceof Error ? error.message : String(error),
          });
        });

      discoveryClient.startHeartbeatManager();
    } else {
      logger.info('[Discovery] Discovery integration disabled');
    }

    // Start passive execution observer (WebSocket client of activity-api).
    // Non-blocking: `start()` logs and bails if disabled or misconfigured,
    // and the reconnect loop handles transient activity-api outages.
    try {
      executionObserver.start();
    } catch (error) {
      logger.warn('[Observer] Failed to start', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    logger.info('concept-db vessel started', {
      port: config.port,
      host: config.host,
    });

    // Non-blocking: init local embedding model then optionally backfill
    embeddingService.init().then(async () => {
      if (!embeddingService.isReady()) return;

      const backfillEnabled = process.env.DENSE_BACKFILL_ENABLED !== 'false';
      if (!backfillEnabled) {
        logger.info('[LocalEmbedding] Backfill disabled (DENSE_BACKFILL_ENABLED=false)');
        return;
      }

      logger.info('[LocalEmbedding] Starting backfill for concepts without embeddings');
      let offset = 0;
      const batchSize = 50;
      let totalProcessed = 0;

      for (;;) {
        let rows: any[];
        try {
          rows = await surrealDB.query<any>(
            `SELECT id, content, summary FROM concept WHERE content_embedding IS NONE LIMIT $limit START $offset`,
            { limit: batchSize, offset }
          );
        } catch (err) {
          logger.warn('[LocalEmbedding] Backfill query failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          break;
        }

        if (!rows || rows.length === 0) break;

        for (const row of rows) {
          try {
            const rawId = typeof row.id === 'object' ? JSON.stringify(row.id) : String(row.id);
            const plainId = rawId.replace(/[⟨⟩`"]/g, '').replace(/^concept:/, '');
            const updates: Record<string, unknown> = {};
            if (row.content) {
              const vec = await embeddingService.embed(String(row.content).slice(0, 2000));
              updates.content_embedding = Array.from(vec);
            }
            const summaryText = row.summary || String(row.content || '').slice(0, 200);
            if (summaryText) {
              const vec = await embeddingService.embed(summaryText);
              updates.summary_embedding = Array.from(vec);
            }
            if (Object.keys(updates).length === 0) {
              totalProcessed++;
              continue;
            }
            const setClause = Object.keys(updates).map((k) => `${k} = $${k}`).join(', ');
            await surrealDB.query(
              `UPDATE type::thing("concept", $id) SET ${setClause}`,
              { id: plainId, ...updates }
            );
            totalProcessed++;
            if (totalProcessed % 250 === 0) {
              logger.info('[LocalEmbedding] Backfill progress', { totalProcessed });
            }
          } catch (err) {
            logger.warn('[LocalEmbedding] Backfill row failed, skipping', {
              id: row.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        offset += batchSize;
        if (rows.length < batchSize) break;
      }

      logger.info('[LocalEmbedding] Backfill complete', { totalProcessed });
    }).catch((err) => {
      logger.error('[LocalEmbedding] Unexpected error during init/backfill', {
        error: err instanceof Error ? err.message : String(err),
      });
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

  // Stop observer before discovery deregistration so the ws loop doesn't
  // try to reconnect during teardown.
  try {
    executionObserver.stop();
  } catch (error) {
    logger.warn('[Observer] Error during shutdown', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Deregister from discovery-vessel and stop heartbeats.
  try {
    await discoveryClient.shutdown();
  } catch (error) {
    logger.warn('[Discovery] Error during shutdown', {
      error: error instanceof Error ? error.message : String(error),
    });
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
