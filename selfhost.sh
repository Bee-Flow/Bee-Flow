#!/bin/bash
# ══════════════════════════════════════════════════════════════════
# Bee Flow — Self-Host Installer (public images, no login, no clone)
# ══════════════════════════════════════════════════════════════════
#
# The easy way to run your own Bee Flow server. Pulls prebuilt images
# from the public GitHub Container Registry (ghcr.io/bee-flow), generates
# secrets, and starts the core stack with docker compose.
#
# Usage:
#   ./selfhost.sh              Install / start the core stack (server + UI + DB)
#   ./selfhost.sh --upgrade    Upgrade an existing install to the TAG in .env:
#                              show current tag+digest, pull, recreate, run DB
#                              migrations, verify health + schema — and print
#                              rollback steps if anything fails. Safe to re-run.
#   ./selfhost.sh --status     Show running Bee Flow containers
#   ./selfhost.sh --logs       Tail the server logs
#   ./selfhost.sh --stop       Stop all Bee Flow containers (keeps everything)
#   ./selfhost.sh --down       Remove all Bee Flow containers (keeps data volumes)
#   ./selfhost.sh --uninstall  Remove containers AND data volumes (DESTRUCTIVE:
#                              deletes the databases — including your activated
#                              licence — and all uploads; asks you to type the
#                              product name to confirm, on the terminal itself —
#                              piped input is ignored: no terminal, no deletion)
#   ./selfhost.sh --help       Show this help
#
# Profiles — choose once, reused by every later run (saved as PROFILES= in
# .env; an explicit PROFILES="…" on the command line wins and is re-saved):
#   PROFILES="core guard" ./selfhost.sh
#
# Several stacks on one machine (e.g. one reachable from the internet, one
# for the sensitive data on the LAN only), each with its own env file
# (.env.<name>), containers, networks, volumes and ports:
#   STACK_NAME=internal ./selfhost.sh
# and, to let those stacks share ONE guard / classifier / Ollama run by
# ./selfhost-sidecars.sh instead of running their own:
#   SHARED_SIDECARS="guard classify" STACK_NAME=internal ./selfhost.sh
# Docs: https://docs.beeflow.ai/self-hosting/multi-stack
#
# Docker socket — OFF by default (whoever holds the socket holds the host).
# Only the guard installer, the browser-runner fallback and Docker-backed Hub
# modules need it. Opt in once; it is saved as DOCKER_SOCKET= in .env:
#   DOCKER_SOCKET=1 ./selfhost.sh
#
# Run models on your own hardware (no API keys, no per-token cost):
#   PROFILES="core local-llm" ./selfhost.sh
# then set OLLAMA_URL=http://ollama:11434 in .env, restart, and download a
# model from Admin → AI → Providers → Local models.
#
# Licence keys: the free community tier needs nothing. To validate a paid
# licence key, set LICENSE_PUBLIC_KEY (inline PEM) or
# LICENSE_PUBLIC_KEY_FILE=/app/data/license-public-key.pem in .env — the
# compose file passes these (plus LICENSE_UPGRADE_URL) through to the
# server; all three are documented in .env.selfhost.example. A JWKS
# endpoint (LICENSE_JWKS_URL) is passed through as well — that one is
# documented in docker-compose.from-registry.yml itself.
#
# Upgrading? Pin TAG in .env to an immutable tag first — details and backup
# steps: https://docs.beeflow.ai/self-hosting/upgrades
#
# After it's up, connect your Nextcloud from:
#   Nextcloud → Settings → Administration → AI → Bee Flow
#   → pick "Self-hosted server" and enter this server's URL.
# ══════════════════════════════════════════════════════════════════
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.from-registry.yml"
ENV_FILE="$SCRIPT_DIR/.env"
ENV_TEMPLATE="$SCRIPT_DIR/.env.selfhost.example"
DOCS_UPGRADES="https://docs.beeflow.ai/self-hosting/upgrades"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'
log()  { echo -e "${CYAN}[selfhost]${NC} $1"; }
ok()   { echo -e "${GREEN}[ok]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }
err()  { echo -e "${RED}[error]${NC} $1"; exit 1; }

# ── Read a value from .env ───────────────────────────────────────
# Last KEY= line wins (same as docker compose); surrounding quotes stripped.
# Never fails, so it is safe under `set -eo pipefail` for absent keys.
env_get() { # $1=key
    [ -f "$ENV_FILE" ] || return 0
    local v
    v=$( (grep -E "^$1=" "$ENV_FILE" || true) | tail -n1 | cut -d= -f2-)
    v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
    printf '%s' "$v"
}

# ── Stack name: several stacks on one machine ────────────────────
# STACK_NAME=<name> ./selfhost.sh runs this install as compose project <name>
# with its own env file (.env.<name>), its own container, network and volume
# names (<name>-server, <name>-network, <name>-pgdata, <name>-rustfs-data, …)
# and its own components directory, so a second stack on the host never
# collides with the first and never shares a network with it. The plain
# install (no STACK_NAME) stays project-less and keeps every name it had.
# Docs: Self-hosting → Several stacks on one machine.
STACK_NAME="${STACK_NAME:-}"
PROJECT_ARGS=()
if [ -n "$STACK_NAME" ]; then
    case "$STACK_NAME" in
        beeflow) err "STACK_NAME=beeflow is the plain install: run ./selfhost.sh without STACK_NAME" ;;
        -*|*[!a-z0-9-]*) err "STACK_NAME must be lowercase letters, digits and dashes, not starting with a dash (got: $STACK_NAME)" ;;
    esac
    ENV_FILE="$SCRIPT_DIR/.env.$STACK_NAME"
    export STACK_NAME
    export STACK_VOLUME_PREFIX="${STACK_NAME}-"
    export COMPONENTS_DIR="./components.$STACK_NAME"
    # --env-file: a named stack reads ITS file only, never the plain .env.
    PROJECT_ARGS=(-p "$STACK_NAME" --env-file "$ENV_FILE")
