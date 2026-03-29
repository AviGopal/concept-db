/**
 * MiniBob Integration
 *
 * This file shows how MiniBob would register concept-db as a resolver.
 * Copy this into MiniBob's startup or vessel-bootstrap.ts.
 *
 * Usage in MiniBob:
 *
 *   import { registerConceptResolver } from "@metabob/concept-db/integration"
 *   registerConceptResolver("http://concept-db:8081")
 *
 * Then create concept impulses:
 *
 *   createImpulse({
 *     id: "context-goal",
 *     pointer: {
 *       type: "concept",
 *       concept_id: "concept_abc123",
 *       include_neighbors: true,
 *     },
 *     budget: 2000,
 *     priority: "high",
 *   })
 */

import { registerResolver } from "../../../minibob/src/impulse"
import type { ImpulseMetadata, ResolverResult } from "../../../minibob/src/types"

export interface ConceptPointer {
  type: "concept"
  concept_id: string
  include_neighbors?: boolean
  neighbor_depth?: number
}

export interface ConceptResolverConfig {
  endpoint: string
  timeout?: number
  jwtToken?: string  // For authenticated requests
}

/**
 * Register concept-db as an impulse resolver in MiniBob
 */
export function registerConceptResolver(config: ConceptResolverConfig | string): void {
  const cfg = typeof config === "string" ? { endpoint: config } : config;

  registerResolver("concept", async (pointer: Record<string, unknown>): Promise<ResolverResult> => {
    const conceptPointer = pointer as unknown as ConceptPointer;

    const response = await fetch(`${cfg.endpoint}/mcp/tools/call`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.jwtToken ? { "Authorization": `Bearer ${cfg.jwtToken}` } : {}),
      },
      body: JSON.stringify({
        tool: "concept_resolve",
        arguments: {
          concept_id: conceptPointer.concept_id,
          include_neighbors: conceptPointer.include_neighbors ?? false,
          neighbor_depth: conceptPointer.neighbor_depth ?? 1,
        },
      }),
      signal: AbortSignal.timeout(cfg.timeout ?? 30000),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`concept-db resolution failed: ${error}`);
    }

    const { result } = await response.json() as {
      result: {
        concept: {
          id: string;
          content: string;
          summary: string;
          shape: string;
          source_type: string;
          relevance: number;
          resolution_snapshot: {
            neighbor_ids: string[];
            token_count: number;
          };
        };
        neighbors?: Array<{
          id: string;
          summary: string;
          shape: string;
        }>;
      };
    };

    // Build metadata for pointer-mode display
    const metadata: ImpulseMetadata = {
      shape: result.concept.shape,
      summary: result.concept.summary,
      rowCount: result.neighbors?.length ?? 0,
      availableOps: ["resolve", "link", "record_usage"],
    };

    // Include neighbor summaries if present
    if (result.neighbors && result.neighbors.length > 0) {
      metadata.sample = result.neighbors.map(n => ({
        id: n.id,
        summary: n.summary,
        shape: n.shape,
      }));
    }

    return {
      content: result.concept.content || result.concept.summary || "",
      metadata,
    };
  });

  console.log(`[concept-db] Registered concept resolver at ${cfg.endpoint}`);
}

/**
 * Create a concept from MiniBob execution output
 *
 * Call this after successful task execution to create concepts from outputs.
 */
export async function createConceptFromOutput(
  config: ConceptResolverConfig,
  params: {
    source_type: "extracted" | "llm" | "write" | "read";
    content: string;
    summary?: string;
    priority?: number;
  }
): Promise<string> {
  const cfg = typeof config === "string" ? { endpoint: config } : config;

  const response = await fetch(`${cfg.endpoint}/mcp/tools/call`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.jwtToken ? { "Authorization": `Bearer ${cfg.jwtToken}` } : {}),
    },
    body: JSON.stringify({
      tool: "concept_create",
      arguments: params,
    }),
    signal: AbortSignal.timeout(cfg.timeout ?? 30000),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`concept creation failed: ${error}`);
  }

  const { result } = await response.json() as { result: { id: string } };
  return result.id;
}

/**
 * Record concept usage after execution
 *
 * Call this in execution callbacks to update concept learning metrics.
 */
export async function recordConceptUsage(
  config: ConceptResolverConfig,
  params: {
    concept_id: string;
    trace_id: string;
    activity_id?: string;
    task_id?: string;
    outcome: "success" | "failure" | "neutral";
  }
): Promise<void> {
  const cfg = typeof config === "string" ? { endpoint: config } : config;

  const response = await fetch(`${cfg.endpoint}/mcp/tools/call`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.jwtToken ? { "Authorization": `Bearer ${cfg.jwtToken}` } : {}),
    },
    body: JSON.stringify({
      tool: "concept_record_usage",
      arguments: params,
    }),
    signal: AbortSignal.timeout(cfg.timeout ?? 30000),
  });

  if (!response.ok) {
    console.warn(`[concept-db] Failed to record usage: ${await response.text()}`);
  }
}

/**
 * Record concept sequence from execution trace
 *
 * Call this after execution to create sequence edges.
 */
export async function recordConceptSequence(
  config: ConceptResolverConfig,
  params: {
    concept_ids: string[];
    trace_id: string;
  }
): Promise<void> {
  const cfg = typeof config === "string" ? { endpoint: config } : config;

  if (params.concept_ids.length < 2) {
    return; // Need at least 2 concepts for a sequence
  }

  const response = await fetch(`${cfg.endpoint}/mcp/tools/call`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.jwtToken ? { "Authorization": `Bearer ${cfg.jwtToken}` } : {}),
    },
    body: JSON.stringify({
      tool: "concept_sequence_record",
      arguments: params,
    }),
    signal: AbortSignal.timeout(cfg.timeout ?? 30000),
  });

  if (!response.ok) {
    console.warn(`[concept-db] Failed to record sequence: ${await response.text()}`);
  }
}
