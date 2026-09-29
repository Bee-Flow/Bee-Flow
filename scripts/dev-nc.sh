#!/usr/bin/env bash
# Single entrypoint for the Bee Flow + Nextcloud local dev loop.
#
# Sub-commands:
#   up    — ensure NC sandbox + Bee Flow stack are running, build SPA with
#           the correct VITE args, push to local registry + connector
#   spa   — rebuild the SPA only (~30s). Asset paths + API base are always
#           set via VITE build args so no manual sed-patching is needed.
#   reset — wipe NC org + insecure secret + connector cache so the next
#           login triggers the wizard from step 1
#   logs  — tail server + connector logs in parallel (interleaved, prefixed)
#
# All commands are idempotent. Re-running 'up' is safe and fast.
set -euo pipefail

CMD="${1:-help}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${SCRIPT_DIR}/.." && pwd)"

NC_CONTAINER="${NC_CONTAINER:-bf-appstore-test-nc}"
NC_NETWORK="${NC_NETWORK:-bf-appstore-test}"
CONNECTOR_CONTAINER="${CONNECTOR_CONTAINER:-nc_app_bee_flow}"
SERVER_CONTAINER="${SERVER_CONTAINER:-beeflow-server-dev}"
AGENT_HUB_CONTAINER="${AGENT_HUB_CONTAINER:-beeflow-agent-hub-dev}"
NC_INSTANCE_ID="${NC_INSTANCE_ID:-32.0.9:Nextcloud}"

# Build args that MUST match the connector's NC proxy route. If these drift,
# the SPA loads but every API call hits the wrong origin (CORS) and every
# asset 404s. Keep them hardcoded here so an empty env var can never break it.
VITE_API_URL="/index.php/apps/app_api/proxy/bee_flow"
VITE_BASE="/index.php/apps/app_api/proxy/bee_flow/"

# Detect how to talk to docker:
#   - If we're inside Flatpak (VS Code's Flatpak ships without docker on PATH)
#     go through flatpak-spawn --host
#   - If the current user isn't in the docker group, prefix with sg docker
#   - Otherwise use plain bash
NEEDS_FLATPAK=0
NEEDS_SG=0
if command -v flatpak-spawn >/dev/null 2>&1 && ! command -v docker >/dev/null 2>&1; then
    NEEDS_FLATPAK=1
fi
if [[ "$NEEDS_FLATPAK" = 0 ]] && ! id -nG 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
    NEEDS_SG=1
fi

run_docker() {
    local cmd="$1"
    if [[ "$NEEDS_FLATPAK" = 1 ]]; then
        flatpak-spawn --host bash -lc "sg docker -c '$(printf %s "$cmd" | sed "s/'/'\\\\''/g")'"
    elif [[ "$NEEDS_SG" = 1 ]]; then
        sg docker -c "$cmd"
    else
        bash -c "$cmd"
    fi
}

usage() {
    sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
}

cmd_spa() {
    echo "▶ Building SPA (VITE_API_URL=${VITE_API_URL}, base=${VITE_BASE})…"
    # The agent-hub container is a dev-mode node:20-alpine started by
    # docker-compose. We exec into it so we don't have to maintain a
    # separate build image.
    run_docker "docker exec -e VITE_API_URL='${VITE_API_URL}' '${AGENT_HUB_CONTAINER}' \
        sh -c 'cd /app && npm run build -- --base=${VITE_BASE} 2>&1 | tail -3'"

    echo "▶ Copying dist → connector /app/public…"
    # docker cp via a host tmpdir so the bytes don't have to traverse our
    # shell quoting twice.
    local tmp="/tmp/bf-spa-$$"
    run_docker "rm -rf '${tmp}' && mkdir -p '${tmp}'"
    run_docker "docker cp '${AGENT_HUB_CONTAINER}:/app/dist/.' '${tmp}/'"
    run_docker "docker exec '${CONNECTOR_CONTAINER}' sh -c 'rm -rf /app/public/* /app/public/.[!.]* 2>/dev/null || true'"
    run_docker "docker cp '${tmp}/.' '${CONNECTOR_CONTAINER}:/app/public/'"
    run_docker "rm -rf '${tmp}'"
    echo "✓ SPA deployed. Hard refresh the NC tab (Ctrl+Shift+R)."
}