fi
STACK_LABEL="${STACK_NAME:-beeflow}"
SERVER_CONTAINER="${STACK_LABEL}-server"

# ── Profile selection ────────────────────────────────────────────
# An explicit PROFILES="…" on the command line wins; otherwise the PROFILES=
# saved in .env by a previous install/upgrade; otherwise just core. Without
# the saved value a bare re-run used to silently fall back to core and leave
# any sidecar profiles behind on pull/up/stop.
PROFILES_EXPLICIT=false
[ -n "${PROFILES+x}" ] && PROFILES_EXPLICIT=true
if [ "$PROFILES_EXPLICIT" = false ]; then
    PROFILES="$(env_get PROFILES)"
fi
PROFILES="${PROFILES:-core}"

# Docker socket opt-in: same precedence as PROFILES (command line wins, else
# the DOCKER_SOCKET= saved in .env, else off).
DOCKER_SOCKET_EXPLICIT=false
[ -n "${DOCKER_SOCKET+x}" ] && DOCKER_SOCKET_EXPLICIT=true
if [ "$DOCKER_SOCKET_EXPLICIT" = false ]; then
    DOCKER_SOCKET="$(env_get DOCKER_SOCKET)"
fi
DOCKER_SOCKET="${DOCKER_SOCKET:-0}"
SOCKET_OVERRIDE="$SCRIPT_DIR/docker-compose.docker-socket.override.yml"

# Shared sidecars: SHARED_SIDECARS="guard classify" (also local-llm) means
# this stack does not run those profiles itself but joins the
# `<stack>-sidecars` network that ./selfhost-sidecars.sh created for it and
# reaches the shared guard / classifier / Ollama there. Same precedence as
# PROFILES (command line wins, else the value saved in the env file, else
# none); wire_shared_sidecars() does the checks and the wiring.
SHARED_SIDECARS_EXPLICIT=false
[ -n "${SHARED_SIDECARS+x}" ] && SHARED_SIDECARS_EXPLICIT=true
if [ "$SHARED_SIDECARS_EXPLICIT" = false ]; then
    SHARED_SIDECARS="$(env_get SHARED_SIDECARS)"
fi
SHARED_OVERRIDE="$SCRIPT_DIR/docker-compose.shared-sidecars.override.yml"

# Every profile declared in docker-compose.from-registry.yml — keep in sync
# when a profile is added there. Used where the whole install must be covered
# no matter which subset was started (--stop / --down / --uninstall).
ALL_PROFILES="core guard classify local-llm analytics"

# ── Compose command (v2 plugin or legacy binary) ─────────────────
compose() {
    if docker compose version >/dev/null 2>&1; then
        docker compose "${PROJECT_ARGS[@]}" "$@"
    else
        docker-compose "${PROJECT_ARGS[@]}" "$@"
    fi
}

# The -f arguments of every compose call: the registry stack, plus the Docker
# socket override when the operator opted in, plus the shared-sidecars
# override when the stack uses them (an array: paths may hold spaces).
COMPOSE_FILES=(-f "$COMPOSE_FILE")
[ "$DOCKER_SOCKET" = "1" ] && COMPOSE_FILES+=(-f "$SOCKET_OVERRIDE")
[ -n "$SHARED_SIDECARS" ] && COMPOSE_FILES+=(-f "$SHARED_OVERRIDE")

profile_args() {
    local args=()
    for p in $PROFILES; do args+=(--profile "$p"); done
    printf '%s\n' "${args[@]}"
}

all_profile_args() {
    local args=()
    for p in $ALL_PROFILES; do args+=(--profile "$p"); done
    printf '%s\n' "${args[@]}"
}

