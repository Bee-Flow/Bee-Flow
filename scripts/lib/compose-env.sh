# shellcheck shell=bash
# Sourced by scripts/build-images.sh and scripts/dev-rebuild.sh: how a script
# addresses the SAME compose stack a bare `docker compose up` in the repo root
# runs. Two private copies of this logic drifted apart once (dev-rebuild.sh
# recreated against a hard-coded file set), so both scripts share this one.
#
# Defines functions only. The caller sets REPO_ROOT before calling any of them.

# Value of NAME in the repo .env, or nothing. The caller owns the precedence:
# env var first, then this, then its own default.
_dotenv_get() {
  local name="$1" f="${REPO_ROOT}/.env" line
  [[ -f "$f" ]] || return 0
  line="$(grep -E "^[[:space:]]*${name}[[:space:]]*=" "$f" 2>/dev/null | head -n1)" || true
  [[ -n "$line" ]] || return 0
  line="${line#*=}"            # drop NAME=
  line="${line%$'\r'}"         # strip trailing CR (Windows line endings)
  line="${line#\"}"; line="${line%\"}"      # strip surrounding double quotes
  line="${line#"${line%%[![:space:]]*}"}"   # ltrim
  line="${line%"${line##*[![:space:]]}"}"   # rtrim
  printf '%s' "$line"
}

# Set REGISTRY and TAG from the SAME source the compose stack resolves its image
# refs from (REGISTRY/<svc>:TAG): env var, then the repo .env, then
# ghcr.io/bee-flow and dev.
resolve_registry_and_tag() {
  REGISTRY="${REGISTRY:-$(_dotenv_get REGISTRY)}"
  REGISTRY="${REGISTRY:-ghcr.io/bee-flow}"
  TAG="${TAG:-$(_dotenv_get TAG)}"
  TAG="${TAG:-dev}"
}

# The compose file list the running stack uses: COMPOSE_FILE from the env, then
# from the repo .env, then docker-compose.from-registry.yml.
stack_compose_files() {
  local files="${COMPOSE_FILE:-$(_dotenv_get COMPOSE_FILE)}"
  printf '%s' "${files:-docker-compose.from-registry.yml}"
}

# compose_base_args <file-list>: fill the global array COMPOSE_BASE with
#   compose --project-directory <repo> -f <file>... [--env-file <repo>/.env]
# for a ','- or ';'-separated list (';' is the COMPOSE_FILE syntax in .env;
# relative paths resolve against the repo root). --project-directory and
# --env-file pin the SAME project name + .env as the running stack (updates it
# in place, not a duplicate project) regardless of cwd.
compose_base_args() {
  local list="$1" f p files=()
  COMPOSE_BASE=(compose --project-directory "$REPO_ROOT")
  IFS=';,' read -ra files <<< "$list"
  for f in "${files[@]}"; do
    f="${f#"${f%%[![:space:]]*}"}"; f="${f%"${f##*[![:space:]]}"}"
    [[ -n "$f" ]] || continue
    p="$f"
    [[ "$p" = /* ]] || p="${REPO_ROOT}/${f}"
    if [[ ! -f "$p" ]]; then
      # HARD failure, never a warning: a skipped recreate leaves the old
      # container running on the old image while the build reported success -
      # indistinguishable from "my changes did not take".
      echo "ERROR: compose file not found: $p - refusing to report success without recreating." >&2
      return 1
    fi
    COMPOSE_BASE+=(-f "$p")
  done
  if [[ -f "${REPO_ROOT}/.env" ]]; then
    COMPOSE_BASE+=(--env-file "${REPO_ROOT}/.env")
  fi
  return 0
}

# verify_running_image <compose-service> <image-ref>: after a recreate, the
# service's container MUST be running the exact image this run built. Compose
# resolving a stale tag, a container that failed to come back up, an image ref
# drifting between build and recreate - all of them look like "I rebuilt and my
# changes are not there", and all of them are silent. Comparing image IDs
# catches every one, so a script can never exit 0 on a stale container.
# Uses COMPOSE_BASE (see compose_base_args).
verify_running_image() {
  local svc="$1" ref="$2" wanted cid running
  if ! wanted="$(docker image inspect "$ref" --format '{{.Id}}' 2>/dev/null)"; then
    echo "ERROR: just-built image '$ref' is missing from the daemon - cannot verify $svc." >&2
    return 1
  fi
  cid="$(docker "${COMPOSE_BASE[@]}" ps -q "$svc" 2>/dev/null | head -1)" || true
  if [[ -z "$cid" ]]; then
    echo "ERROR: service '$svc' has no running container after --force-recreate." >&2
    return 1
  fi
  running="$(docker inspect "$cid" --format '{{.Image}}' 2>/dev/null)" || true
  if [[ "$running" != "$wanted" ]]; then
    echo "ERROR: STALE CONTAINER: '$svc' is running image $running but this build produced $wanted ($ref). Your changes are NOT in the running container." >&2
    return 1
  fi
  echo "==> verified: $svc is running $ref (${wanted#sha256:})"
}
