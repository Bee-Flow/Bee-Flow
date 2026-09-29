#!/usr/bin/env bash
# Build and optionally push BeeFlow service images with dev/prd tags.
#
# Usage:
#   ./scripts/build-images.sh build dev [service...]
#   ./scripts/build-images.sh build prd [service...]
#   ./scripts/build-images.sh push  dev [service...]
#   ./scripts/build-images.sh push  prd [service...]
#
# Build AND update the running containers with the fresh image (--recreate):
#   ./scripts/build-images.sh build dev server agent-hub --recreate
#   # --recreate defaults to the COMPOSE_FILE set from the repo .env (the same
#   # files a bare `docker compose up` uses); override with --compose-file
#   # (','- or ';'-separated list):
#   ./scripts/build-images.sh build dev server --recreate --compose-file docker-compose.from-registry.yml
#
# Env (precedence everywhere: explicit flag -> env var -> repo .env -> default):
#   REGISTRY   image namespace; default ghcr.io/bee-flow (matches docker-compose.from-registry.yml).
#   TAG        image tag for `build dev`; default 'dev'.
#   HF_TOKEN   required for reranker build (passed as build secret; also read from .env)
#   LICENSE_SERVER_SRC  Bee Flow-internal only: where the private license-server
#              source is checked out; default ../Bee-Flow-AI-internal/license-server
#              (relative paths resolve against the repo root, as in compose).
#   FAST_DEV   set to 1 to skip agent-hub's second (Nextcloud-embed) Vite
#              build — by far the slowest part of rebuilding that image for
#              local iteration. The resulting image will NOT serve a working
#              Nextcloud connector /embed/ shell. Never set this for a `prd`
#              build or anything you intend to push.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# _dotenv_get, resolve_registry_and_tag, stack_compose_files, compose_base_args,
# verify_running_image (shared with dev-rebuild.sh).
# shellcheck source=lib/compose-env.sh
source "${REPO_ROOT}/scripts/lib/compose-env.sh"

# Resolve REGISTRY + TAG from the SAME source the compose stack uses, so the
# images this script builds match the refs docker-compose.from-registry.yml
# pulls/runs: REGISTRY/<svc>:TAG. Precedence: env var -> repo .env -> default.
resolve_registry_and_tag
# HF_TOKEN from .env (reranker build secret) unless already exported.
HF_TOKEN="${HF_TOKEN:-$(_dotenv_get HF_TOKEN)}"
[[ -n "${HF_TOKEN:-}" ]] && export HF_TOKEN

# license-server (the module hub) is Bee Flow-internal: its source lives in the
# private Bee-Flow-AI-internal repository, not in this one. It is built from a
# checkout of that repository next to this one, the same path
# docker-compose.dev.yml and docker-compose.hub.local.yml build from. Without
# that checkout a bulk build skips it; naming it is an error (see build_one).
LICENSE_SERVER_SRC="${LICENSE_SERVER_SRC:-$(_dotenv_get LICENSE_SERVER_SRC)}"
LICENSE_SERVER_SRC="${LICENSE_SERVER_SRC:-../Bee-Flow-AI-internal/license-server}"

# service | context | dockerfile (relative to context, empty = Dockerfile)
# A relative context resolves against the repo root.
# NOTE: GPU images (search-inference-gpu, whisperx) are deliberately NOT built
# here — this box has no GPU and their CUDA bases are huge. CI still builds
# them for GPU deployments (.github/workflows/build-push-ghcr.yml).
SERVICES=(
  "server|server|"
  "agent-hub|agent-hub|"
  "search-api|search-service|Dockerfile"
  "guard|guard-service|"
  "pii|pii-service|"
  "install-wizard|install-wizard|"
  "reranker|reranker|"
  "license-server|${LICENSE_SERVER_SRC}|"
)

# classify: CPU image, built only by CI (build-push-ghcr.yml). Not a GPU image;
# it is left out because its model is baked in at build time and that build
# happens in one place only. `build dev` and `build dev classify` say so and
# skip it; run it from ghcr.io/bee-flow/classify:<tag> instead.
CI_ONLY_SERVICES=(classify)

