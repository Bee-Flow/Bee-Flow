#!/bin/bash
# ══════════════════════════════════════════════════════════════════
# Bee Flow — shared sidecars for several stacks on one machine
# ══════════════════════════════════════════════════════════════════
#
# Runs docker-compose.sidecars.yml: ONE guard (PII detection), classifier
# and, optionally, Ollama that several Bee Flow stacks on this host share.
# Each stack is a ./selfhost.sh install with its own STACK_NAME; this script
# gives every one of them its own internal network (`<stack>-sidecars`) with
# the sidecars on it, and nothing else. The stacks never share a network.
#
# Usage:
#   SIDECAR_STACKS="public internal" ./selfhost-sidecars.sh
#                              Create .env.sidecars on first run, generate the
#                              per-stack networks, pull and start the sidecars.
#                              Then start each stack with
#                              SHARED_SIDECARS="guard classify" STACK_NAME=<stack> ./selfhost.sh
#   ./selfhost-sidecars.sh --upgrade   Pull the TAG of .env.sidecars and recreate.
#                              Upgrade the sidecars BEFORE the stacks.
#   ./selfhost-sidecars.sh --status    Show the sidecar containers
#   ./selfhost-sidecars.sh --logs      Tail the guard's logs
#   ./selfhost-sidecars.sh --stop      Stop the sidecars (every stack that uses
#                              the guard blocks chat until they are back:
#                              the guard fails closed)
#   ./selfhost-sidecars.sh --down      Remove the containers and the per-stack
#                              networks (stop the stacks first: a network with
#                              a server on it cannot be removed)
#   ./selfhost-sidecars.sh --uninstall Also remove the downloaded Ollama models
#   ./selfhost-sidecars.sh --help
#
# Profiles (which sidecars run), saved as PROFILES= in .env.sidecars; an
# explicit value on the command line wins and is re-saved:
#   PROFILES="guard classify local-llm" ./selfhost-sidecars.sh
#
# SIDECAR_STACKS is saved the same way. Adding a stack later: re-run with the
# longer list; the new network is created and the sidecars join it. Removing
# one: stop that stack, re-run with the shorter list.
# ══════════════════════════════════════════════════════════════════
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.sidecars.yml"
NETWORKS_FILE="$SCRIPT_DIR/docker-compose.sidecars.networks.yml"
ENV_FILE="$SCRIPT_DIR/.env.sidecars"
ENV_TEMPLATE="$SCRIPT_DIR/.env.sidecars.example"
PROJECT="${SIDECARS_NAME:-beeflow-sidecars}"
export SIDECARS_NAME="$PROJECT"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${CYAN}[sidecars]${NC} $1"; }
ok()   { echo -e "${GREEN}[ok]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }
err()  { echo -e "${RED}[error]${NC} $1"; exit 1; }

# Same helpers as selfhost.sh (this file must work without it next to it).
env_get() { # $1=key
    [ -f "$ENV_FILE" ] || return 0
    local v
    v=$( (grep -E "^$1=" "$ENV_FILE" || true) | tail -n1 | cut -d= -f2-)
    v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
    printf '%s' "$v"
}
set_env() { # $1=key $2=value
    local key="$1" val="$2"
    if grep -qE "^${key}=" "$ENV_FILE"; then
        local esc; esc=$(printf '%s' "$val" | sed -e 's/[\/&|]/\\&/g')
        sed -i.bak "s|^${key}=.*|${key}=${esc}|" "$ENV_FILE" && rm -f "${ENV_FILE}.bak"
    else
        [ -s "$ENV_FILE" ] && [ -n "$(tail -c1 "$ENV_FILE")" ] && echo >> "$ENV_FILE"
        printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
    fi
}
gen_hex() { # $1 = byte length
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex "$1"
    else
        head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
    fi
}

# ── Choices: command line wins, else the saved value ─────────────
PROFILES_EXPLICIT=false
[ -n "${PROFILES+x}" ] && PROFILES_EXPLICIT=true
[ "$PROFILES_EXPLICIT" = true ] || PROFILES="$(env_get PROFILES)"
PROFILES="${PROFILES:-guard classify}"

STACKS_EXPLICIT=false
[ -n "${SIDECAR_STACKS+x}" ] && STACKS_EXPLICIT=true
[ "$STACKS_EXPLICIT" = true ] || SIDECAR_STACKS="$(env_get SIDECAR_STACKS)"

# A stack name is a compose project name and a Docker network name: lowercase
# letters, digits and dashes, not starting with a dash.
valid_stack_name() { # $1=name → 0 when usable
    case "$1" in
        ''|-*|*[!a-z0-9-]*) return 1 ;;
    esac
    return 0
}

check_stacks() {
    [ -n "$SIDECAR_STACKS" ] || err "SIDECAR_STACKS is empty: name the stacks that use these sidecars, e.g.
        SIDECAR_STACKS=\"public internal\" ./selfhost-sidecars.sh"
    local s
    for s in $SIDECAR_STACKS; do
        valid_stack_name "$s" || err "SIDECAR_STACKS: \"$s\" is not a stack name (lowercase letters, digits, dashes)"
    done
    for s in $PROFILES; do
        case "$s" in guard|classify|local-llm) ;; *) err "PROFILES: unknown sidecar \"$s\" (guard, classify, local-llm)" ;; esac
    done
}

# The per-stack networks as a compose file: one internal network per stack,
# attached to every sidecar. Generated because a compose file cannot loop.
# Only the services are named here; a profile that is not running is simply
# not started, its network entry does no harm.
networks_yaml() { # $1 = stack names, space-separated → stdout
    local s svc
    echo "# GENERATED by selfhost-sidecars.sh from SIDECAR_STACKS — do not edit, re-run the script."
    echo "services:"
    for svc in guard-service classify-service ollama; do
        echo "  $svc:"
        echo "    networks:"
        for s in $1; do echo "      - stack-$s"; done
    done
    echo "networks:"
    for s in $1; do
        echo "  stack-$s:"
        echo "    name: $s-sidecars"
        echo "    internal: true"
    done
}

