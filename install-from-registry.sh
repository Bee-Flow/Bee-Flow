#!/bin/bash
# ══════════════════════════════════════════════════════════════════
# BeeFlow — Registry-Based Install Wizard Launcher  [ADVANCED / LEGACY]
# ══════════════════════════════════════════════════════════════════
#
# ⚠️  For an easy self-host install, use ./selfhost.sh instead. It pulls
#     PUBLIC images from ghcr.io/bee-flow (no login, no credentials) and
#     brings up the stack directly — no wizard needed.
#
# This script launches the graphical install wizard and pulls images from
# a private registry, which requires a .credentials file. Keep it
# only for the credentialed/wizard-driven flow.
#
# Like install.sh, but pulls pre-built images from that registry instead
# of building them locally. No source code required on target machine
# (except this script and .credentials).
#
# Usage:
#   ./install-from-registry.sh              # Start the install wizard
#   ./install-from-registry.sh --stop       # Stop the wizard container
#   ./install-from-registry.sh --status     # Check what's running
#   ./install-from-registry.sh --uninstall  # Stop all BeeFlow containers
#   ./install-from-registry.sh --help       # Show this help
#
# Credentials:
#   Create a .credentials file next to this script:
#
#     REGISTRY=registry.example.com
#     REGISTRY_USER=your-registry-user
#     REGISTRY_TOKEN=your-registry-token
#
#   The wizard's update check sends these credentials over verified HTTPS
#   only. For a registry with a self-signed certificate add
#   REGISTRY_INSECURE_TLS=1; for a plain-HTTP registry add
#   REGISTRY_ALLOW_HTTP=1 (that request goes without credentials).
#
# The wizard opens at http://localhost:9090
# ══════════════════════════════════════════════════════════════════
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WIZARD_IMAGE="beeflow-install-wizard"
WIZARD_CONTAINER="beeflow-wizard"
WIZARD_PORT="${WIZARD_PORT:-9090}"

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

# ── Load credentials ─────────────────────────────────────────────
# Look for .credentials next to this script, or in deploy/registry/
load_credentials() {
    local cred_file=""

    if [ -f "$SCRIPT_DIR/.credentials" ]; then
        cred_file="$SCRIPT_DIR/.credentials"
    elif [ -f "$SCRIPT_DIR/deploy/registry/.credentials" ]; then
        cred_file="$SCRIPT_DIR/deploy/registry/.credentials"
    else
        err "Missing credentials file. Create .credentials next to this script with:
  REGISTRY=registry.example.com
  REGISTRY_USER=<your-registry-user>
  REGISTRY_TOKEN=<your-token>"
    fi

    # shellcheck source=/dev/null
    source "$cred_file"

    if [ -z "$REGISTRY" ]; then
        err "Missing REGISTRY in $cred_file"
    fi

    if [ -z "$REGISTRY_USER" ] || [ -z "$REGISTRY_TOKEN" ]; then
        err "Missing REGISTRY_USER or REGISTRY_TOKEN in $cred_file"
    fi

    ok "Credentials loaded (registry: $REGISTRY)"
}

# ── Check Docker ─────────────────────────────────────────────────
check_docker() {
    if ! command -v docker &>/dev/null; then
        err "Docker is not installed. Please install Docker first: https://docs.docker.com/get-docker/"
    fi
    if ! docker info &>/dev/null; then
        err "Docker daemon is not running. Start Docker and try again."
    fi
    if ! docker compose version &>/dev/null 2>&1; then
        if ! docker-compose version &>/dev/null 2>&1; then
            err "Docker Compose is not installed. Please install Docker Compose."
        fi
    fi
    ok "Docker is ready"
}

# ── Login + pull wizard image ────────────────────────────────────
pull_wizard() {
    log "Logging into registry ($REGISTRY)..."
    echo "$REGISTRY_TOKEN" | docker login "$REGISTRY" -u "$REGISTRY_USER" --password-stdin \
        || err "Failed to login to $REGISTRY — check your credentials"
    ok "Registry login successful"

    log "Pulling install wizard image..."
    docker pull "$REGISTRY/beeflow/wizard:latest" \
        && docker tag "$REGISTRY/beeflow/wizard:latest" "$WIZARD_IMAGE" \
        || {
            warn "Wizard image not found in registry — building locally instead"
            if [ -d "$SCRIPT_DIR/install-wizard" ]; then
                docker build -t "$WIZARD_IMAGE" "$SCRIPT_DIR/install-wizard" \
                    || err "Failed to build wizard image locally"
            else
                err "No install-wizard directory found and no wizard image in registry"
            fi
        }
    ok "Wizard image ready"
}

