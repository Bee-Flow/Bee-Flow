#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# e2e/ci/wait-for-stack.sh — strict readiness gate for the smoke stack
# ══════════════════════════════════════════════════════════════════
#
# Blocks until the compose stack (profiles core+search) is genuinely usable,
# and hard-fails otherwise:
#   1. HTTP endpoints answer: server /api/health, frontend /, search /health
#   2. boot-init.js finished first-boot provisioning (log marker)
#   3. forced MFA for password accounts is disabled — BEFORE any login, so
#      the config-store cache never memoises the default (true)
#   4. an admin login round-trips with "success":true — this also consumes
#      the one-time recoveryKey so the UI suite never sees that modal
#   5. no container is exited / restarting / dead / unhealthy
#
# Requires: ADMIN_PASSWORD in env (exported by write-env.sh via $GITHUB_ENV).
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Both -f files + both profiles on every invocation (see docker-compose.ci.yml).
COMPOSE=(docker compose
  -f "$REPO_ROOT/docker-compose.from-registry.yml"
  -f "$REPO_ROOT/e2e/ci/docker-compose.ci.yml"
  --profile core --profile search)

# container_name values from docker-compose.from-registry.yml
SERVER_CONTAINER="beeflow-server"
POSTGRES_CONTAINER="beeflow-postgres"

SERVER_URL="http://localhost:3001"
CLIENT_URL="http://localhost:5176"
SEARCH_URL="http://127.0.0.1:8000"   # base compose binds 127.0.0.1:8000

die() {
  echo "::error::$1"
  exit 1
}

# wait_http <name> <url> <tries> <sleep-seconds>
wait_http() {
  local name="$1" url="$2" tries="$3" pause="$4" i
  echo "[wait] $name — $url (up to $((tries * pause))s)"
  for ((i = 1; i <= tries; i++)); do
    if curl -fsS -o /dev/null "$url"; then
      echo "[wait] $name is up (attempt $i/$tries)"
      return 0
    fi
    sleep "$pause"
  done
  die "$name did not answer at $url within $((tries * pause))s"
}

# ── 1. HTTP endpoints ────────────────────────────────────────────
wait_http "server"    "$SERVER_URL/api/health" 100 3
wait_http "frontend"  "$CLIENT_URL/"            20 3
wait_http "search-api" "$SEARCH_URL/health"     60 3

# ── 2. First-boot provisioning complete ──────────────────────────
echo "[wait] boot-init completion marker in $SERVER_CONTAINER logs (up to 120s)"
boot_done=false
for ((i = 1; i <= 40; i++)); do
  if docker logs "$SERVER_CONTAINER" 2>&1 | grep -qF '[boot-init] First-boot setup complete'; then
    boot_done=true
    break
  fi
  sleep 3
done
if [[ "$boot_done" != "true" ]]; then
  die "boot-init did not log 'First-boot setup complete' within 120s — first-boot provisioning failed or hung"
fi
echo "[wait] boot-init complete"

# ── 3. Disable forced MFA BEFORE any login ───────────────────────
# The server defaults require_mfa_for_password_accounts to true when unset;
# flipping it in the config table before the first login keeps the probe (and
# the UI suite) out of the TOTP-enrollment flow. boot-init has completed, so
# the lazily-created config table exists — the retry loop is belt-and-braces.
MFA_SQL="INSERT INTO config (key, value, updated_at) VALUES ('require_mfa_for_password_accounts','false',NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();"
echo "[wait] disabling forced MFA for password accounts"
mfa_ok=false
for ((i = 1; i <= 5; i++)); do
  if docker exec "$POSTGRES_CONTAINER" psql -v ON_ERROR_STOP=1 -U beeflow -d beeflow_core -c "$MFA_SQL"; then
    mfa_ok=true
    break
  fi
  echo "[wait] psql attempt $i/5 failed — retrying in 2s"
  sleep 2
done
if [[ "$mfa_ok" != "true" ]]; then
  die "could not write require_mfa_for_password_accounts=false to the config table"
fi

# ── 4. Admin login probe ─────────────────────────────────────────
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD must be set (write-env.sh exports it via GITHUB_ENV)}"
echo "[wait] admin login probe against $SERVER_URL/auth/admin-login"
# ADMIN_PASSWORD is Sm0ke+hex (no JSON metacharacters), safe to interpolate.
raw="$(curl -sS -w $'\n%{http_code}' \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASSWORD\"}" \
  "$SERVER_URL/auth/admin-login")" || die "admin login request failed to complete"
status="${raw##*$'\n'}"
body="${raw%$'\n'*}"
if [[ "$status" == "200" && "$body" == *'"success":true'* ]]; then
  # Do NOT print the body: it contains the one-time recovery key.
  echo "[wait] admin login OK (response withheld — contains the one-time recovery key)"
else
  masked="${body//"$ADMIN_PASSWORD"/********}"
  die "admin login failed: HTTP $status — ${masked:0:200}"
fi

# ── 5. No unhealthy / exited / restarting containers ─────────────
echo "[wait] verifying container states"
# docker compose v2 `ps --format json` emits one JSON object per line
# (NDJSON); some builds emit a single array. `jq -s 'flatten'` normalises
# both to a flat array of container objects.
if ! ps_json="$("${COMPOSE[@]}" ps --all --format json)"; then
  die "docker compose ps failed"
fi
if ! bad="$(printf '%s\n' "$ps_json" | jq -rs 'flatten | .[]
      | select((.Health == "unhealthy") or (.State == "exited")
               or (.State == "restarting") or (.State == "dead"))
      | "\(.Name): state=\(.State) health=\(.Health // "n/a") exit=\(.ExitCode // "n/a")"')"; then
  die "failed to parse docker compose ps output"
fi
if [[ -n "$bad" ]]; then
  echo "$bad"
  die "stack has unhealthy/exited/restarting containers (see list above)"
fi

echo "[wait] stack is fully ready"
