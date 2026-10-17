#!/bin/bash
# LIVE CHECK (intended to run in the gate environment, outside the glue corpus): org scoping on id paths against the
# real engine. Starts a throwaway in-memory SurrealDB on a free loopback port, applies this repo's schema, runs
# org-scoped-id-paths.live.ts against it, and stops the engine by its own pid.
# Usage: tests/org-scoped-id-paths.check.sh   (from the repo root; needs `surreal` and `bun` on PATH)
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PORT=$(( 20000 + RANDOM % 20000 ))
TMP=$(mktemp -d)
surreal start --unauthenticated --bind "127.0.0.1:$PORT" --log warn memory > "$TMP/surreal.log" 2>&1 &
SPID=$!
trap 'kill "$SPID" 2>/dev/null; wait "$SPID" 2>/dev/null; rm -rf "$TMP"' EXIT
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.2; done
for f in "$ROOT"/sql/core/*.surql; do
  surreal import --endpoint "http://127.0.0.1:$PORT" --namespace orgcheck --database orgcheck "$f" > "$TMP/import.log" 2>&1 \
    || echo "schema note: $(basename "$f") did not import cleanly ($(tail -1 "$TMP/import.log" | cut -c1-160))"
done
cd "$ROOT" && env -i PATH="$PATH" HOME="$TMP" SURREALDB_URL="http://127.0.0.1:$PORT" SURREALDB_NAMESPACE=orgcheck \
  SURREALDB_DATABASE=orgcheck SURREALDB_USERNAME=NONE SURREALDB_PASSWORD=NONE LOG_LEVEL=error \
  timeout 120 bun run tests/org-scoped-id-paths.live.ts
