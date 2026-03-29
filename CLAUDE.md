# concept-db

A vessel that manages **concepts as impulses** with graph relationships. Exposes MCP tools, runs autonomous upkeep activities via Thompson Sampling, and integrates with the existing impulse/trace learning system.

## Key Design Decisions

1. **Concepts ARE impulses** - Same pointer/budget/priority structure as the impulse pattern
2. **Resolution creates snapshots** - When a concept is resolved, a snapshot captures state at resolution time
3. **Upkeep rules become autonomous activities** - Subject to Thompson Sampling, create traces
4. **Lifecycle hooks trigger on CRUD operations** - Events for concept:created, concept:resolved, etc.
5. **Multi-tenant** - Scoped to global:org:project

## Running Locally

```bash
# Install dependencies
bun install

# Set environment variables
export SURREALDB_NAMESPACE=activity-system
export SURREALDB_DATABASE=learning_loop
export SURREALDB_URL=http://localhost:8000
export SURREALDB_USERNAME=root
export SURREALDB_PASSWORD=your-password

# Apply schema
bun run apply-schema

# Start server
bun run start

# Development with hot reload
bun run dev

# Run tests
bun test
```

## API Endpoints

### MCP Tools
- `GET /mcp/tools` - List available tools
- `GET /mcp/tools/:name` - Get tool details
- `POST /mcp/tools/call` - Call a tool
- `POST /mcp/tools/batch` - Batch tool calls

### Concepts
- `POST /concepts` - Create concept
- `POST /concepts/from-source` - Create from source type
- `GET /concepts/search` - Search concepts
- `GET /concepts/:id` - Get concept
- `POST /concepts/:id/resolve` - Resolve concept
- `PATCH /concepts/:id` - Update concept
- `GET /concepts/:id/neighbors` - Get neighbors
- `GET /concepts/:id/edges` - Get edges
- `POST /concepts/:id/link` - Create edge
- `POST /concepts/:id/usage` - Record usage
- `GET /concepts/:id/usage` - Get usage history
- `GET /concepts/:id/stats` - Get usage stats
- `GET /concepts/:id/sequence` - Get sequence neighbors
- `POST /concepts/sequences` - Record sequence

### Upkeep
- `GET /upkeep/status` - Scheduler status
- `GET /upkeep/activities` - List activities
- `POST /upkeep/trigger` - Manual trigger
- `POST /upkeep/scheduler/start` - Start scheduler
- `POST /upkeep/scheduler/stop` - Stop scheduler

## MCP Tools

| Tool | Description |
|------|-------------|
| `concept_create` | Create concept from source data |
| `concept_resolve` | Resolve concept and create snapshot |
| `concept_link` | Create edge between concepts |
| `concept_search` | Search by content/shape/source |
| `concept_neighbors` | Get graph neighbors |
| `concept_record_usage` | Record concept loaded in execution |
| `concept_sequence_record` | Record sequence of resolved concepts |

## Source Types

| Source Type | Shape | Default Priority | Default Budget |
|-------------|-------|------------------|----------------|
| goal | goal | 0.9 | 500 |
| human_input | user_request | 0.8 | 1000 |
| metabob_annotation | code_annotation | 0.7 | 1000 |
| write | file_content | 0.6 | 3000 |
| read | file_content | 0.5 | 3000 |
| llm | llm_response | 0.5 | 4000 |
| search | search_result | 0.4 | 2000 |
| memo | memo | 0.4 | 500 |
| cpg_embedding | code_pattern | 0.3 | 2000 |
| extracted | extracted_data | 0.3 | 2000 |

## Edge Types

- `related_to` - General relationship
- `derived_from` - Parent-child derivation
- `resolves_to` - Resolution pointer
- `sequence_next` - Next in execution sequence
- `sequence_prev` - Previous in execution sequence
- `description_of` - Describes another concept
- `example_of` - Example of a pattern/concept
- `contradicts` - Contradictory information

## Upkeep Activities

