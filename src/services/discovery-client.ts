/**
 * Discovery Vessel Client (concept-db)
 *
 * Manages registration, heartbeat, and deregistration with discovery-vessel.
 * Adapted from metabob-activity-api's discovery-client:
 *   - Advertises concept-db's shapes (concept, conceptGraph, relatedConcepts,
 *     conceptUsageStats, conceptSequence).
 *   - Authenticates with discovery-vessel using the Metabob API key
 *     (`Authorization: ApiKey <key>`) per CLAUDE.md. Auth is only attached
 *     when `METABOB_API_KEY` is set.
 *   - Non-blocking startup: registration/heartbeat failures are logged; the
 *     vessel keeps running (graceful degradation).
 *   - Exponential-backoff retry for transient failures.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';
import packageJson from '../../package.json';

interface VesselRegistration {
  vesselId: string;
  vesselName: string;
  version: string;
  endpoint: string;
  shapes: string[];
  protocol?: string;
  metadata?: Record<string, unknown>;
  // Resolver contract (Wave 1B, 2026-04-23). Optional fields describing how
  // callers should invoke this vessel's impulse resolver. discovery-vessel
  // (Wave 1A) persists these; minibob (Wave 1D) will consume them to drop
  // hardcoded per-vessel logic. Field names must match discovery-vessel's
  // RegistrationRequest exactly — concept-db registers over HTTP and does
  // not import that type.
  resolve_endpoint?: string;
  resolve_request_format?: string;
  auth_scheme?: string;
  resolve_timeout_ms?: number;
  // Auth token source (Wave A3, 2026-04-23, forward-mode only). Mirrors the
  // contract field on discovery-vessel's RegistrationRequest. Concept-db
  // tenants by the caller's `$auth.org_id`, so caller_identity is the
  // correct credential — see super-repo `docs/specs/auth-token-source-field.md`.
  auth_token_source?: string;
  auth_delegation_mode?: string;
  // Shared-infrastructure flag: when true, vessel is visible in ALL
  // org-scoped discovery queries regardless of which orgId sent the request.
  // Concept-db is shared infrastructure (same instance serves all tenants),
  // so it must be reachable from any org's impulse resolution path.
  systemVessel?: boolean;
}

interface RegisterResponse {
  success: boolean;
  vesselId: string;
  expiresAt: number;
}

interface HeartbeatResponse {
  success: boolean;
  nextHeartbeatMs: number;
}

export class DiscoveryClient {
  private static instance: DiscoveryClient | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private registered: boolean = false;
  private registrationAttempts: number = 0;
  private lastError: string | null = null;

  private constructor() {}

  static getInstance(): DiscoveryClient {
    if (!DiscoveryClient.instance) {
      DiscoveryClient.instance = new DiscoveryClient();
    }
    return DiscoveryClient.instance;
  }

  isEnabled(): boolean {
    return config.discovery.enabled;
  }

  isRegistered(): boolean {
    return this.registered;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  /**
   * Register this vessel with discovery-vessel. Non-throwing: returns false
   * on failure and records the error for diagnostics.
   */
  async register(): Promise<boolean> {
    if (!this.isEnabled()) {
      logger.debug('[Discovery] Registration skipped (disabled)');
      return false;
    }

    this.registrationAttempts++;

    try {
      // Phase 23 task 3.1-3.2: shape-dispatch agreement check + shape filtering.
      const { unhandledAdvertised, orphanHandlers } = this.checkShapeDispatchAgreement();
      if (unhandledAdvertised.length > 0) {
        logger.error('[Discovery] Shape-dispatch agreement violation: advertised shapes missing dispatch handlers', {
          validator_id: 'shape-dispatch-agreement',
          unhandledAdvertised,
        });
      }
      if (orphanHandlers.length > 0) {
        logger.warn('[Discovery] Shape-dispatch agreement: dispatch handlers not advertised', {
          validator_id: 'shape-dispatch-agreement',
          orphanHandlers,
        });
      }
      // TODO (task 3.3): emit failure_mode.type="verifier_negative" trace.
      const safeShapes = unhandledAdvertised.length > 0
        ? config.discovery.shapes.filter(s => !unhandledAdvertised.includes(s))
        : config.discovery.shapes;

      const registration: VesselRegistration = {
        vesselId: config.discovery.vesselId,
        vesselName: config.discovery.vesselName,
        version: packageJson.version,
        endpoint: this.getEndpoint(),
        shapes: safeShapes,
        protocol: 'http',
        metadata: {
          environment: this.detectEnvironment(),
          podId: process.env.HOSTNAME || 'unknown',
          port: config.port,
        },
        // Resolver contract — tells callers (e.g. minibob) how to invoke
        // this vessel's impulse resolver without hardcoded per-vessel
        // knowledge. See src/routes/impulses.ts for the implementation.
        // Timeout is 10s: resolveConcept performs up to ~5 sequential
        // SurrealDB round-trips (fetch root, outgoing edges, incoming
        // edges, update, neighbor fetch) plus optional graph walks on
        // larger shapes; 5s is occasionally tight under cold-cache load.
        resolve_endpoint: '/v2/impulses/resolve',
        resolve_request_format: 'pointer',
        auth_scheme: 'ApiKey',
        resolve_timeout_ms: 10000,
        // Auth token source (Wave A3, 2026-04-23). Concept-db's
        // PERMISSIONS clauses tenant by `$auth.org_id` from the caller's
        // service identity, so caller_identity is the correct credential.
        // Forward-mode delegation is the default and is harmless for
        // caller_identity vessels (the field is meaningful for
        // user_identity only); we advertise it explicitly anyway so
        // downstream behavior is fully described.
        auth_token_source: 'caller_identity',
        auth_delegation_mode: 'forward',
        // Shared-infrastructure: concept-db serves all tenants from one
        // instance. Marking systemVessel=true ensures it appears in
        // org-scoped discovery queries even when the caller's orgId differs
        // from the orgId embedded in the registration credential. Without
        // this flag, callers from other orgs receive empty results.
        systemVessel: true,
      };

      logger.info('[Discovery] Registering vessel', {
        vesselId: registration.vesselId,
        endpoint: registration.endpoint,
        shapes: registration.shapes,
      });

      const response = await this.retryRequest<RegisterResponse>(
        'POST',
        '/register',
        registration
      );

      if (response.success) {
        this.registered = true;
        this.registrationAttempts = 0;
        this.lastError = null;

        logger.info('[Discovery] Vessel registered successfully', {
          vesselId: response.vesselId,
          expiresAt: new Date(response.expiresAt).toISOString(),
        });

        return true;
      }

      throw new Error('Registration failed: success=false');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.lastError = errorMsg;

      logger.warn('[Discovery] Registration failed', {
        attempt: this.registrationAttempts,
        error: errorMsg,
      });

      this.registered = false;
      return false;
    }
  }

  /**
   * Send heartbeat to discovery-vessel. If heartbeat fails, mark as
   * unregistered so the next tick attempts re-registration.
   */
  async heartbeat(): Promise<boolean> {
    if (!this.isEnabled() || !this.registered) {
      return false;
    }

    try {
      const response = await this.retryRequest<HeartbeatResponse>(
        'POST',
        '/heartbeat',
        { vesselId: config.discovery.vesselId }
      );

      if (response.success) {
        logger.debug('[Discovery] Heartbeat sent', {
          nextHeartbeatMs: response.nextHeartbeatMs,
        });
        return true;
      }

      throw new Error('Heartbeat failed: success=false');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.lastError = errorMsg;

      logger.warn('[Discovery] Heartbeat failed', { error: errorMsg });

      // Heartbeat failure likely means vessel expired in registry. Trigger
      // re-registration on the next tick.
      this.registered = false;
      return false;
    }
  }

  /**
   * Deregister this vessel from discovery-vessel (graceful shutdown).
   */
  async deregister(): Promise<boolean> {
    if (!this.isEnabled() || !this.registered) {
      return false;
    }

    try {
      const vesselId = config.discovery.vesselId;
      logger.info('[Discovery] Deregistering vessel', { vesselId });

      await this.retryRequest<{ success: boolean }>(
        'DELETE',
        `/vessels/${vesselId}`,
        undefined
      );

      this.registered = false;
      this.lastError = null;
      logger.info('[Discovery] Vessel deregistered successfully');
      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.lastError = errorMsg;

      logger.warn('[Discovery] Deregistration failed', { error: errorMsg });
      return false;
    }
  }

  /**
   * Start heartbeat loop. Ticks on `heartbeatIntervalMs`; if not registered,
   * attempts registration instead of heartbeat.
   */
  startHeartbeatManager(): void {
    if (!this.isEnabled()) {
      logger.debug('[Discovery] Heartbeat manager not started (disabled)');
      return;
    }

    if (this.heartbeatTimer) {
      logger.warn('[Discovery] Heartbeat manager already running');
      return;
    }

    logger.info('[Discovery] Starting heartbeat manager', {
      intervalMs: config.discovery.heartbeatIntervalMs,
    });

    this.heartbeatTimer = setInterval(async () => {
      if (!this.registered) {
        await this.register();
      } else {
        await this.heartbeat();
      }
    }, config.discovery.heartbeatIntervalMs);
  }

  /**
   * Stop heartbeat loop (does not deregister).
   */
  stopHeartbeatManager(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      logger.info('[Discovery] Heartbeat manager stopped');
    }
  }

  /**
   * Graceful shutdown: stop heartbeat and deregister.
   */
  async shutdown(): Promise<void> {
    logger.info('[Discovery] Shutting down discovery client');
    this.stopHeartbeatManager();
    await this.deregister();
  }

  /**
   * HTTP request with exponential-backoff retry.
   */
  private async retryRequest<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${config.discovery.endpoint}${path}`;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= config.discovery.retryAttempts; attempt++) {
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };

        // Attach API key when available. Per super-repo CLAUDE.md, auth is
        // `Authorization: ApiKey <key>`, not Bearer/JWT.
        if (config.metabob.apiKey) {
          headers['Authorization'] = `ApiKey ${config.metabob.apiKey}`;
        }

        const options: RequestInit = { method, headers };
        if (body !== undefined) {
          options.body = JSON.stringify(body);
        }

        const response = await fetch(url, options);

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        return (await response.json()) as T;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < config.discovery.retryAttempts) {
          const backoffMs =
            config.discovery.retryBackoffMs * Math.pow(2, attempt);
          logger.debug('[Discovery] Request failed, retrying', {
            attempt: attempt + 1,
            maxAttempts: config.discovery.retryAttempts,
            backoffMs,
            error: lastError.message,
          });
          await this.sleep(backoffMs);
        }
      }
    }

    throw lastError || new Error('Request failed after retries');
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get this vessel's externally-reachable endpoint. Prefers explicit
   * `VESSEL_ENDPOINT` env var; falls back to in-cluster service DNS.
   */
  private getEndpoint(): string {
    if (process.env.VESSEL_ENDPOINT) {
      return process.env.VESSEL_ENDPOINT;
    }

    const namespace = process.env.SURREALDB_NAMESPACE || 'activity-system';
    const serviceName = process.env.SERVICE_NAME || 'concept-db';
    const port = config.port;

    return `http://${serviceName}.${namespace}.svc.cluster.local:${port}`;
  }

  private detectEnvironment(): 'k8s-cluster' | 'docker' | 'local' {
    if (process.env.KUBERNETES_SERVICE_HOST) {
      return 'k8s-cluster';
    }
    if (process.env.DOCKER_CONTAINER) {
      return 'docker';
    }
    return 'local';
  }

  /**
   * Check shape-dispatch agreement at startup (task 3.1-3.2, Phase 23).
   * Mirrors packages/shape-dispatch-check/check.ts inline so this works inside
   * Docker without the super-repo present.
   */
  private checkShapeDispatchAgreement(): {
    unhandledAdvertised: string[];
    orphanHandlers: string[];
  } {
    try {
      const vesselRoot = resolve(import.meta.dir, '..', '..');
      const configPath = join(vesselRoot, 'src', 'config.ts');
      const dispatchPath = join(vesselRoot, 'src', 'routes', 'impulses.ts');

      if (!existsSync(configPath) || !existsSync(dispatchPath)) {
        return { unhandledAdvertised: [], orphanHandlers: [] };
      }

      const configSrc = readFileSync(configPath, 'utf8');
      const dispatchSrc = readFileSync(dispatchPath, 'utf8');

      const advertised = new Set<string>();
      const shapeArrayPattern = /(?:shapes|advertised_shapes|ADVERTISED_SHAPES)\s*[:=]\s*\[/;
      let inArray = false;
      let depth = 0;
      for (const line of configSrc.split('\n')) {
        if (!inArray) {
          if (shapeArrayPattern.test(line)) {
            inArray = true;
            for (const ch of line) {
              if (ch === '[') depth++;
              else if (ch === ']') depth--;
            }
            if (depth <= 0) inArray = false;
            for (const m of line.matchAll(/['"]([^'"]+)['"]/g)) advertised.add(m[1]);
          }
          continue;
        }
        let nd = depth;
        for (const ch of line) {
          if (ch === '[') nd++;
          else if (ch === ']') nd--;
        }
        if (nd <= 0) {
          const seg = line.slice(0, line.lastIndexOf(']') >= 0 ? line.lastIndexOf(']') : line.length);
          for (const m of seg.matchAll(/['"]([^'"]+)['"]/g)) advertised.add(m[1]);
          inArray = false;
          depth = 0;
        } else {
          depth = nd;
          const stripped = line.replace(/\/\/.*$/, '');
          for (const m of stripped.matchAll(/['"]([^'"]+)['"]/g)) advertised.add(m[1]);
        }
      }

      const dispatched = new Map<string, boolean>();
      const dlines = dispatchSrc.split('\n');
      for (let i = 0; i < dlines.length; i++) {
        const m = /^\s*case\s+(['"])([^'"]+)\1\s*:/.exec(dlines[i]);
        if (!m) continue;
        let isPrivate = false;
        for (let j = i - 1; j >= 0; j--) {
          const prev = dlines[j].trim();
          if (prev === '') continue;
          if (prev.includes('@shape-dispatch:private')) { isPrivate = true; break; }
          if (/^case\s+['"]/.test(prev)) continue;
          break;
        }
        dispatched.set(m[2], isPrivate);
      }

      const unhandledAdvertised = [...advertised].filter(s => !dispatched.has(s));
      const orphanHandlers = [...dispatched.entries()]
        .filter(([, priv]) => !priv)
        .map(([s]) => s)
        .filter(s => !advertised.has(s));

      return { unhandledAdvertised, orphanHandlers };
    } catch {
      return { unhandledAdvertised: [], orphanHandlers: [] };
    }
  }
}

export const discoveryClient = DiscoveryClient.getInstance();
