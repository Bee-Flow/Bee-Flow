#!/usr/bin/env bash
# Run Bee Flow against a local Nextcloud — no App Store, no public registry.
#
# This is the "fast path" from the docs:
#   https://bee-flow.github.io/docs/getting-started/local-development/
#
# What it does:
#   1. docker build -t bee-flow-connector:dev nextcloud-connector/
#      (Dockerfile clones Bee-Flow/hive anonymously over HTTPS at build time —
#       no SSH key or token needed.)
#   2. docker run nextcloud:31 on :8080 (admin / admin via sqlite)
#   3. occ app:install app_api
#   4. occ app_api:daemon:register manual_dev … manual-install
#   5. occ app_api:app:register bee_flow manual_dev --info-xml /tmp/info.xml \
#                              --env BEEFLOW_TENANT_KEY=dev-tenant-key \
#                              --env BEEFLOW_API_BASE_URL=http://host.docker.internal:3101
#
# Usage:
#   ./scripts/run-local-nc.sh up          # build + run NC + install connector
#   ./scripts/run-local-nc.sh status      # show state
#   ./scripts/run-local-nc.sh logs        # tail NC + connector logs
#   ./scripts/run-local-nc.sh down        # stop containers, keep data
#   ./scripts/run-local-nc.sh clean       # nuke containers + image
#   ./scripts/run-local-nc.sh restart     # down → up
#
# Env overrides (passed straight through to local-sandbox.sh):
#   NC_VERSION=31  NC_PORT=8080  IMAGE=bee-flow-connector:dev
#   TENANT_KEY=dev-tenant-key  API_BASE_URL=http://host.docker.internal:3101
#
# After `up`:
#   • http://localhost:8080  (admin / admin) — click the bee in the top bar
#   • If you also run the Bee Flow server on :3101 the chat works end-to-end.
#     If not, the SPA loads but chat shows "backend unreachable" — that still
#     verifies the install + AppAPI plumbing.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SANDBOX="$REPO_ROOT/nextcloud-connector/scripts/local-sandbox.sh"

NC_NAME="bee-flow-nc-sandbox"
APP_ID="${APP_ID:-bee_flow}"

# ─── colours ─────────────────────────────────────────────────────────────────

if [ -t 1 ]; then
    BLU='\033[1;34m'; GRN='\033[1;32m'; YLW='\033[1;33m'; RED='\033[1;31m'; DIM='\033[2m'; OFF='\033[0m'
else
    BLU=''; GRN=''; YLW=''; RED=''; DIM=''; OFF=''
fi

# ─── pre-flight ──────────────────────────────────────────────────────────────

if ! command -v docker >/dev/null; then
    echo -e "${RED}docker not installed${OFF}" >&2; exit 1
fi
if ! docker info >/dev/null 2>&1; then
    echo -e "${RED}docker daemon not reachable (is the daemon running? do you need 'sudo'?)${OFF}" >&2; exit 1
fi
if [ ! -x "$SANDBOX" ]; then
    echo -e "${RED}local-sandbox.sh not found or not executable: $SANDBOX${OFF}" >&2; exit 1
fi

usage() {
    sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
}

verify_block() {
    cat <<EOF

${BLU}── verify ──${OFF}

  ${DIM}Heartbeat from NC's perspective:${OFF}
  docker exec -u www-data $NC_NAME php occ app_api:app:heartbeat $APP_ID

  ${DIM}Open in your browser:${OFF}
  open http://localhost:8080         ${DIM}# admin / admin${OFF}

  ${DIM}Connector logs:${OFF}
  docker logs nc_app_$APP_ID --tail 50

${YLW}If the bee icon doesn't appear: hard-reload (Cmd/Ctrl+Shift+R).${OFF}
${YLW}If chat shows "backend unreachable": run the Bee Flow server on :3101,
or override BEEFLOW_API_BASE_URL on the connector and restart it.${OFF}

EOF
}

cmd_logs() {
    echo -e "${BLU}▶ tailing NC + connector logs (Ctrl+C to stop)${OFF}"
    # Run both `docker logs -f` in parallel; trap kills both on Ctrl+C.
    trap 'kill 0' INT TERM EXIT
    docker logs -f --tail 50 "$NC_NAME"            2>&1 | sed "s/^/${BLU}[NC]${OFF} /" &
    docker logs -f --tail 50 "nc_app_$APP_ID" 2>&1 | sed "s/^/${GRN}[connector]${OFF} /" &
    wait
}

cmd_status() {
    echo -e "${BLU}▶ container state${OFF}"
    docker ps --filter "name=$NC_NAME" --filter "name=nc_app_$APP_ID" \
        --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
    echo
    if docker ps --format '{{.Names}}' | grep -qx "$NC_NAME"; then
        echo -e "${BLU}▶ AppAPI heartbeat${OFF}"
        docker exec -u www-data "$NC_NAME" php occ "app_api:app:heartbeat" "$APP_ID" 2>/dev/null \
            || echo -e "${YLW}  (heartbeat call failed)${OFF}"
    fi
}

# ─── dispatch ────────────────────────────────────────────────────────────────

CMD="${1:-up}"; shift || true

case "$CMD" in
    up)
        echo -e "${BLU}▶ run-local-nc up${OFF}"
        "$SANDBOX" up "$@"
        verify_block
        ;;
    down|clean)
        echo -e "${BLU}▶ run-local-nc $CMD${OFF}"
        "$SANDBOX" "$CMD" "$@"
        ;;
    restart)
        "$SANDBOX" down || true
        "$SANDBOX" up "$@"
        verify_block
        ;;
    logs)
        cmd_logs
        ;;
    status)
        cmd_status
        ;;
    -h|--help|help)
        usage
        ;;
    *)
        echo -e "${RED}unknown command: $CMD${OFF}" >&2
        echo "valid: up | down | clean | restart | logs | status | help" >&2
        exit 1
        ;;
esac

echo
echo -e "${GRN}done${OFF}"