# ── PII Guard wiring ─────────────────────────────────────────────
# The server resolves the guard from PII_SERVICE_URL (or from `pii_guard_url`
# in the config store, written by the dashboard's install action). The compose
# file leaves it EMPTY on purpose: pointing a core-only stack at a host that
# only exists under `--profile guard` turns "not configured" into "configured
# but unreachable", and those are different paths — the second one degrades and
# then applies piiFailureMode, which defaults to fail_closed. So the value is
# set here, and only when the guard is actually part of this run.
#
# An operator who already set PII_SERVICE_URL (own guard, k8s, a host outside
# compose) keeps it: this only fills a blank.
wire_guard() {
    case " $PROFILES " in
        *" guard "*) ;;
        *) return 0 ;;
    esac
    if [ -n "${PII_SERVICE_URL:-}" ]; then
        log "PII Guard: using PII_SERVICE_URL from the environment"
        return 0
    fi
    if grep -qE '^[[:space:]]*PII_SERVICE_URL=[^[:space:]]' "$ENV_FILE" 2>/dev/null; then
        log "PII Guard: using PII_SERVICE_URL from $ENV_FILE"
        return 0
    fi
    export PII_SERVICE_URL="http://guard-service:8100"
    log "PII Guard: wired to $PII_SERVICE_URL (guard profile is up)"
}

# ── Topic classifier wiring ──────────────────────────────────────
# Same reasoning as wire_guard: the compose file leaves CLASSIFY_SERVICE_URL
# empty, because a URL that only resolves under `--profile classify` would turn
# "no classifier" into "classifier unreachable" on every run without it. Set
# here only when the profile is part of this run, and never over a value the
# operator already set.
wire_classify() {
    case " $PROFILES " in
        *" classify "*) ;;
        *) return 0 ;;
    esac
    if [ -n "${CLASSIFY_SERVICE_URL:-}" ]; then
        log "Classifier: using CLASSIFY_SERVICE_URL from the environment"
        return 0
    fi
    if grep -qE '^[[:space:]]*CLASSIFY_SERVICE_URL=[^[:space:]]' "$ENV_FILE" 2>/dev/null; then
        log "Classifier: using CLASSIFY_SERVICE_URL from $ENV_FILE"
        return 0
    fi
    export CLASSIFY_SERVICE_URL="http://classify-service:8300"
    log "Classifier: wired to $CLASSIFY_SERVICE_URL (classify profile is up)"
}

# Export KEY=VALUE as a default: only when the environment does not set it and
# the env file has no non-empty KEY= line (compose: environment beats the file,
# so exporting over an operator's value would silently win).
default_env() { # $1=key $2=value [$3=log line]
    [ -n "${!1:-}" ] && return 0
    grep -qE "^[[:space:]]*$1=[^[:space:]]" "$ENV_FILE" 2>/dev/null && return 0
    export "$1=$2"
    [ -n "${3:-}" ] && log "$3"
    return 0
}

env_has() { # $1=key → 0 when the environment or the env file sets it non-empty
    [ -n "${!1:-}" ] && return 0
    grep -qE "^[[:space:]]*$1=[^[:space:]]" "$ENV_FILE" 2>/dev/null
}

# ── Shared sidecars wiring ───────────────────────────────────────
# A stack uses the shared guard / classifier / Ollama of ./selfhost-sidecars.sh
# instead of its own: the same profile may not run here as well (two services
# of one name on the server's networks), the per-stack network must already
# exist (the override declares it external), and the server must send the
# sidecars' key, which is NOT this stack's SERVICES_API_KEY. The URLs are the
# service names of the sidecars project, resolved over the shared network; a
# URL the operator set is kept.
wire_shared_sidecars() {
    [ -n "$SHARED_SIDECARS" ] || return 0
    local s
    for s in $SHARED_SIDECARS; do
        case "$s" in
            guard|classify|local-llm) ;;
            *) err "SHARED_SIDECARS: unknown sidecar \"$s\" (guard, classify, local-llm)" ;;
        esac
        case " $PROFILES " in
            *" $s "*) err "SHARED_SIDECARS lists $s and PROFILES runs it too: a stack uses the shared $s or its own, not both. Drop it from one of them." ;;
        esac
    done
    local net="${STACK_LABEL}-sidecars"
    docker network inspect "$net" >/dev/null 2>&1 \
        || err "Docker network $net does not exist. Start the shared sidecars first, with this stack in SIDECAR_STACKS:
        SIDECAR_STACKS=\"… $STACK_LABEL\" ./selfhost-sidecars.sh"
    case " $SHARED_SIDECARS " in *" guard "*)
        env_has PII_SERVICE_API_KEY \
            || err "PII_SERVICE_API_KEY is empty in $(basename "$ENV_FILE"): set it to the SERVICES_API_KEY of .env.sidecars (the shared guard refuses every other key)"
        default_env PII_SERVICE_URL "http://guard-service:8100" "PII Guard: shared, wired to http://guard-service:8100 over $net" ;;
    esac
    case " $SHARED_SIDECARS " in *" classify "*)
        env_has CLASSIFY_SERVICE_API_KEY \
            || err "CLASSIFY_SERVICE_API_KEY is empty in $(basename "$ENV_FILE"): set it to the SERVICES_API_KEY of .env.sidecars (the shared classifier refuses every other key)"
        default_env CLASSIFY_SERVICE_URL "http://classify-service:8300" "Classifier: shared, wired to http://classify-service:8300 over $net" ;;
    esac
    case " $SHARED_SIDECARS " in *" local-llm "*)
        default_env OLLAMA_URL "http://ollama:11434" "Ollama: shared, wired to http://ollama:11434 over $net" ;;
    esac
}

