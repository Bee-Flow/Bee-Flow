#!/bin/bash
# ══════════════════════════════════════════════════════════════════
# BeeFlow — Install Wizard Launcher
# ══════════════════════════════════════════════════════════════════
#
# Usage:
#   ./install.sh                  # Build + run the install wizard
#   ./install.sh --stop           # Stop the wizard container
#   ./install.sh --status         # Check what's running
#   ./install.sh --uninstall      # Stop all BeeFlow containers
#
# The wizard opens at http://localhost:9090 and guides you through
# selecting which BeeFlow services to deploy.
# ══════════════════════════════════════════════════════════════════
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WIZARD_IMAGE="beeflow-install-wizard"
WIZARD_CONTAINER="beeflow-wizard"
WIZARD_PORT="${WIZARD_PORT:-9090}"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.install.yml"

# ── Colors ───────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

log()  { echo -e "${CYAN}[installer]${NC} $1"; }
ok()   { echo -e "${GREEN}[✅]${NC} $1"; }
warn() { echo -e "${YELLOW}[⚠️]${NC} $1"; }
err()  { echo -e "${RED}[❌]${NC} $1"; exit 1; }

# ── Check Docker ─────────────────────────────────────────────────
check_docker() {
    if ! command -v docker &>/dev/null; then
        err "Docker is not installed. Please install Docker first: https://docs.docker.com/get-docker/"
    fi
    if ! docker info &>/dev/null; then
        err "Docker daemon is not running. Start Docker and try again."
    fi
    # Check docker compose
    if ! docker compose version &>/dev/null 2>&1; then
        if ! docker-compose version &>/dev/null 2>&1; then
            err "Docker Compose is not installed. Please install Docker Compose."
        fi
    fi
    ok "Docker is ready"
}

# ── Build Wizard Image ──────────────────────────────────────────
build_wizard() {
    log "Building install wizard image..."
    docker build -t "$WIZARD_IMAGE" "$SCRIPT_DIR/install-wizard" || err "Failed to build wizard image"
    ok "Wizard image built"
}

# ── Pre-build BeeFlow Services ──────────────────────────────────
# Skipped: the wizard handles building during deployment with
# all required env vars (DB_PASSWORD, RUSTFS_SECRET_KEY, etc.)
# which are auto-generated at install time.
build_services() {
    log "Skipping pre-build (wizard builds during deployment)"
}

# ── Run Wizard ───────────────────────────────────────────────────
run_wizard() {
    # Stop any existing wizard container
    docker rm -f "$WIZARD_CONTAINER" 2>/dev/null || true

    log "Starting install wizard on port $WIZARD_PORT..."
    docker run -d \
        --name "$WIZARD_CONTAINER" \
        -p "${WIZARD_PORT}:9090" \
        -v /var/run/docker.sock:/var/run/docker.sock \
        -v "$SCRIPT_DIR":/project \
        -e HOST_PROJECT_DIR="$SCRIPT_DIR" \
        --restart unless-stopped \
        "$WIZARD_IMAGE"

    sleep 2

    if docker ps --format '{{.Names}}' | grep -q "$WIZARD_CONTAINER"; then
        ok "Install wizard is running!"
        echo ""
        echo -e "  ${BOLD}🐝 Open your browser:${NC}"
        echo -e "  ${CYAN}   http://localhost:${WIZARD_PORT}${NC}"
        echo ""
        echo -e "  ${YELLOW}The wizard will guide you through configuring and"
        echo -e "  deploying all BeeFlow services.${NC}"
        echo ""

        # Try to open browser (best-effort)
        if command -v xdg-open &>/dev/null; then
            xdg-open "http://localhost:${WIZARD_PORT}" 2>/dev/null &
        elif command -v open &>/dev/null; then
            open "http://localhost:${WIZARD_PORT}" 2>/dev/null &
        fi
    else
        err "Wizard container failed to start. Check: docker logs $WIZARD_CONTAINER"
    fi
}