| Activity ID | Trigger | Action |
|------------|---------|--------|
| split-long-concept | token_estimate > budget * 1.5 | Adjust budget |
| resolve-island | Concept has no edges | Find related, create edge |
| adjust-priority-relevance | \|priority - relevance\| > 0.3 | Align via EMA |
| prune-irrelevant-neighbors | High relevance + low neighbor + weak edge | Delete edge |
| decay-stale-relevance | High loads, low success rate | Reduce relevance |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 8081 | Server port |
| HOST | 0.0.0.0 | Bind address |
| SURREALDB_URL | http://localhost:8000 | SurrealDB URL |
| SURREALDB_NAMESPACE | - | Required: Database namespace |
| SURREALDB_DATABASE | learning_loop | Database name |
| SURREALDB_USERNAME | root | Database user |
| SURREALDB_PASSWORD | changeme | Database password |
| REDIS_URL | redis://localhost:6379 | Redis URL |
| ACTIVITY_API_URL | http://metabob-activity-api:8080 | Activity API URL |
| UPKEEP_ENABLED | true | Enable upkeep scheduler |
| UPKEEP_INTERVAL_MS | 300000 | Upkeep interval (5 min) |
| UPKEEP_BATCH_SIZE | 50 | Max candidates per run |
| REQUIRE_AUTH | false | Require JWT auth |
| LOG_LEVEL | info | Logging level |
| LOG_FORMAT | text | json or text |

## MiniBob Integration

**The Problem**: MiniBob currently only talks to metabob-activity-api. It needs a way to resolve `concept` pointer types.

**The Solution**: Register concept-db as a custom resolver in MiniBob.

### Step 1: Register at Startup

In MiniBob's `vessel-bootstrap.ts` or startup:

```typescript
import { registerResolver } from "./impulse"

// Register concept-db as a resolver for "concept" pointer types
registerResolver("concept", async (pointer) => {
  const response = await fetch(`${CONCEPT_DB_URL}/mcp/tools/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tool: "concept_resolve",
      arguments: {
        concept_id: pointer.concept_id,
        include_neighbors: pointer.include_neighbors ?? false,
      },
    }),
  });

  const { result } = await response.json();
  return {
    content: result.concept.content,
    metadata: {
      shape: result.concept.shape,
      summary: result.concept.summary,
    },
  };
});
```

### Step 2: Create Concept Impulses

```typescript
import { createImpulse } from "./impulse"

createImpulse({
  id: "context-goal",
  pointer: {
    type: "concept",           // Routes to concept-db resolver
    concept_id: "concept_abc123",
    include_neighbors: true,
  },
  budget: 2000,
  priority: "high",
})
```

### Step 3: Record Usage for Learning

In activity execution callbacks:

```typescript
// After execution, record which concepts were used
await fetch(`${CONCEPT_DB_URL}/mcp/tools/call`, {
  method: "POST",
  body: JSON.stringify({
    tool: "concept_record_usage",
    arguments: {
      concept_id: "concept_abc123",
      trace_id: execution.traceId,
      outcome: execution.success ? "success" : "failure",
    },
  }),
});
```

### Full Example

See `examples/minibob-integration.ts` for a complete working example.

```bash
# Start concept-db
SURREALDB_NAMESPACE=activity-system bun run start

# Run example
CONCEPT_DB_URL=http://localhost:8081 bun run examples/minibob-integration.ts
```

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│   MiniBob   │────▶│   concept-db     │────▶│  SurrealDB  │
│             │     │  (MCP tools)     │     │             │
└─────────────┘     └──────────────────┘     └─────────────┘
      │                     │
      │                     ▼
      │             ┌──────────────────┐
      └────────────▶│ metabob-activity │
                    │      -api        │
                    └──────────────────┘

Flow:
1. MiniBob creates impulse with type: "concept"
2. Impulse resolver routes to concept-db
3. concept-db resolves concept, creates snapshot
4. concept-db forwards usage to activity-api for learning
```

## Integration Points

1. **MiniBob → concept-db**: Custom resolver for `concept` pointer type
2. **concept-db → metabob-activity-api**: Usage forwarding via `/v2/activities/impulse-relevance`
3. **concept-db → SurrealDB**: Persistent storage of concepts and edges
4. **Upkeep activities**: Create traces stored in metabob-activity-api
