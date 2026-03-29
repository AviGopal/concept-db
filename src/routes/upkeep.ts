/**
 * Upkeep Routes
 *
 * Endpoints for monitoring and triggering upkeep activities.
 */

import { Hono } from 'hono';
import { getJwtAuthFromContext } from '../middleware/jwtAuth';
import { logger } from '../utils/logger';
import { config } from '../config';
import {
  getSchedulerStatus,
  triggerUpkeep,
  startScheduler,
  stopScheduler,
} from '../upkeep/scheduler';
import { upkeepActivities, getUpkeepActivity } from '../upkeep/activities';
import { getActivitySummary } from '../upkeep/thompson';

const upkeep = new Hono();

/**
 * Get scheduler status
 * GET /upkeep/status
 */
upkeep.get('/status', (c) => {
  const status = getSchedulerStatus();
  return c.json(status);
});

/**
 * List available upkeep activities
 * GET /upkeep/activities
 */
upkeep.get('/activities', (c) => {
  const activities = upkeepActivities.map(a => ({
    id: a.id,
    name: a.name,
    description: a.description,
  }));

  const summary = getActivitySummary(upkeepActivities);

  return c.json({
    activities,
    stats: summary,
  });
});

/**
 * Get activity details
 * GET /upkeep/activities/:id
 */
upkeep.get('/activities/:id', (c) => {
  const id = c.req.param('id');
  const activity = getUpkeepActivity(id);

  if (!activity) {
    return c.json({ error: `Activity not found: ${id}` }, 404);
  }

  const summary = getActivitySummary([activity])[0];

  return c.json({
    id: activity.id,
    name: activity.name,
    description: activity.description,
    candidateQuery: activity.candidateQuery,
    stats: summary,
  });
});

/**
 * Trigger upkeep manually
 * POST /upkeep/trigger
 */
upkeep.post('/trigger', async (c) => {
  const jwtAuth = getJwtAuthFromContext(c);

  // Only allow authenticated users to trigger upkeep
  if (config.auth.requireAuth && !jwtAuth) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  logger.info('Manual upkeep trigger requested', {
    org_id: jwtAuth?.orgId,
  });

  try {
    const runs = await triggerUpkeep();
    return c.json({
      triggered: true,
      runs,
    });
  } catch (error) {
    const err = error as Error;
    logger.error('Manual upkeep trigger failed', { error: err.message });
    return c.json({ error: err.message }, 500);
  }
});

/**
 * Start scheduler
 * POST /upkeep/scheduler/start
 */
upkeep.post('/scheduler/start', (c) => {
  const jwtAuth = getJwtAuthFromContext(c);

  if (config.auth.requireAuth && (!jwtAuth || jwtAuth.role !== 'admin')) {
    return c.json({ error: 'Admin authentication required' }, 401);
  }

  startScheduler();
  return c.json({ started: true });
});

/**
 * Stop scheduler
 * POST /upkeep/scheduler/stop
 */
upkeep.post('/scheduler/stop', (c) => {
  const jwtAuth = getJwtAuthFromContext(c);

  if (config.auth.requireAuth && (!jwtAuth || jwtAuth.role !== 'admin')) {
    return c.json({ error: 'Admin authentication required' }, 401);
  }

  stopScheduler();
  return c.json({ stopped: true });
});

export { upkeep };