# ── Stop Wizard ──────────────────────────────────────────────────
stop_wizard() {
    log "Stopping wizard container..."
    docker rm -f "$WIZARD_CONTAINER" 2>/dev/null || true
    ok "Wizard stopped"
}

# ── Status ───────────────────────────────────────────────────────
show_status() {
    echo -e "${CYAN}════════════════════════════════════════${NC}"
    echo -e "${CYAN}  BeeFlow Container Status${NC}"
    echo -e "${CYAN}════════════════════════════════════════${NC}"
    echo ""

    # Wizard
    if docker ps --format '{{.Names}}' | grep -q "$WIZARD_CONTAINER"; then
        echo -e "  ${GREEN}●${NC} Install Wizard   — http://localhost:${WIZARD_PORT}"
    else
        echo -e "  ${RED}●${NC} Install Wizard   — not running"
    fi

    # BeeFlow containers
    echo ""
    docker ps --format "  {{.Names}}\t{{.Status}}\t{{.Ports}}" --filter "name=beeflow" --filter "name=search" --filter "name=guard" --filter "name=whisperx" 2>/dev/null || true
    echo ""
}

# ── Uninstall ────────────────────────────────────────────────────
uninstall() {
    echo -e "${RED}⚠️  This will stop and remove ALL BeeFlow containers,${NC}"
    echo -e "${RED}   data volumes, and built images.${NC}"
    echo ""
    read -p "Type 'yes' to confirm: " confirm
    if [ "$confirm" != "yes" ]; then
        echo "Aborted."
        exit 1
    fi

    log "Stopping and removing all BeeFlow containers..."
    if [ -f "$COMPOSE_FILE" ]; then
        docker compose -f "$COMPOSE_FILE" \
            --profile core --profile search --profile search-gpu --profile search-llm \
            --profile guard --profile guard-gpu --profile whisperx --profile pii \
            --profile local-llm \
            down --volumes --rmi local 2>/dev/null || true
    fi
    # Also force-remove any stray containers started from other compose files
    STRAY=$(docker ps -a --format '{{.Names}}' | grep -E '^(beeflow-|search-|guard-|whisperx-)' 2>/dev/null || true)
    if [ -n "$STRAY" ]; then
        echo "$STRAY" | xargs docker rm -f 2>/dev/null || true
    fi
    docker rm -f "$WIZARD_CONTAINER" 2>/dev/null || true
    ok "All BeeFlow containers removed"

    log "Removing data volumes..."
    docker volume rm \
        beeflow-data beeflow-pgdata \
        rustfs-data rustfs-logs \
        search-pgdata search-redis-data search-hf-cache \
        guard-redis-data \
        whisperx-cache \
        pii-model-cache \
        2>/dev/null || true
    ok "Data volumes removed"

    log "Removing BeeFlow images..."
    docker rmi \
        beeflow-install-wizard \
        beeflow-server beeflow-agent-hub \
        search-api search-inference-gpu \
        beeflow-guard beeflow-pii \
        whisperx-service \
        2>/dev/null || true
    ok "Images removed"

    echo ""
    ok "BeeFlow fully uninstalled"
}

# ── Main ─────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}════════════════════════════════════════${NC}"
echo -e "${CYAN}  🐝 BeeFlow Install Wizard${NC}"
echo -e "${CYAN}════════════════════════════════════════${NC}"
echo ""

case "${1:-}" in
    --stop)
        stop_wizard
        ;;
    --status)
        show_status
        ;;
    --uninstall)
        uninstall
        ;;
    --help|-h)
        echo "Usage: ./install.sh [command]"
        echo ""
        echo "Commands:"
        echo "  (none)        Build and start the install wizard"
        echo "  --stop        Stop the wizard container"
        echo "  --status      Show all BeeFlow container status"
        echo "  --uninstall   Stop all BeeFlow containers"
        echo "  --help        Show this help"
        echo ""
        echo "The wizard runs at http://localhost:${WIZARD_PORT}"
        ;;
    *)
        check_docker
        build_wizard
        build_services
        run_wizard
        ;;
esac
