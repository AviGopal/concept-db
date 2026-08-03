/**
 * Execution Observer
 *
 * Passive WebSocket client of activity-api. Listens for activity
 * execution events (task.completed, tool.call) across vessels and, when an
 * event references a concept that concept-db owns, records a usage signal
 * via `recordUsage` so the concept's learning metrics reflect cross-vessel
 * activity automatically (no explicit call required).
 *
 * Protocol (from activity-api: src/index.ts + src/websocket/broadcaster.ts):
 *   1. Connect to `${activityApi.url}/ws` (http→ws, https→wss)
 *   2. Send `{type: "authenticate", token: <metabob api key>}` as first
 *      message. Server responds with `{type: "authenticated"}` on success
 *      or closes with code 1008 on failure.
 *   3. On reconnect, send `{type: "catchup", lastSeenSequence: <n>}` to
 *      replay events missed while disconnected.
 *   4. Server broadcasts events with `sequence` field we track to drive
 *      the catchup protocol.
 *
 * Failure posture: never throws out of WS handlers. Logs and continues.
 * If `activityApi.url` is unreachable or `METABOB_API_KEY` is empty, the
 * observer silently disables itself.
 */

import { config } from '../config';
import { logger } from '../utils/logger';
import { recordUsage as defaultRecordUsage } from '../resolvers/usage';
import type { RecordUsageRequest, Outcome } from '../models/schemas';

export interface ImpulseResolutionLike {
  impulse_id?: string;
  resolver_id?: string;
  resolver_tier?: string;
  vessel_id?: string;
  shape?: string;
  concept_id?: string;
  [key: string]: unknown;
}

export interface TaskCompletedEvent {
  type: 'task.completed';
  sequence?: number;
  data: {
    execution_id: string;
    task_id: string;
    task_index?: number;
    success: boolean;
    duration_ms?: number;
    completed_at?: string;
    error?: string;
    // Optional: activity-api may extend broadcasts with these fields.
    activity_id?: string;
    impulse_resolutions?: ImpulseResolutionLike[];
    // Per-task impulse grouping. Activity-api's broadcaster forwards these
    // from the minibob-emitted task object (snake_case canonical wire shape).
    // Bare ID arrays — synthesized to ImpulseResolutionLike[] in
    // `buildUsageRequestsFromTaskCompleted` before concept-ref extraction.
    // See docs/specs/broadcaster-per-task-grouping.md.
    input_impulse_ids?: string[];
    output_impulse_ids?: string[];
  };
}

export interface ToolCallEvent {
  type: 'tool.call';
  sequence?: number;
  data: {
    execution_id: string;
    task_id: string;
    tool_name: string;
    resolver_tier?: string;
    latency_ms?: number;
    cost_usd?: number;
    timestamp?: string;
  };
}

export type ObservedEvent =
  | TaskCompletedEvent
  | ToolCallEvent
  | { type: string; sequence?: number; data?: unknown };

export interface ExecutionObserverOptions {
  orgId?: string;
  // Injected for testability. Defaults to the real `recordUsage` resolver.
  recordUsage?: (
    request: RecordUsageRequest,
    orgId: string,
    jwtToken?: string,
  ) => Promise<unknown>;
}

/**
 * Extract concept IDs referenced in an event's impulse_resolutions. Matches
 * entries where either:
 *   - shape === 'concept', OR
 *   - impulse_id begins with 'concept:' or 'concept_', OR
 *   - concept_id is set explicitly.
 */
export function extractConceptRefs(
  resolutions: ImpulseResolutionLike[] | undefined,
): string[] {
  if (!resolutions || !Array.isArray(resolutions)) return [];
  const ids = new Set<string>();

  for (const r of resolutions) {
    if (!r || typeof r !== 'object') continue;

    if (typeof r.concept_id === 'string' && r.concept_id.length > 0) {
      ids.add(r.concept_id);
      continue;
    }

    if (r.shape === 'concept' && typeof r.impulse_id === 'string') {
      const id = stripConceptPrefix(r.impulse_id);
      if (id) ids.add(id);
      continue;
    }

    if (typeof r.impulse_id === 'string') {
      const id = stripConceptPrefix(r.impulse_id);
      if (id) ids.add(id);
    }
  }

  return [...ids];
}