# A named stack is one of several on the machine, so by default its UI is
# published on loopback only, for the reverse proxy on the host: a port Docker
# publishes on 0.0.0.0 is open on every interface no matter what ufw says.
# The plain install keeps 0.0.0.0 (the compose default): a first install must
# stay reachable from the LAN without a proxy. An explicit CLIENT_BIND_HOST in
# the env file or the environment always wins.
wire_bind_host() {
    [ -n "$STACK_NAME" ] || return 0
    default_env CLIENT_BIND_HOST "127.0.0.1" "UI: published on 127.0.0.1:\$CLIENT_PORT only (stack $STACK_NAME; set CLIENT_BIND_HOST to change)"
}

check_docker() {
    command -v docker >/dev/null 2>&1 || err "Docker is not installed: https://docs.docker.com/get-docker/"
    docker info >/dev/null 2>&1 || err "Docker daemon is not running. Start Docker and retry."
    if ! docker compose version >/dev/null 2>&1 && ! docker-compose version >/dev/null 2>&1; then
        err "Docker Compose is not available. Install the Compose plugin."
    fi
    ok "Docker is ready"
}

# ── Secret generation ────────────────────────────────────────────
gen_hex() { # $1 = byte length
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex "$1"
    else
        head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
    fi
}
gen_password() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | cut -c1-20
    else
        gen_hex 12
    fi
}

# Set `KEY=value` in .env: replace the existing line (portable sed), or append
# the key when the file never had it (e.g. PROFILES, which is not in the
# template). Template secrets keep using the replace path.
set_env() { # $1=key $2=value
    local key="$1" val="$2"
    if grep -qE "^${key}=" "$ENV_FILE"; then
        # Escape characters significant to sed's replacement.
        local esc; esc=$(printf '%s' "$val" | sed -e 's/[\/&|]/\\&/g')
        sed -i.bak "s|^${key}=.*|${key}=${esc}|" "$ENV_FILE" && rm -f "${ENV_FILE}.bak"
    else
        # Repair a missing trailing newline first, or the append glues on.
        [ -s "$ENV_FILE" ] && [ -n "$(tail -c1 "$ENV_FILE")" ] && echo >> "$ENV_FILE"
        printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
    fi
}

# ── Ensure the few files the compose file bind-mounts exist ──────
# Makes this a true no-clone install: we materialise init-db.sh and the
# (initially empty) components/ content dir if missing.
ensure_mounts() {
    mkdir -p "$SCRIPT_DIR/${COMPONENTS_DIR:-components}" "$SCRIPT_DIR/docker"
    if [ ! -f "$SCRIPT_DIR/docker/init-db.sh" ]; then
        log "Writing docker/init-db.sh (creates the 3 databases + pgvector)"
        cat > "$SCRIPT_DIR/docker/init-db.sh" <<'INITDB'
#!/bin/bash
# Create additional databases needed by beeflow and enable pgvector
# The primary database (POSTGRES_DB) is created automatically by postgres
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    SELECT 'CREATE DATABASE beeflow_tasks' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'beeflow_tasks')\gexec
    SELECT 'CREATE DATABASE monitoring_db' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'monitoring_db')\gexec
EOSQL

for db in "$POSTGRES_DB" beeflow_tasks; do
    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<-EOSQL
        CREATE EXTENSION IF NOT EXISTS vector;
EOSQL
done

echo "pgvector extension enabled in $POSTGRES_DB and beeflow_tasks"
INITDB
        chmod +x "$SCRIPT_DIR/docker/init-db.sh"
    fi
}

