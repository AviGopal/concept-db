/**
 * Configuration module for concept-db
 * Loads environment variables and provides typed configuration
 */

export interface Config {
  port: number;
  host: string;

  // Database
  surrealdb: {
    url: string;
    namespace: string;
    database: string;
    username: string;
    password: string;
  };

  // Redis
  redis: {
    url: string;
    ttl: {
      concept: number;      // Concept cache TTL in seconds
      resolution: number;   // Resolution snapshot TTL
      neighbors: number;    // Neighbors cache TTL
    };
  };

  // Activity API (for trace recording and learning)
  activityApi: {
    url: string;
    timeout: number;
  };

  // Metabob credentials (shared across Metabob-managed services)
  metabob: {
    apiKey: string;
    identityEndpoint: string;
  };

  // Passive execution observer (WebSocket client of activity-api)
  observer: {
    enabled: boolean;
    reconnectInitialMs: number;
    reconnectMaxMs: number;
  };

  // Discovery Vessel Integration
  discovery: {
    enabled: boolean;
    endpoint: string;
    vesselId: string;
    vesselName: string;
    heartbeatIntervalMs: number;
    retryAttempts: number;
    retryBackoffMs: number;
    shapes: string[];
  };

  // Upkeep scheduler
  upkeep: {
    intervalMs: number;     // How often to run upkeep (default: 5 minutes)
    batchSize: number;      // Max concepts to process per run
    enabled: boolean;       // Enable/disable upkeep scheduler
  };

  // Security
  auth: {
    requireAuth: boolean;
  };

  // Logging
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logFormat: 'json' | 'text';

  // CORS
  cors: {
    origins: string[];
  };

  // Environment
  environment?: string;
}

function parseEnvInt(key: string, defaultValue: number): number {
  const value = process.env[key];
  return value ? parseInt(value, 10) : defaultValue;
}

function parseEnvBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

/**
 * Generates vessel ID from environment variables.
 * Uses VESSEL_ID if set, otherwise generates from hostname/pod name.
 */
function generateVesselId(): string {
  if (process.env.VESSEL_ID) {
    return process.env.VESSEL_ID;
  }

  const hostname = process.env.HOSTNAME || 'concept-db';
  const podName = process.env.POD_NAME || hostname;

  return `concept-db-${podName}`;
}

/**
 * Validates SurrealDB namespace format
 * Returns a default for testing environments
 */
function validateNamespace(ns: string | undefined): string {
  // Allow tests to run without env var
  if (!ns) {
    if (process.env.NODE_ENV === 'test' || process.env.BUN_ENV === 'test') {
      return 'test-namespace';
    }
    throw new Error('SURREALDB_NAMESPACE environment variable is required.');
  }

  if (!/^[a-z0-9_-]+$/i.test(ns)) {
    throw new Error(`Invalid namespace format: "${ns}". Must contain only alphanumeric characters, underscores, and hyphens.`);
  }

  return ns;
}

export function loadConfig(): Config {
  return {
    port: parseEnvInt('PORT', 8081),
    host: process.env.HOST || '0.0.0.0',

    surrealdb: {
      url: process.env.SURREALDB_URL || 'http://localhost:8000',
      namespace: validateNamespace(process.env.SURREALDB_NAMESPACE),
      database: process.env.SURREALDB_DATABASE || 'learning_loop',
      // Use 'NONE' to explicitly skip authentication (for SurrealDB with auth: false)
      // Empty string also means skip auth
      username: process.env.SURREALDB_USERNAME || '',
      password: process.env.SURREALDB_PASSWORD || '',
    },

    redis: {
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      ttl: {
        concept: parseEnvInt('REDIS_CONCEPT_TTL', 3600),       // 1 hour
        resolution: parseEnvInt('REDIS_RESOLUTION_TTL', 1800), // 30 minutes
        neighbors: parseEnvInt('REDIS_NEIGHBORS_TTL', 600),    // 10 minutes
      },
    },

    activityApi: {
      url: process.env.ACTIVITY_API_URL || 'http://metabob-activity-api:8080',
      timeout: parseEnvInt('ACTIVITY_API_TIMEOUT', 30000),
    },

    metabob: {
      apiKey: process.env.METABOB_API_KEY || '',
      identityEndpoint:
        process.env.IDENTITY_VESSEL_URL ||
        'http://identity-vessel.activity-system.svc.cluster.local:8080',
    },

    observer: {
      enabled: parseEnvBool('OBSERVER_ENABLED', true),
      reconnectInitialMs: parseEnvInt('OBSERVER_RECONNECT_INITIAL_MS', 1000),
      reconnectMaxMs: parseEnvInt('OBSERVER_RECONNECT_MAX_MS', 30000),
    },

    discovery: {
      enabled: parseEnvBool('DISCOVERY_ENABLED', true),
      endpoint:
        process.env.DISCOVERY_VESSEL_ENDPOINT ||
        'http://discovery-vessel.activity-system.svc.cluster.local:8080',
      vesselId: generateVesselId(),
      vesselName: process.env.VESSEL_NAME || 'concept-db',
      heartbeatIntervalMs: parseEnvInt('DISCOVERY_HEARTBEAT_INTERVAL_MS', 60000),
      retryAttempts: parseEnvInt('DISCOVERY_RETRY_ATTEMPTS', 3),
      retryBackoffMs: parseEnvInt('DISCOVERY_RETRY_BACKOFF_MS', 1000),
      // Shapes advertised to discovery-vessel. Must match cases in
      // src/routes/impulses.ts. Don't advertise shapes without a dispatch case.
      shapes: [
        'concept',
        'conceptGraph',
        'relatedConcepts',
        'conceptUsageStats',
        'conceptSequence',
        'impulseSignatureConcept',
        'impulseCooccurrenceEdges',
        // Write shapes (per docs/specs/impulse-write-resolver.md). All dispatch
        // through `POST /v2/impulses/resolve` and emit a `conceptUpkeepAuditLog`
        // impulse to concept-db's `impulse` table.
        // concept_write: unified from-source path; preferred for MiniBob seeding.
        'concept_write',
        'concept_create_write',
        'conceptLink_write',
        'conceptSignatureUpsert_write',
        'conceptUsage_write',
        'conceptSequence_write',
        // Audit-log shape (read-only via the `impulse` table). Advertised so
        // callers can resolve audit logs by id/org without going through MCP.
        'conceptUpkeepAuditLog',
        // mcpTool: per docs/specs/discovery-to-tools-bridge.md. Vessels that
        // own MCP tools advertise this shape; the resolver returns a list of
        // tool impulses scored against the request's task context. Each
        // returned tool impulse carries the vessel binding so consumers can
        // dispatch via /mcp/tools/call without per-vessel client code.
        'mcpTool',
      ],
    },

    upkeep: {
      intervalMs: parseEnvInt('UPKEEP_INTERVAL_MS', 300000), // 5 minutes
      batchSize: parseEnvInt('UPKEEP_BATCH_SIZE', 50),
      enabled: parseEnvBool('UPKEEP_ENABLED', true),
    },

    auth: {
      requireAuth: parseEnvBool('REQUIRE_AUTH', false),
    },

    logLevel: (process.env.LOG_LEVEL || 'info') as Config['logLevel'],
    logFormat: (process.env.LOG_FORMAT || 'text') as Config['logFormat'],

    cors: {
      origins: process.env.CORS_ORIGINS?.split(',') || ['*'],
    },

    environment: process.env.NODE_ENV || process.env.ENVIRONMENT,
  };
}

export const config = loadConfig();