cmd_up() {
    echo "▶ Ensuring Bee Flow stack is up (postgres, redis, rustfs, server, agent-hub)…"
    run_docker "cd '${REPO}' && docker compose -f docker-compose.dev.yml up -d postgres rustfs server agent-hub search-redis"

    echo "▶ Ensuring connector container is on NC network…"
    run_docker "docker network connect '${NC_NETWORK}' '${SERVER_CONTAINER}' 2>&1 | grep -v 'already exists' || true"

    echo "▶ Waiting for server /api/health…"
    for _ in $(seq 1 60); do
        if run_docker "docker exec '${NC_CONTAINER}' wget -q -O- --timeout=2 http://${SERVER_CONTAINER}:3001/api/health 2>/dev/null" | grep -q '"status":"ok"' 2>/dev/null; then
            echo "✓ server reachable"
            break
        fi
        sleep 2
    done

    cmd_spa
}

cmd_reset() {
    echo "▶ Wiping org + tenant key + pending bindings on server…"
    run_docker "docker exec -e NC_INSTANCE_ID='${NC_INSTANCE_ID}' '${SERVER_CONTAINER}' node /app/reset-nc.js" || true

    echo "▶ Wiping connector cache + restarting…"
    # Phase-2: connector caches `tenant-key.json` (production JWT path). The
    # legacy `insecure-secret.json` is gone but we still rm it in case an old
    # container has it.
    run_docker "docker exec '${CONNECTOR_CONTAINER}' sh -c 'rm -f /nc_app_bee_flow_data/tenant-key.json /nc_app_bee_flow_data/pending-bootstrap.json /nc_app_bee_flow_data/bootstrap-last-error.json /nc_app_bee_flow_data/insecure-secret.json'"
    run_docker "docker restart '${CONNECTOR_CONTAINER}'" >/dev/null
    echo "✓ Reset complete. Next bee-icon click triggers the wizard."
}

# Pair a fresh NC install to an EXISTING Bee Flow org via pairing code.
# Usage: dev-nc.sh pair BEEF-FL0W
# This is the manual leg of Phase-2 recovery — exercises the same env-var
# the production "occ app_api:app:setenv" workflow uses.
cmd_pair() {
    local code="${1:-}"
    if [ -z "$code" ]; then
        echo "usage: $0 pair <PAIRING-CODE>" >&2
        exit 2
    fi
    echo "▶ Setting BEEFLOW_PAIRING_CODE=${code} on connector and restarting…"
    run_docker "docker exec '${CONNECTOR_CONTAINER}' sh -c 'rm -f /nc_app_bee_flow_data/tenant-key.json /nc_app_bee_flow_data/pending-bootstrap.json'"
    # Inject via NC's app_api so it survives the connector restart.
    run_docker "docker exec '${NC_CONTAINER}' sudo -u www-data php occ app_api:app:setenv bee_flow BEEFLOW_PAIRING_CODE '${code}'" || true
    run_docker "docker restart '${CONNECTOR_CONTAINER}'" >/dev/null
    echo "✓ Connector restarted. Watch logs with: $0 logs"
}

cmd_logs() {
    echo "▶ Tailing server + connector. Ctrl+C to stop."
    # Two background tails, line-prefixed so you can see who said what.
    run_docker "docker logs -f '${SERVER_CONTAINER}' 2>&1 | sed 's/^/[server] /' &
                docker logs -f '${CONNECTOR_CONTAINER}' 2>&1 | sed 's/^/[connector] /' &
                wait"
}

case "$CMD" in
    up)    cmd_up ;;
    spa)   cmd_spa ;;
    reset) cmd_reset ;;
    pair)  cmd_pair "${2:-}" ;;
    logs)  cmd_logs ;;
    -h|--help|help) usage ;;
    *) echo "Unknown command: $CMD" >&2; usage >&2; exit 1 ;;
esac