usage() {
  cat >&2 <<'EOF'
Usage:
  ./scripts/build-images.sh build dev [service...]
  ./scripts/build-images.sh build prd [service...]
  ./scripts/build-images.sh push  dev [service...]
  ./scripts/build-images.sh push  prd [service...]

Build AND update running containers with the fresh image (--recreate):
  ./scripts/build-images.sh build dev server agent-hub --recreate
  ./scripts/build-images.sh build dev server --recreate --compose-file docker-compose.from-registry.yml
EOF
  exit 1
}

# Builder choice, fastest-first:
#
#  1. The `docker` driver (the default builder) writes the result STRAIGHT into
#     the daemon's image store. Nothing to load afterwards.
#  2. A dedicated `docker-container` builder needs `--load`, which serialises the
#     whole image out to an OCI tarball and back in again — measured at ~60s of
#     the server image's ~70s rebuild, i.e. almost all of it.
#
# The historical reason for (2) was cache durability: the docker driver's
# BuildKit cache is wiped by `docker builder prune` / `docker system prune` /
# engine restart. That is already covered by the per-service local cache dir in
# build_one — after a wipe the first build re-imports it and is still fast — so
# the tarball hop buys nothing.
#
# Set BEEFLOW_FORCE_CONTAINER_BUILDER=1 to force the old behaviour.
BUILDER_NAME="beeflow"
builder_args=()
load_args=()
ensure_builder() {
  if [[ "${BEEFLOW_FORCE_CONTAINER_BUILDER:-0}" != "1" ]]; then
    local driver
    # awk must read ALL of the inspect output: an early `exit` on the first
    # match closes the pipe while docker may still be writing, docker dies of
    # SIGPIPE, and under `set -o pipefail` + `set -e` that killed the whole
    # script silently (exit 255, no message) on roughly every other run.
    driver="$(docker buildx inspect 2>/dev/null | awk '/^[[:space:]]*Driver:/ && !d {d=$2} END {print d}')"
    if [[ "$driver" == "docker" ]]; then
      # Default builder, no --load: buildx hands the image to the daemon directly.
      builder_args=()
      load_args=()
      return
    fi
  fi

  if ! docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
    echo "==> creating persistent buildx builder '${BUILDER_NAME}' (docker-container) ..."
    docker buildx create --name "$BUILDER_NAME" --driver docker-container --bootstrap >/dev/null
  fi
  builder_args=(--builder "$BUILDER_NAME")
  load_args=(--load)
}

tags_for() {
  # $1 service  $2 env (dev|prd)
  local svc="$1" env="$2"
  if [[ "$env" == "dev" ]]; then
    echo "${REGISTRY}/${svc}:${TAG}"
  else
    echo "${REGISTRY}/${svc}:latest ${REGISTRY}/${svc}:prod"
  fi
}

