#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# e2e/ci/collect-logs.sh — best-effort diagnostics dump for the smoke stack
# ══════════════════════════════════════════════════════════════════
#
# Runs with `if: always()` in the workflow: dumps compose state, full +
# per-service logs, and host resource info into compose-logs/ (uploaded as
# an artifact). Deliberately NO `set -e` and every command is `|| true` —
# this script must NEVER fail the job.
# ══════════════════════════════════════════════════════════════════
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

COMPOSE=(docker compose
  -f "$REPO_ROOT/docker-compose.from-registry.yml"
  -f "$REPO_ROOT/e2e/ci/docker-compose.ci.yml"
  --profile core --profile search)

OUT_DIR="$REPO_ROOT/compose-logs"
mkdir -p "$OUT_DIR" || true

echo "== docker compose ps --all =="
"${COMPOSE[@]}" ps --all || true

echo "== writing full stack log to compose-logs/stack.log =="
"${COMPOSE[@]}" logs --no-color --timestamps > "$OUT_DIR/stack.log" 2>&1 || true

# Per-service logs for every core+search service (base compose service names).
for svc in postgres rustfs server agent-hub search-postgres search-redis search-api; do
  "${COMPOSE[@]}" logs --no-color --timestamps "$svc" > "$OUT_DIR/$svc.log" 2>&1 || true
done

echo "== docker stats (one-shot) =="
docker stats --no-stream || true

echo "== disk usage =="
df -h || true

echo "== server container state =="
docker inspect --format '{{json .State}}' beeflow-server > "$OUT_DIR/server-state.json" 2>&1 || true
cat "$OUT_DIR/server-state.json" || true
echo ""

echo "[collect-logs] done — logs in $OUT_DIR"
exit 0