# ── Create .env with fresh secrets on first run ──────────────────
ensure_env() {
    if [ -f "$ENV_FILE" ]; then
        ok "$(basename "$ENV_FILE") already exists — leaving it untouched"
        return
    fi
    [ -f "$ENV_TEMPLATE" ] || err "Missing $ENV_TEMPLATE next to this script."
    log "Creating $(basename "$ENV_FILE") from template and generating secrets"
    # Owner-only from the first byte: the file holds every secret of the stack.
    (umask 077 && cp "$ENV_TEMPLATE" "$ENV_FILE")
    chmod 600 "$ENV_FILE"

    set_env SESSION_SECRET        "$(gen_hex 32)"
    set_env MASTER_ENCRYPTION_KEY "$(gen_hex 32)"
    set_env DB_PASSWORD           "$(gen_hex 24)"
    set_env RUSTFS_SECRET_KEY     "$(gen_hex 24)"
    set_env SERVICES_API_KEY      "$(gen_hex 24)"
    # Not in the template (analytics is opt-in), so set_env appends it. Having
    # it ready from day one means turning on the analytics profile later never
    # runs umami on its weaker DATABASE_URL-derived fallback secret.
    set_env UMAMI_APP_SECRET      "$(gen_hex 32)"

    ADMIN_PASSWORD="$(gen_password)"
    set_env INIT_ADMIN_PASSWORD   "$ADMIN_PASSWORD"

    ok "Secrets generated into $(basename "$ENV_FILE")"
}

# Remember the resolved profile set for later runs. Called from install and
# upgrade only — teardown commands must not rewrite the operator's choice.
persist_profiles() {
    [ -f "$ENV_FILE" ] || return 0
    local saved; saved="$(env_get PROFILES)"
    if [ "$saved" != "$PROFILES" ]; then
        set_env PROFILES "$PROFILES"
        log "Saved PROFILES=\"$PROFILES\" to $(basename "$ENV_FILE") — later runs reuse it (an explicit PROFILES=\"…\" still wins)"
    fi
    local saved_socket; saved_socket="$(env_get DOCKER_SOCKET)"
    if [ "$DOCKER_SOCKET_EXPLICIT" = true ] && [ "$saved_socket" != "$DOCKER_SOCKET" ]; then
        set_env DOCKER_SOCKET "$DOCKER_SOCKET"
        log "Saved DOCKER_SOCKET=$DOCKER_SOCKET to $(basename "$ENV_FILE") — later runs reuse it"
    fi
    local saved_shared; saved_shared="$(env_get SHARED_SIDECARS)"
    if [ "$SHARED_SIDECARS_EXPLICIT" = true ] && [ "$saved_shared" != "$SHARED_SIDECARS" ]; then
        set_env SHARED_SIDECARS "$SHARED_SIDECARS"
        log "Saved SHARED_SIDECARS=\"$SHARED_SIDECARS\" to $(basename "$ENV_FILE") — later runs reuse it"
    fi
}

# The analytics profile wants UMAMI_APP_SECRET, but a .env from before that
# key existed (or written by hand) does not have it — and the compose file
# cannot hard-require it: Compose interpolates every service eagerly, active
# profiles or not, so a `:?` there would fail every command for installs that
# never opted into analytics. The script fills the gap instead: starting
# analytics with the key missing/empty generates one. Like the other secrets
# this is a value nobody picks by hand; a value the operator did set (or a
# previous run generated) is never overwritten.
ensure_analytics_secret() {
    case " $PROFILES " in *" analytics "*) ;; *) return 0 ;; esac
    if [ -z "$(env_get UMAMI_APP_SECRET)" ]; then
        set_env UMAMI_APP_SECRET "$(gen_hex 32)"
        log "Generated UMAMI_APP_SECRET in $(basename "$ENV_FILE") (required by the analytics profile)"
    fi
}

# The browser sidecar serves Playwright at ws://browser:9222/<BROWSER_WS_PATH>
# and launchServer has no authentication, so the path is a secret like the
# others: random, generated once, never overwritten. A .env from before the
# sidecar existed does not have it, and the compose files refuse to start
# without one. Same pattern as ensure_analytics_secret: fill the gap, never
# touch a value that is set.
ensure_browser_ws_path() {
    if [ -z "$(env_get BROWSER_WS_PATH)" ]; then
        set_env BROWSER_WS_PATH "$(gen_hex 24)"
        log "Generated BROWSER_WS_PATH in $(basename "$ENV_FILE") (the browser sidecar's private path)"
    fi
}

# The guard and classify sidecars refuse to start without SERVICES_API_KEY
# (they fail closed), and the server sends the same key to them. A .env from
# before that, one written by hand, or one still holding the template's
# CHANGE_ME would leave them down, so the gap is filled like the secrets above:
# a key nobody picks by hand; a real value is never overwritten.
ensure_services_api_key() {
    local current; current="$(env_get SERVICES_API_KEY)"
    if [ -z "$current" ] || [ "$current" = "CHANGE_ME" ]; then
        set_env SERVICES_API_KEY "$(gen_hex 24)"
        log "Generated SERVICES_API_KEY in $(basename "$ENV_FILE") (the guard and classify sidecars require it)"
    fi
}