function stripConceptPrefix(impulseId: string): string | null {
  // Accept `concept:<id>` (used by recordUsage forwarding) and raw `concept_<id>`
  // table-record style identifiers.
  if (impulseId.startsWith('concept:')) {
    const rest = impulseId.slice('concept:'.length);
    return rest.length > 0 ? rest : null;
  }
  if (impulseId.startsWith('concept_')) {
    return impulseId;
  }
  return null;
}

/**
 * Turn a task.completed event into zero or more recordUsage calls.
 * Exported for unit testing; do not instantiate the observer just to test this.
 */
export function buildUsageRequestsFromTaskCompleted(
  event: TaskCompletedEvent,
): RecordUsageRequest[] {
  const { data } = event;
  if (!data) return [];

  // Activity-api's broadcaster forwards bare impulse-ID arrays per-task
  // (`input_impulse_ids` / `output_impulse_ids`). Older / future event
  // emitters may also include the richer `impulse_resolutions` extension
  // point. Synthesize all sources into a single `ImpulseResolutionLike[]`
  // so `extractConceptRefs` remains the single source of truth for
  // concept-ID detection. See docs/specs/broadcaster-per-task-grouping.md.
  const synthesized: ImpulseResolutionLike[] = [
    ...(data.input_impulse_ids ?? []).map((id): ImpulseResolutionLike => ({ impulse_id: id })),
    ...(data.output_impulse_ids ?? []).map((id): ImpulseResolutionLike => ({ impulse_id: id })),
    ...(data.impulse_resolutions ?? []),
  ];

  const conceptIds = extractConceptRefs(synthesized);
  if (conceptIds.length === 0) return [];

  const outcome: Outcome = data.success ? 'success' : 'failure';

  return conceptIds.map((concept_id) => ({
    concept_id,
    trace_id: data.execution_id,
    activity_id: data.activity_id,
    task_id: data.task_id,
    outcome,
  }));
}

export class ExecutionObserver {
  private ws: WebSocket | null = null;
  private shouldRun = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private currentBackoffMs: number;
  private lastSeenSequence: number | null = null;
  private readonly orgId: string;
  private readonly recordUsageFn: NonNullable<
    ExecutionObserverOptions['recordUsage']
  >;

  constructor(options: ExecutionObserverOptions = {}) {
    this.currentBackoffMs = config.observer.reconnectInitialMs;
    // recordUsage currently requires an org_id for the SurrealDB row; when
    // the event doesn't carry one we fall back to 'system'. The forwarded
    // impulse-relevance POST is best-effort.
    this.orgId = options.orgId ?? 'system';
    this.recordUsageFn = options.recordUsage ?? defaultRecordUsage;
  }

  /**
   * Start the observer. Non-blocking: any failure to connect is logged and
   * the reconnect loop takes over. Safe to call from startup().
   */
  start(): void {
    if (!config.observer.enabled) {
      logger.info('[Observer] Disabled via config');
      return;
    }

    if (!config.metabob.apiKey) {
      logger.info('[Observer] METABOB_API_KEY not set; skipping');
      return;
    }

    if (!config.activityApi.url) {
      logger.info('[Observer] ACTIVITY_API_URL not set; skipping');
      return;
    }

    this.shouldRun = true;
    this.connect();
  }

