#!/usr/bin/env bun
/**
 * Example: How MiniBob would use concept-db
 *
 * This shows the full flow of:
 * 1. Registering concept-db as a resolver
 * 2. Creating concepts from execution outputs
 * 3. Loading concepts as impulses for context
 * 4. Recording usage and sequences for learning
 *
 * Run: CONCEPT_DB_URL=http://localhost:8081 bun run examples/minibob-integration.ts
 */

// This would be imported from concept-db package
// In reality, MiniBob would import: import { registerConceptResolver, ... } from "@metabob/concept-db/integration"

const CONCEPT_DB_URL = process.env.CONCEPT_DB_URL || "http://localhost:8081";

// ============================================================================
// STEP 1: Register concept resolver at MiniBob startup
// ============================================================================

// This would go in MiniBob's vessel-bootstrap.ts or index.ts
async function registerConceptResolver() {
  // MiniBob's impulse.ts provides this function
  // registerResolver("concept", async (pointer) => { ... })

  console.log("✓ Registered concept resolver");
  console.log(`  Endpoint: ${CONCEPT_DB_URL}`);
  console.log(`  Pointer type: concept`);
  console.log(`  Example usage:`);
  console.log(`    createImpulse({`);
  console.log(`      id: "context-goal",`);
  console.log(`      pointer: { type: "concept", concept_id: "concept_abc123" },`);
  console.log(`      budget: 2000,`);
  console.log(`    })`);
}

// ============================================================================
// STEP 2: Create concepts from execution outputs
// ============================================================================

async function createConceptFromExecution() {
  // After an LLM generates code or a file is written,
  // MiniBob would create a concept to track it

  const response = await fetch(`${CONCEPT_DB_URL}/mcp/tools/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tool: "concept_create",
      arguments: {
        source_type: "llm",
        content: "function calculateTotal(items) { return items.reduce((sum, item) => sum + item.price, 0); }",
        summary: "Calculate total price from items array",
        priority: 0.7,
      },
    }),
  });

  const result = await response.json();
  console.log("✓ Created concept from LLM output:", result);
  return result.result.id;
}

// ============================================================================
// STEP 3: Use concepts as impulses in activity execution
// ============================================================================

async function useConceptAsImpulse(conceptId: string) {
  // MiniBob would load this as an impulse during activity execution
  // The concept resolver handles the HTTP call

  const response = await fetch(`${CONCEPT_DB_URL}/mcp/tools/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tool: "concept_resolve",
      arguments: {
        concept_id: conceptId,
        include_neighbors: true,
      },
    }),
  });

  const result = await response.json();
  console.log("✓ Resolved concept:", {
    id: result.result.concept.id,
    shape: result.result.concept.shape,
    tokens: result.result.concept.resolution_snapshot?.token_count,
    neighbors: result.result.neighbors?.length || 0,
  });
}

// ============================================================================
// STEP 4: Record usage after execution (for learning)
// ============================================================================

async function recordUsageAfterExecution(conceptId: string) {
  // After activity execution, MiniBob records which concepts were used
  // and whether the execution succeeded

  const response = await fetch(`${CONCEPT_DB_URL}/mcp/tools/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tool: "concept_record_usage",
      arguments: {
        concept_id: conceptId,
        trace_id: `trace_${Date.now()}`,
        activity_id: "core:hello-world",
        outcome: "success",
      },
    }),
  });

  const result = await response.json();
  console.log("✓ Recorded usage:", result);
}

// ============================================================================
// STEP 5: Record sequence for temporal learning
// ============================================================================

async function recordSequence(conceptIds: string[]) {
  // When multiple concepts are resolved in sequence during execution,
  // MiniBob records the sequence for pattern learning

  const response = await fetch(`${CONCEPT_DB_URL}/mcp/tools/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tool: "concept_sequence_record",
      arguments: {
        concept_ids: conceptIds,
        trace_id: `trace_${Date.now()}`,
      },
    }),
  });

  const result = await response.json();
  console.log("✓ Recorded sequence:", result);
}

// ============================================================================
// Run the example
// ============================================================================

async function main() {
  console.log("\n=== MiniBob + concept-db Integration Example ===\n");

  // Check if concept-db is running
  try {
    const health = await fetch(`${CONCEPT_DB_URL}/health`);
    if (!health.ok) throw new Error("unhealthy");
    console.log("✓ concept-db is running\n");
  } catch {
    console.error(`✗ concept-db is not running at ${CONCEPT_DB_URL}`);
    console.error("  Start it with: cd repos/concept-db && SURREALDB_NAMESPACE=activity-system bun run start");
    process.exit(1);
  }

  // Step 1: Show registration (happens at startup)
  await registerConceptResolver();
  console.log();

  // Step 2: Create a concept
  const conceptId = await createConceptFromExecution();
  console.log();

  // Step 3: Use it as an impulse
  await useConceptAsImpulse(conceptId);
  console.log();

  // Step 4: Record usage
  await recordUsageAfterExecution(conceptId);
  console.log();

  // Step 5: Create another concept and record sequence
  const response2 = await fetch(`${CONCEPT_DB_URL}/mcp/tools/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tool: "concept_create",
      arguments: {
        source_type: "memo",
        content: "Use calculateTotal to sum order items",
        summary: "Usage note for calculateTotal function",
      },
    }),
  });
  const result2 = await response2.json();
  const conceptId2 = result2.result.id;

  await recordSequence([conceptId, conceptId2]);

  console.log("\n=== Integration complete ===");
  console.log("\nTo see this in MiniBob, add to vessel-bootstrap.ts:");
  console.log(`
  import { registerConceptResolver } from "@metabob/concept-db/integration"

  // At startup:
  registerConceptResolver({
    endpoint: process.env.CONCEPT_DB_URL || "http://concept-db:8081",
    jwtToken: mcp.getJwtToken(),  // Pass auth token
  })
  `);
}

main().catch(console.error);