# Template keys missing from .env are REPORTED, never written: .env belongs to
# the operator (it holds their secrets), and every new key ships with a working
# default in the compose file — so silence would be wrong but so is writing.
report_new_env_keys() {
    [ -f "$ENV_TEMPLATE" ] || return 0
    [ -f "$ENV_FILE" ] || return 0
    local key missing=""
    for key in $( (grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_TEMPLATE" || true) | cut -d= -f1 | sort -u); do
        grep -qE "^${key}=" "$ENV_FILE" || missing="$missing $key"
    done
    if [ -n "$missing" ]; then
        warn "New settings exist in $(basename "$ENV_TEMPLATE") that are not in your .env yet:"
        warn "  ${missing# }"
        warn "Nothing was written — they all have working defaults; copy over only what you want to change."
    fi
}

wait_for_health() { # returns 1 on timeout — caller decides how loud to be
    local port; port="$(env_get SERVER_PORT)"; port="${port:-3001}"
    local url="http://localhost:${port}/api/health"
    log "Waiting for the server to become healthy (${url})…"
    for _ in $(seq 1 60); do
        if curl -fsS "$url" >/dev/null 2>&1; then ok "Server is healthy"; return 0; fi
        sleep 3
    done
    return 1
}

# /api/health/schema → {"ok":…,"schemaReady":…}. The result is cached ~30s
# server-side, so poll rather than trusting a single read.
wait_for_schema() {
    local port; port="$(env_get SERVER_PORT)"; port="${port:-3001}"
    local url="http://localhost:${port}/api/health/schema"
    log "Waiting for the schema probe (${url})…"
    local body=""
    for _ in $(seq 1 24); do
        body="$(curl -fsS "$url" 2>/dev/null || true)"
        if printf '%s' "$body" | grep -Eq '"schemaReady"[[:space:]]*:[[:space:]]*true'; then
            ok "Schema is ready"
            return 0
        fi
        sleep 5
    done
    warn "Schema probe did not report ready within ~2 min. Last response: ${body:-<no response>}"
    warn "Check by hand: curl -s ${url}   and: docker exec ${SERVER_CONTAINER} node migrateDb.js"
    return 1
}

# ── Upgrade helpers ──────────────────────────────────────────────
server_image() { # registry/server:tag exactly as compose interpolates from .env
    local reg tag
    reg="$(env_get REGISTRY)"; reg="${reg:-ghcr.io/bee-flow}"
    tag="$(env_get TAG)";      tag="${tag:-latest}"
    printf '%s/server:%s' "$reg" "$tag"
}

image_digest() { # $1=image ref → repo digest of the local copy, if present
    docker image inspect --format '{{index .RepoDigests 0}}' "$1" 2>/dev/null || true
}

rollback_hint() { # $1=old TAG, $2=old digest (may be empty)
    echo ""
    echo -e "${YELLOW}── Rollback ────────────────────────────────────────────${NC}"
    echo -e "  1. Set ${BOLD}TAG=$1${NC} back in .env"
    [ -n "$2" ] && echo -e "     (the server image you were on: $2)"
    echo -e "  2. Re-run ${BOLD}./selfhost.sh${NC} — the same pull + up with your profiles."
    echo -e "  3. Restore the pre-upgrade DB dumps only if the release notes say so."
    echo -e "  Details: ${DOCS_UPGRADES}"
    echo ""
}

print_done() {
    local cport; cport="$(env_get CLIENT_PORT)"; cport="${cport:-5176}"
    local admin_pw; admin_pw="$(env_get INIT_ADMIN_PASSWORD)"
    echo ""
    echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
    echo -e "  ${BOLD}🐝 Bee Flow is running${NC}${STACK_NAME:+  (stack: ${STACK_NAME})}"
    echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
    echo -e "  Open:     ${CYAN}http://localhost:${cport}${NC}"
    echo -e "  Sign in:  ${BOLD}admin${NC} / ${BOLD}${admin_pw}${NC}"
    echo -e "            (change this after first login)"
    echo ""
    echo -e "  Unlock paid features: Admin → Licence → paste your server licence key."
    echo -e "  Connect a Nextcloud:  NC → Settings → Administration → AI → Bee Flow"
    echo -e "                        → \"Self-hosted server\" → this server's URL."
    echo ""
}

install() {
    check_docker
    ensure_mounts
    local first_run=false
    [ -f "$ENV_FILE" ] || first_run=true
    ensure_env
    persist_profiles
    if [ "$first_run" = true ] && [ -n "$STACK_NAME" ]; then
        # A named stack shares the host with another one, so the template's
        # ports and hostnames (the same for every stack) cannot be right.
        # Starting it anyway would fail on the port, or worse, succeed on the
        # other stack's hostname. Stop here, once, with the list.
        echo ""
        ok "Created $(basename "$ENV_FILE") for stack \"$STACK_NAME\" with fresh secrets. Before the first start, set in it:"
        echo "    SERVER_PORT and CLIENT_PORT        unique on this machine (the plain install uses 3001 and 5176)"
        echo "    SERVER_PUBLIC_HOST, CLIENT_PUBLIC_HOST, SERVER_PROTOCOL, CLIENT_PROTOCOL"
        echo "                                       this stack's own hostname behind the reverse proxy"
        echo "    COOKIE_SECURE=true                 when that proxy terminates TLS"
        [ -n "$SHARED_SIDECARS" ] && echo "    PII_SERVICE_API_KEY, CLASSIFY_SERVICE_API_KEY   the SERVICES_API_KEY of .env.sidecars"
        echo "  then run the same command again."
        echo ""
        exit 0
    fi
    ensure_analytics_secret
    ensure_browser_ws_path
    ensure_services_api_key
    wire_guard
    wire_classify
    wire_shared_sidecars
    wire_bind_host
    log "Pulling images from ghcr.io/bee-flow (public, no login needed)…"
    # shellcheck disable=SC2046
    compose "${COMPOSE_FILES[@]}" $(profile_args) pull || warn "Some images failed to pull; continuing"
    log "Starting profiles: $PROFILES"
    # shellcheck disable=SC2046
    compose "${COMPOSE_FILES[@]}" $(profile_args) up -d
    wait_for_health || warn "Server did not report healthy within ~3 min. Check: ./selfhost.sh --logs"
    print_done
}

# The scripted version of the manual steps on docs → Self-hosting → Upgrades:
# pull (loudly), recreate, migrate, verify. Everything here is idempotent —
# re-running an upgrade, or "upgrading" to the tag you already run, is a safe
# no-op.
upgrade() {
    [ -f "$ENV_FILE" ] || err "No .env found next to this script — nothing to upgrade. Run ./selfhost.sh first."
    check_docker
    ensure_mounts

    local tag img old_digest
    tag="$(env_get TAG)"; tag="${tag:-latest}"
    img="$(server_image)"
    old_digest="$(image_digest "$img")"

    log "Upgrading profiles: $PROFILES"
    log "Current server image: ${img}${old_digest:+ (digest: ${old_digest})}"
    case "$tag" in
        latest|prod|dev)
            warn "TAG=${tag} is a MOVING tag — this pulls whatever is newest right now, and"
            warn "afterwards \"the previous version\" has no name. Prefer pinning an immutable"
            warn "tag in .env first (TAG=sha-<commit>): ${DOCS_UPGRADES}"
            [ -n "$old_digest" ] && warn "Rollback target if you continue anyway: ${old_digest}" ;;
    esac
    report_new_env_keys
    log "Reminder: back up first — pg_dump of beeflow_core, beeflow_tasks and monitoring_db,"
    log "plus the rustfs-data volume. Commands: ${DOCS_UPGRADES}"
    persist_profiles
    ensure_analytics_secret
    ensure_browser_ws_path
    ensure_services_api_key
    # The same wiring as install: `up -d` below recreates the server with the
    # environment of THIS run, so a sidecar URL that is not exported here is
    # an empty one in the recreated container.
    wire_guard
    wire_classify
    wire_shared_sidecars
    wire_bind_host

    # Pull FIRST and pull LOUDLY: when the pull fails nothing has been touched
    # and the running stack simply stays on its current version. (Unlike the
    # install path, where a partial pull is tolerated to get a first boot up.)
    log "Pulling images (TAG=${tag})…"
    # shellcheck disable=SC2046
    if ! compose "${COMPOSE_FILES[@]}" $(profile_args) pull; then
        err "Pull failed — the running stack was NOT touched. Fix TAG/network in .env and re-run.
        ('manifest unknown' on a sha-… tag: that service was not rebuilt in that release —
        pin differently, see ${DOCS_UPGRADES})"
    fi

    log "Recreating containers (profiles: $PROFILES)…"
    # shellcheck disable=SC2046
    compose "${COMPOSE_FILES[@]}" $(profile_args) up -d

    if ! wait_for_health; then
        warn "Server did not report healthy within ~3 min after the upgrade."
        rollback_hint "$tag" "$old_digest"
        err "Upgrade not verified. Inspect first: ./selfhost.sh --logs"
    fi

    # Same migration ladder the server already ran at start, but awaited and
    # loud: prints a line per component, exits non-zero on failure. Safe to
    # run any number of times.
    log "Running database migrations (docker exec ${SERVER_CONTAINER} node migrateDb.js)…"
    if ! docker exec ${SERVER_CONTAINER} node migrateDb.js; then
        warn "Migrations reported failures (see output above). This is usually environmental"
        warn "(Postgres permissions, connectivity, disk); migrations are idempotent, so fixing"
        warn "the cause and re-running ./selfhost.sh --upgrade picks up where things stand."
        rollback_hint "$tag" "$old_digest"
        err "Upgrade not verified."
    fi

    if ! wait_for_schema; then
        rollback_hint "$tag" "$old_digest"
        err "Upgrade not verified: the schema probe never reported ready."
    fi

    local new_digest; new_digest="$(image_digest "$img")"
    ok "Upgrade complete — server image: ${img}${new_digest:+ (digest: ${new_digest})}"
    if [ -n "$old_digest" ] && [ "$old_digest" = "$new_digest" ]; then
        log "Digest unchanged — you were already on this version (re-running is a safe no-op)."
    fi
    log "Manual steps from the release notes (rare) do not run themselves — check the notes"
    log "of every release you skipped: https://github.com/Bee-Flow/Bee-Flow/releases"
}

uninstall() {
    echo ""
    echo -e "${RED}${BOLD}══ DANGER — PERMANENT DATA LOSS ════════════════════════${NC}"
    echo -e "${RED}This removes every Bee Flow container AND deletes these data volumes:${NC}"
    echo ""
    echo -e "  ${BOLD}${STACK_LABEL}-pgdata${NC}   every database (beeflow_core, beeflow_tasks,"
    echo -e "                   monitoring_db, umami): users, chats, settings — and your"
    echo -e "                   ${BOLD}activated licence${NC}; a reinstall must re-activate the key"
    echo -e "  ${BOLD}${STACK_LABEL}-data${NC}     the server data dir — including a licence public key"
    echo -e "                   (license-public-key.pem) if you placed one there"
    echo -e "  ${BOLD}${STACK_VOLUME_PREFIX}rustfs-data${NC}      object storage: uploaded documents and meeting"
    echo -e "                   recordings — the only durable copy (+ rustfs-logs)"
    echo -e "  sidecar data     ollama-models (and guard-redis-data, left by older versions)"
    echo ""
    echo -e "  Only want to stop or free RAM? ${BOLD}./selfhost.sh --down${NC} removes the"
    echo -e "  containers and keeps ALL data — that is never destructive."
    echo -e "  Want a backup first? pg_dump ×3 + the rustfs-data volume: ${DOCS_UPGRADES}"
    echo ""
    # The confirmation must come from a human at a terminal: read from
    # /dev/tty, never stdin — `echo beeflow | ./selfhost.sh --uninstall` (or a
    # stray `yes` in a wrapper script) must not be able to pass this gate.
    # No controlling terminal (CI, cron, piped scripts) means no confirmation
    # is possible, so refuse outright instead of falling back to stdin.
    if ! { : < /dev/tty; } 2>/dev/null; then
        err "No terminal available for the confirmation prompt — refusing to delete data.
        (--uninstall must be run interactively; piped input is deliberately ignored.
        Looking for a non-destructive teardown? ./selfhost.sh --down keeps all data.)"
    fi
    local c
    read -r -p "Type '${STACK_LABEL}' to delete everything listed above: " c < /dev/tty \
        || { echo "Aborted — nothing was removed."; exit 1; }
    [ "$c" = "$STACK_LABEL" ] || { echo "Aborted — nothing was removed."; exit 1; }
    # shellcheck disable=SC2046
    compose "${COMPOSE_FILES[@]}" $(all_profile_args) down --volumes
    # guard-redis no longer persists; older versions left this volume behind.
    docker volume rm guard-redis-data >/dev/null 2>&1 || true
    ok "Bee Flow uninstalled — containers and data volumes removed"
}

# The compose file requires BROWSER_WS_PATH for every command, not only
# up: fill it in an existing .env before --logs / --stop / --down /
# --uninstall too (install and upgrade do it themselves).
case "${1:-}" in
    --logs|--stop|--down|--uninstall)
        if [ -f "$ENV_FILE" ]; then ensure_browser_ws_path; fi ;;
esac

case "${1:-}" in
    ""|--install|up)
        install ;;
    --upgrade)
        upgrade ;;
    --status)
        docker ps --filter "name=${STACK_LABEL}" --format "  {{.Names}}\t{{.Status}}\t{{.Ports}}" ;;
    --logs)
        compose "${COMPOSE_FILES[@]}" logs -f server ;;
    --stop)
        # All profiles on purpose: stop the whole install, not just the
        # currently selected subset.
        # shellcheck disable=SC2046
        compose "${COMPOSE_FILES[@]}" $(all_profile_args) stop ;;
    --down)
        # The mild teardown: removes containers across ALL profiles, keeps
        # every data volume. This is the safe alternative to --uninstall.
        # shellcheck disable=SC2046
        compose "${COMPOSE_FILES[@]}" $(all_profile_args) down ;;
    --uninstall)
        uninstall ;;
    --help|-h)
        # The whole leading comment block, however long it grows.
        awk 'NR>1 { if (!/^#/) exit; print }' "$0" ;;
    *)
        err "Unknown option: $1  (try --help)" ;;
esac