  /**
   * Stop the observer. Idempotent.
   */
  stop(): void {
    this.shouldRun = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      try {
        this.ws.close(1000, 'Observer shutting down');
      } catch (error) {
        logger.warn('[Observer] Error closing socket', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.ws = null;
    }
  }

  /**
   * Compute the next backoff delay and advance internal state.
   * Exported behavior via `getNextBackoffMs` for tests.
   */
  getNextBackoffMs(): number {
    const next = this.currentBackoffMs;
    this.currentBackoffMs = Math.min(
      this.currentBackoffMs * 2,
      config.observer.reconnectMaxMs,
    );
    return next;
  }

  resetBackoff(): void {
    this.currentBackoffMs = config.observer.reconnectInitialMs;
  }

  private buildWsUrl(): string {
    const base = config.activityApi.url;
    // http → ws, https → wss. Preserve anything after the scheme.
    const wsBase = base.replace(/^http(s?):\/\//, 'ws$1://');
    return `${wsBase.replace(/\/$/, '')}/ws`;
  }

  private connect(): void {
    if (!this.shouldRun) return;

    const url = this.buildWsUrl();
    logger.info('[Observer] Connecting', { url });

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (error) {
      logger.warn('[Observer] Failed to construct WebSocket', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.scheduleReconnect();
      return;
    }

    this.ws = ws;

    ws.addEventListener('open', () => {
      logger.info('[Observer] Connected, authenticating');
      this.resetBackoff();
      try {
        ws.send(
          JSON.stringify({
            type: 'authenticate',
            token: config.metabob.apiKey,
          }),
        );
        // If we reconnected and have a last sequence, request catchup. The
        // activity-api only processes catchup after authentication, but
        // server-side it also requires ws.data.authenticated=true; so we send
        // this after authenticate. In practice the server handles messages
        // serially in arrival order, so queuing it immediately is safe.
        if (this.lastSeenSequence !== null) {
          ws.send(
            JSON.stringify({
              type: 'catchup',
              lastSeenSequence: this.lastSeenSequence,
            }),
          );
        }
      } catch (error) {
        logger.warn('[Observer] Failed to send authenticate frame', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    ws.addEventListener('message', (event) => {
      // Never throw: any handler failure just gets logged.
      try {
        const raw = typeof event.data === 'string' ? event.data : String(event.data);
        const parsed = JSON.parse(raw) as ObservedEvent;
        void this.handleEvent(parsed);
      } catch (error) {
        logger.warn('[Observer] Failed to parse or handle event', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    ws.addEventListener('close', (event) => {
      logger.info('[Observer] Disconnected', {
        code: (event as CloseEvent).code,
        reason: (event as CloseEvent).reason,
      });
      this.ws = null;
      this.scheduleReconnect();
    });

    ws.addEventListener('error', (event) => {
      logger.warn('[Observer] Socket error', {
        message: (event as ErrorEvent).message ?? 'unknown',
      });
      // 'close' always follows 'error', so don't double-schedule here.
    });
  }

  private async handleEvent(event: ObservedEvent): Promise<void> {
    if (!event || typeof event !== 'object') return;

    // Track sequence for catchup protocol.
    if (typeof event.sequence === 'number') {
      this.lastSeenSequence = event.sequence;
    }

    switch (event.type) {
      case 'authenticated':
        logger.info('[Observer] Authenticated');
        return;
      case 'auth_error':
        logger.warn('[Observer] Auth rejected', {
          reason: (event as unknown as { message?: string }).message,
        });
        return;
      case 'catchup_complete':
        logger.info('[Observer] Catchup complete');
        return;
      case 'pong':
        return;
      case 'task.completed':
        await this.handleTaskCompleted(event as TaskCompletedEvent);
        return;
      case 'tool.call':
        this.handleToolCall(event as ToolCallEvent);
        return;
      default:
        // Other broadcast types (execution_started, template_updated, etc.)
        // are not relevant to concept learning yet.
        return;
    }
  }

  private async handleTaskCompleted(event: TaskCompletedEvent): Promise<void> {
    const requests = buildUsageRequestsFromTaskCompleted(event);
    if (requests.length === 0) return;

    for (const req of requests) {
      try {
        await this.recordUsageFn(req, this.orgId);
        logger.debug('[Observer] Recorded passive usage', {
          concept_id: req.concept_id,
          trace_id: req.trace_id,
          outcome: req.outcome,
        });
      } catch (error) {
        // Don't let one bad row abort the rest. Concept might not exist
        // locally, the DB might be transiently down, etc.
        logger.warn('[Observer] recordUsage failed', {
          concept_id: req.concept_id,
          trace_id: req.trace_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private handleToolCall(event: ToolCallEvent): void {
    // Phase 2: extract concept references from tool arguments. For now,
    // just log so traces are visible during canary validation.
    logger.debug('[Observer] tool.call', {
      execution_id: event.data?.execution_id,
      task_id: event.data?.task_id,
      tool_name: event.data?.tool_name,
      resolver_tier: event.data?.resolver_tier,
    });
  }

  private scheduleReconnect(): void {
    if (!this.shouldRun) return;
    if (this.reconnectTimer) return;

    const delay = this.getNextBackoffMs();
    logger.info('[Observer] Reconnecting in', { delay });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