# ── Run Wizard ───────────────────────────────────────────────────
run_wizard() {
    # Stop any existing wizard container
    docker rm -f "$WIZARD_CONTAINER" 2>/dev/null || true

    log "Starting install wizard on port $WIZARD_PORT..."
    docker run -d \
        --name "$WIZARD_CONTAINER" \
        -p "127.0.0.1:${WIZARD_PORT}:9090" \
        -v /var/run/docker.sock:/var/run/docker.sock \
        -v "$SCRIPT_DIR":/project \
        -e REGISTRY_MODE=1 \
        -e REGISTRY_URL="$REGISTRY" \
        -e REGISTRY_USER="$REGISTRY_USER" \
        -e REGISTRY_TOKEN="$REGISTRY_TOKEN" \
        -e REGISTRY_INSECURE_TLS="${REGISTRY_INSECURE_TLS:-}" \
        -e REGISTRY_ALLOW_HTTP="${REGISTRY_ALLOW_HTTP:-}" \
        -e COMPOSE_FILE="docker-compose.from-registry.yml" \
        --restart unless-stopped \
        "$WIZARD_IMAGE"

    sleep 2

    if docker ps --format '{{.Names}}' | grep -q "$WIZARD_CONTAINER"; then
        ok "Install wizard is running!"
        echo ""
        echo -e "  ${BOLD}🐝 Open your browser:${NC}"
        echo -e "  ${CYAN}   http://localhost:${WIZARD_PORT}${NC}"
        echo ""
        echo -e "  ${YELLOW}The wizard is only reachable from this machine (loopback).${NC}"
        echo -e "  ${YELLOW}Remote/headless install? Forward the port over SSH:${NC}"
        echo -e "  ${CYAN}   ssh -L ${WIZARD_PORT}:localhost:${WIZARD_PORT} user@$(hostname)${NC}"
        echo ""
        echo -e "  ${YELLOW}The wizard will pull service images from the registry on demand${NC}"
        echo -e "  ${YELLOW}and guide you through deploying BeeFlow.${NC}"
        echo ""

        # Try to open browser
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

    if docker ps --format '{{.Names}}' | grep -q "$WIZARD_CONTAINER"; then
        echo -e "  ${GREEN}●${NC} Install Wizard   — http://localhost:${WIZARD_PORT} (loopback only)"
    else
        echo -e "  ${RED}●${NC} Install Wizard   — not running"
    fi

    echo ""
    docker ps --format "  {{.Names}}\t{{.Status}}\t{{.Ports}}" \
        --filter "name=beeflow" --filter "name=search" \
        --filter "name=guard" --filter "name=whisperx" 2>/dev/null || true
    echo ""
}

# ── Uninstall ────────────────────────────────────────────────────
uninstall() {
    echo -e "${RED}⚠️  This will stop and remove ALL BeeFlow containers,${NC}"
    echo -e "${RED}   data volumes, and pulled images.${NC}"
    echo ""
    # The confirmation must come from a human at a terminal: read from
    # /dev/tty, never stdin — `echo yes | ./install-from-registry.sh --uninstall`
    # (or a stray `yes` in a wrapper script) must not be able to pass this gate.
    # No controlling terminal (CI, cron, piped scripts) means no confirmation
    # is possible, so refuse outright instead of falling back to stdin.
    if ! { : < /dev/tty; } 2>/dev/null; then
        err "No terminal available for the confirmation prompt — refusing to delete data.
        (--uninstall must be run interactively; piped input is deliberately ignored.)"
    fi
    read -r -p "Type 'yes' to confirm: " confirm < /dev/tty \
        || { echo "Aborted."; exit 1; }
    if [ "$confirm" != "yes" ]; then
        echo "Aborted."
        exit 1
    fi

    local compose_file="$SCRIPT_DIR/docker-compose.from-registry.yml"
    [ ! -f "$compose_file" ] && compose_file="$SCRIPT_DIR/docker-compose.install.yml"

    log "Stopping and removing all BeeFlow containers..."
    if [ -f "$compose_file" ]; then
        docker compose -f "$compose_file" \
            --profile core --profile search --profile search-gpu --profile search-llm \
            --profile guard --profile whisperx --profile pii \
            --profile local-llm --profile classify --profile analytics \
            down --volumes 2>/dev/null || true
    fi

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
        guard-redis-data whisperx-cache pii-model-cache \
        ollama-models \
        2>/dev/null || true
    ok "Data volumes removed"

    ok "BeeFlow fully uninstalled"
}

# ── Main ─────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}════════════════════════════════════════${NC}"
echo -e "${CYAN}  🐝 BeeFlow Install Wizard (Registry)${NC}"
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
        load_credentials
        uninstall
        ;;
    --help|-h)
        echo "Usage: ./install-from-registry.sh [command]"
        echo ""
        echo "Commands:"
        echo "  (none)        Pull images from the registry and start the install wizard"
        echo "  --stop        Stop the wizard container"
        echo "  --status      Show all BeeFlow container status"
        echo "  --uninstall   Stop all BeeFlow containers and remove data"
        echo "  --help        Show this help"
        echo ""
        echo "Credentials: .credentials file (same format as deploy/registry/.credentials)"
        echo "Wizard runs at: http://localhost:${WIZARD_PORT} (this machine only)"
        ;;
    *)
        check_docker
        load_credentials
        pull_wizard
        run_wizard
        ;;
esac
