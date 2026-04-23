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
      const registration: VesselRegistration = {
        vesselId: config.discovery.vesselId,
        vesselName: config.discovery.vesselName,
        version: packageJson.version,
        endpoint: this.getEndpoint(),
        shapes: config.discovery.shapes,
        protocol: 'http',
        metadata: {
          environment: this.detectEnvironment(),
          podId: process.env.HOSTNAME || 'unknown',
          port: config.port,
        },
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
}

export const discoveryClient = DiscoveryClient.getInstance();