# 0 when <svc> was named on the command line, 1 when it is only part of a bulk
# build (no service filter). Reads main's `selected`.
_named() {
  local s
  [[ ${#selected[@]} -gt 0 ]] || return 1
  for s in "${selected[@]}"; do [[ "$s" == "$1" ]] && return 0; done
  return 1
}

# Sets BUILD_SKIPPED=1 when it deliberately built nothing (the caller must not
# record that service as built); a real failure returns non-zero as before.
# A flag, not a special exit code: any code could also be docker's own.
BUILD_SKIPPED=0
build_one() {
  local svc="$1" context="$2" dockerfile="$3" env="$4"
  BUILD_SKIPPED=0
  local ctx_dir="$context"
  [[ "$ctx_dir" = /* ]] || ctx_dir="${REPO_ROOT}/${context}"
  local tag_args=()
  for t in $(tags_for "$svc" "$env"); do
    tag_args+=(-t "$t")
  done

  local extra=()
  case "$svc" in
    server)
      # DB-IP Lite edition month for the Dockerfile's `geo` stage (cache key).
      extra+=(--build-arg "GEO_DB_MONTH=$(date -u +%Y-%m)")
      ;;
    agent-hub)
      extra+=(--build-arg "VITE_BUILD_SHA=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo local)")
      extra+=(--build-arg "BUILDKIT_INLINE_CACHE=1")
      [[ "${FAST_DEV:-0}" == "1" ]] && extra+=(--build-arg "BUILD_EMBED=false")
      ;;
    reranker)
      if [[ -z "${HF_TOKEN:-}" ]]; then
        # Explicitly asked for reranker → hard error. Part of a broader build
        # (e.g. `build dev` with no service filter) → skip it with a warning
        # instead of aborting every remaining service.
        if _named reranker; then
          echo "ERROR: HF_TOKEN must be set to build reranker" >&2
          return 1
        fi
        echo "==> Skipping reranker - HF_TOKEN not set (export HF_TOKEN to include it)." >&2
        BUILD_SKIPPED=1
        return 0
      fi
      extra+=(--secret "id=HF_TOKEN,env=HF_TOKEN")
      ;;
    license-server)
      # Private source, checked out beside this repo (see LICENSE_SERVER_SRC
      # above). Same rule as the reranker: named → hard error, bulk → skip.
      if [[ ! -f "${ctx_dir}/Dockerfile" ]]; then
        if _named license-server; then
          echo "ERROR: license-server is Bee Flow-internal and its source is not in this repository - no checkout at ${ctx_dir}. Check out Bee-Flow-AI-internal next to this repo, or set LICENSE_SERVER_SRC." >&2
          return 1
        fi
        echo "==> Skipping license-server - its private source is not checked out at ${ctx_dir} (set LICENSE_SERVER_SRC to include it)." >&2
        BUILD_SKIPPED=1
        return 0
      fi
      ;;
  esac

  local file_arg=()
  [[ -n "$dockerfile" ]] && file_arg=(-f "${ctx_dir}/${dockerfile}")

  local cache_dir="${REPO_ROOT}/.buildx-cache/${svc}"

  echo "==> Building ${svc} (${env}) ..."
  docker buildx build "${builder_args[@]}" "${load_args[@]}" \
    --cache-from "type=local,src=${cache_dir}" \
    --cache-to   "type=local,dest=${cache_dir},mode=max" \
    "${file_arg[@]}" \
    "${tag_args[@]}" \
    "${extra[@]}" \
    "${ctx_dir}"
}

push_one() {
  local svc="$1" env="$2"
  for t in $(tags_for "$svc" "$env"); do
    echo "==> Pushing $t"
    docker push "$t"
  done
}

check_login() {
  # Heuristic: ghcr.io login leaves an auth entry in ~/.docker/config.json.
  if [[ "$REGISTRY" == ghcr.io/* ]] && ! grep -q '"ghcr.io"' "${HOME}/.docker/config.json" 2>/dev/null; then
    echo "ERROR: not logged into ghcr.io. Run: docker login ghcr.io" >&2
    exit 1
  fi
}

# A few build-image names differ from their docker-compose service name.
_compose_service() {
  case "$1" in
    guard) echo "guard-service" ;;
    pii)   echo "pii-service" ;;
    *)     echo "$1" ;;
  esac
}

# Recreate the containers for the just-built services so they pick up the fresh
# image (`up -d` alone can leave a container on its old image; --force-recreate
# guarantees the swap). Only services present in the target compose file are
# touched. Args: <compose_file> <built_svc...>
update_containers() {
  local compose_file="$1"; shift
  local built=("$@")
  # --compose-file accepts a ','- or ';'-separated list for stacks assembled
  # from a base file + overrides (';' matches the COMPOSE_FILE syntax in .env).
  # A missing file is a hard failure (see compose_base_args).
  compose_base_args "$compose_file" || return 1
  local compose_base=("${COMPOSE_BASE[@]}")
  # Hand compose the EXACT registry/tag this run just built, so the recreate
  # can't drift onto a different image ref (compose defaults TAG to 'latest'
  # when unset). Exported env overrides the .env inside docker compose.
  export REGISTRY TAG
  # Services in the ACTIVE profile set only (COMPOSE_PROFILES from .env, or
  # profile-less files like docker-compose.dev.yml). Deliberately NOT
  # --profile '*': a bulk `build dev --recreate` must never force-start
  # profile-gated services (GPU, search, ...) the stack doesn't run.
  local available
  if ! available="$(docker "${compose_base[@]}" config --services 2>/dev/null)" || [[ -z "$available" ]]; then
    echo "ERROR: could not list services in $compose_file - refusing to report success without recreating." >&2
    return 1
  fi
  local targets=() b c explicit
  for b in "${built[@]}"; do
    c="$(_compose_service "$b")"
    if grep -qx -- "$c" <<< "$available"; then
      targets+=("$c")
    else
      # Explicitly asked for on the command line, so it MUST land. Only a bulk
      # build (no service filter) may quietly pass over the images that are not
      # compose services at all (pwt-runner, install-wizard).
      explicit=0
      if [[ ${#selected[@]} -gt 0 ]]; then
        for s in "${selected[@]}"; do [[ "$s" == "$b" ]] && explicit=1; done
      fi
      if [[ $explicit -eq 1 ]]; then
        echo "ERROR: '$b' was built but is not a service in the active stack ($compose_file) - it cannot be recreated, so the running containers would NOT have your changes." >&2
        return 1
      fi
      echo "==> '$b' is not in the active stack ($compose_file) - not recreating it." >&2
    fi
  done
  if [[ ${#targets[@]} -eq 0 ]]; then
    echo "==> No built services map to $compose_file - nothing to recreate." >&2
    return 0
  fi
  echo "==> Recreating from ${compose_file}: ${targets[*]}"
  # Naming services explicitly starts them even if they sit behind a profile.
  docker "${compose_base[@]}" up -d --force-recreate "${targets[@]}" || return 1

  # The guarantee: every recreated container MUST be running the exact image this
  # run produced, so this script can never exit 0 on a stale container (see
  # verify_running_image).
  local t ref
  for t in "${targets[@]}"; do
    for b in "${built[@]}"; do
      [[ "$(_compose_service "$b")" == "$t" ]] || continue
      ref="$(tags_for "$b" "$env" | awk '{print $1}')"
      break
    done
    verify_running_image "$t" "$ref" || return 1
  done
}

main() {
  [[ $# -lt 2 ]] && usage
  local action="$1" env="$2"
  shift 2

  local recreate=0
  local compose_file=""
  local selected=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --recreate)       recreate=1; shift ;;
      --compose-file)   compose_file="${2:?--compose-file needs a path}"; shift 2 ;;
      --compose-file=*) compose_file="${1#*=}"; shift ;;
      *)                selected+=("$1"); shift ;;
    esac
  done
  # Default the recreate file set to the canonical COMPOSE_FILE the stack itself
  # uses (env/.env), so a script recreate can never drift from `docker compose up`.
  compose_file="${compose_file:-$(stack_compose_files)}"

  case "$action" in build|push) ;; *) usage ;; esac
  case "$env"    in dev|prd)    ;; *) usage ;; esac

  [[ "$action" == "push" ]] && check_login
  [[ "$action" == "build" ]] && ensure_builder

  local ci_svc s asked
  for ci_svc in "${CI_ONLY_SERVICES[@]}"; do
    asked=1
    if [[ ${#selected[@]} -gt 0 ]]; then
      asked=0
      for s in "${selected[@]}"; do [[ "$s" == "$ci_svc" ]] && asked=1; done
    fi
    [[ $asked -eq 1 ]] && echo "==> Skipping $ci_svc - CPU image built only by CI (.github/workflows/build-push-ghcr.yml); pull ${REGISTRY}/${ci_svc}:${TAG} instead." >&2
  done

  local built=()
  for entry in "${SERVICES[@]}"; do
    IFS='|' read -r svc context dockerfile <<< "$entry"
    if [[ ${#selected[@]} -gt 0 ]]; then
      local match=0
      for s in "${selected[@]}"; do [[ "$s" == "$svc" ]] && match=1; done
      [[ $match -eq 0 ]] && continue
    fi
    case "$action" in
      build)
        build_one "$svc" "$context" "$dockerfile" "$env"
        # Only a real build is recorded: --recreate and its image verification
        # act on `built`, and a skipped service produced no image to run.
        [[ $BUILD_SKIPPED -eq 1 ]] || built+=("$svc")
        ;;
      push)  push_one  "$svc" "$env" ;;
    esac
  done

  if [[ $recreate -eq 1 ]]; then
    if [[ "$action" != "build" ]]; then
      echo "==> --recreate only applies to 'build' - ignoring." >&2
    elif [[ ${#built[@]} -eq 0 ]]; then
      echo "==> Nothing built - nothing to recreate." >&2
    else
      update_containers "$compose_file" "${built[@]}"
    fi
  fi
}

main "$@"