write_networks_file() {
    networks_yaml "$SIDECAR_STACKS" > "$NETWORKS_FILE"
    log "Networks: $(for s in $SIDECAR_STACKS; do printf '%s-sidecars ' "$s"; done)(internal, one per stack)"
}

compose() {
    local args=()
    local p
    for p in $PROFILES; do args+=(--profile "$p"); done
    if docker compose version >/dev/null 2>&1; then
        docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -f "$NETWORKS_FILE" "${args[@]}" "$@"
    else
        docker-compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -f "$NETWORKS_FILE" "${args[@]}" "$@"
    fi
}

check_docker() {
    command -v docker >/dev/null 2>&1 || err "Docker is not installed: https://docs.docker.com/get-docker/"
    docker info >/dev/null 2>&1 || err "Docker daemon is not running. Start Docker and retry."
}

ensure_env() {
    if [ ! -f "$ENV_FILE" ]; then
        [ -f "$ENV_TEMPLATE" ] || err "Missing $ENV_TEMPLATE next to this script."
        log "Creating $(basename "$ENV_FILE") from the template"
        (umask 077 && cp "$ENV_TEMPLATE" "$ENV_FILE")
        chmod 600 "$ENV_FILE"
    fi
    local key; key="$(env_get SERVICES_API_KEY)"
    if [ -z "$key" ] || [ "$key" = "CHANGE_ME" ]; then
        key="$(gen_hex 24)"
        set_env SERVICES_API_KEY "$key"
        ok "Generated SERVICES_API_KEY in $(basename "$ENV_FILE")"
    fi
    [ "$PROFILES_EXPLICIT" = true ] && [ "$(env_get PROFILES)" != "$PROFILES" ] && set_env PROFILES "$PROFILES"
    [ "$STACKS_EXPLICIT" = true ] && [ "$(env_get SIDECAR_STACKS)" != "$SIDECAR_STACKS" ] && set_env SIDECAR_STACKS "$SIDECAR_STACKS"
    return 0
}

wait_for_guard() {
    case " $PROFILES " in *" guard "*) ;; *) return 0 ;; esac
    log "Waiting for the guard to load its model…"
    local st
    for _ in $(seq 1 60); do
        st="$(docker inspect --format '{{.State.Health.Status}}' "${PROJECT}-guard" 2>/dev/null || true)"
        if [ "$st" = "healthy" ]; then ok "Guard is healthy"; return 0; fi
        sleep 3
    done
    warn "The guard is not healthy after ~3 min; every stack that uses it blocks chat until it is. Check: ./selfhost-sidecars.sh --logs"
}

print_done() {
    local key; key="$(env_get SERVICES_API_KEY)"
    echo ""
    ok "Shared sidecars are up: $PROFILES, for the stacks: $SIDECAR_STACKS"
    echo ""
    echo "  In each stack's env file (.env.<stack>) set:"
    echo "    PII_SERVICE_API_KEY=$key"
    echo "    CLASSIFY_SERVICE_API_KEY=$key"
    echo "  then start it with:"
    echo "    SHARED_SIDECARS=\"$PROFILES\" STACK_NAME=<stack> ./selfhost.sh"
    echo ""
}

up() {
    check_docker
    ensure_env
    check_stacks
    write_networks_file
    log "Pulling images (TAG=$(env_get TAG || true))…"
    compose pull || warn "Some images failed to pull; continuing"
    log "Starting: $PROFILES"
    compose up -d --remove-orphans
    wait_for_guard
    print_done
}

upgrade() {
    [ -f "$ENV_FILE" ] || err "No $(basename "$ENV_FILE") next to this script — run ./selfhost-sidecars.sh first."
    check_docker
    ensure_env
    check_stacks
    write_networks_file
    log "Pulling images (TAG=$(env_get TAG || true))…"
    compose pull || err "Pull failed — the running sidecars were NOT touched."
    compose up -d --remove-orphans
    wait_for_guard
    ok "Sidecars upgraded. Now upgrade each stack: STACK_NAME=<stack> ./selfhost.sh --upgrade"
}

teardown() { # $1 = extra compose down flags
    [ -f "$ENV_FILE" ] || err "No $(basename "$ENV_FILE") next to this script — nothing to remove."
    check_stacks
    [ -f "$NETWORKS_FILE" ] || write_networks_file
    warn "Every stack with SHARED_SIDECARS set blocks chat while the guard is gone, and a"
    warn "stack that is still running keeps its network: stop those stacks first."
    # shellcheck disable=SC2086
    compose down $1
}

case "${1:-}" in
    ""|--install|up)
        up ;;
    --upgrade)
        upgrade ;;
    --status)
        docker ps --filter "name=${PROJECT}-" --format "  {{.Names}}\t{{.Status}}" ;;
    --logs)
        [ -f "$NETWORKS_FILE" ] || write_networks_file
        compose logs -f "${2:-guard-service}" ;;
    --stop)
        [ -f "$NETWORKS_FILE" ] || write_networks_file
        warn "Every stack with SHARED_SIDECARS set blocks chat while the guard is stopped."
        compose stop ;;
    --down)
        teardown "" ;;
    --uninstall)
        teardown "--volumes" ;;
    --help|-h)
        awk 'NR>1 { if (!/^#/) exit; print }' "$0" ;;
    *)
        err "Unknown option: $1  (try --help)" ;;
esac
