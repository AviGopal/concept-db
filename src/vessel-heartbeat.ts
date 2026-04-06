/**
 * Vessel Heartbeat (SPEC-004 Integration)
 *
 * Registers concept-db with the vessel registry and sends periodic heartbeats
 * to maintain active status.
 */

import { logger } from './utils/logger';
import { config } from './config';

export class VesselHeartbeat {
  private vesselId: string;
  private vesselName: string;
  private endpoint: string;
  private activityApiUrl: string;
  private jwtToken: string;
  private ttl: number = 300; // 5 minutes
  private intervalId: NodeJS.Timeout | null = null;
  private shapes: string[];
  private capabilities: any[];

  constructor(options: {
    vesselId: string;
    vesselName: string;
    endpoint: string;
    activityApiUrl: string;
    jwtToken: string;
    shapes: string[];
    capabilities?: any[];
    ttl?: number;
  }) {
    this.vesselId = options.vesselId;
    this.vesselName = options.vesselName;
    this.endpoint = options.endpoint;
    this.activityApiUrl = options.activityApiUrl;
    this.jwtToken = options.jwtToken;
    this.shapes = options.shapes;
    this.capabilities = options.capabilities || [];
    this.ttl = options.ttl || 300;
  }

  /**
   * Start heartbeat loop
   */
  async start(): Promise<void> {
    // Initial registration
    await this.register();

    // Re-register every TTL/2 seconds
    this.intervalId = setInterval(
      () => this.register(),
      (this.ttl / 2) * 1000
    );

    logger.info('[VesselHeartbeat] Started', {
      vesselId: this.vesselId,
      intervalSeconds: this.ttl / 2,
    });
  }

  /**
   * Stop heartbeat loop and unregister
   */
  async stop(): Promise<void> {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    // Unregister on graceful shutdown
    await this.unregister();

    logger.info('[VesselHeartbeat] Stopped', {
      vesselId: this.vesselId,
    });
  }

  /**
   * Register/heartbeat with vessel registry
   */
  private async register(): Promise<void> {
    try {
      const response = await fetch(
        `${this.activityApiUrl}/v2/vessels/register`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.jwtToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            vesselId: this.vesselId,
            vesselName: this.vesselName,
            endpoint: this.endpoint,
            shapes: this.shapes,
            capabilities: this.capabilities,
            metadata: this.getMetadata(),
            ttl: this.ttl,
          }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('[VesselHeartbeat] Registration failed', {
          status: response.status,
          error: errorText,
        });
        return;
      }

      const { expires_at } = await response.json();
      logger.debug('[VesselHeartbeat] Heartbeat OK', {
        vesselId: this.vesselId,
        expiresAt: expires_at,
      });

    } catch (error) {
      logger.error('[VesselHeartbeat] Registration error', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't crash - continue trying on next interval
    }
  }

  /**
   * Unregister from vessel registry
   */
  private async unregister(): Promise<void> {
    try {
      await fetch(`${this.activityApiUrl}/v2/vessels/${this.vesselId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${this.jwtToken}` },
      });

      logger.info('[VesselHeartbeat] Unregistered', {
        vesselId: this.vesselId,
      });
    } catch (error) {
      logger.error('[VesselHeartbeat] Unregister error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get vessel metadata for registration
   */
  private getMetadata(): Record<string, any> {
    return {
      version: '0.1.0', // TODO: Get from package.json
      environment: config.environment || process.env.NODE_ENV || 'development',
      uptime_seconds: Math.floor(process.uptime()),
    };
  }
}
