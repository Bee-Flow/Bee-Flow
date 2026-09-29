#!/usr/bin/env bash
# Local dev-loop rebuild: only builds (and recreates) the images whose build
# context actually changed since the last time THIS script built them —
# and reuses the same persistent BuildKit builder + per-service local layer
# cache as scripts/build-images.sh, so unchanged layers are never redone.
# Every service that needs rebuilding builds IN PARALLEL (each is its own
# isolated `docker buildx build` process against the shared persistent
# builder, which supports concurrent requests fine) — on a machine with
# room to spare this turns "sum of build times" into "the slowest one",
# same idea as running the two builds with `&` yourself, just automatic.
#
# The recreate targets the same stack a bare `docker compose up` in the repo
# root runs: the files in COMPOSE_FILE (env var, then the repo .env, then
# docker-compose.from-registry.yml), with the same project and .env - the
# rule scripts/build-images.sh follows too. The opt-in security-scan layer
# (docker-compose.security.override.yml) is added only with --security.
#
# Usage:
#   ./scripts/dev-rebuild.sh                # check server + agent-hub, rebuild+recreate what changed
#   ./scripts/dev-rebuild.sh agent-hub      # only consider this one service
#   ./scripts/dev-rebuild.sh --force        # ignore the change cache, rebuild everything selected
#   ./scripts/dev-rebuild.sh --full         # agent-hub: also build the slow NC-embed shell (skipped by default)
#   ./scripts/dev-rebuild.sh --sequential   # one at a time instead (quieter output / less RAM/CPU at once)
#   ./scripts/dev-rebuild.sh --security     # also layer docker-compose.security.override.yml (opt-in)
#
# Env:
#   REGISTRY      image registry/namespace (env, then .env, default ghcr.io/bee-flow)
#   TAG           image tag (env, then .env, default dev - same as build-images.sh)
#   COMPOSE_FILE  compose files to recreate from (';'- or ','-separated; also read from .env)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# _dotenv_get, resolve_registry_and_tag, stack_compose_files, compose_base_args,
# verify_running_image (shared with build-images.sh).
# shellcheck source=lib/compose-env.sh
source "${REPO_ROOT}/scripts/lib/compose-env.sh"
# The same precedence compose uses for the image refs it recreates from
# (env var -> repo .env -> default), so the build tags what the recreate runs.
resolve_registry_and_tag
BUILDER_NAME="beeflow"
CACHE_ROOT="${REPO_ROOT}/.buildx-cache"
HASH_DIR="${CACHE_ROOT}/.dev-rebuild-hashes"
mkdir -p "$HASH_DIR"

# service|context|dockerfile (relative to context, empty = Dockerfile).
# Scoped to the two images of the everyday dev loop — the python/GPU services
# (search-api, guard, pii, whisperx, reranker) live under
# scripts/build-images.sh instead: their build-images.sh service ids don't
# match their compose service names (e.g. "guard" vs "guard-service"), so
# folding them in here would need a separate name-mapping table for little
# local-iteration benefit. Add an entry here if that changes.
SERVICES=(
  "server|server|"
  "agent-hub|agent-hub|"
)

FULL_BUILD=0
FORCE=0
SEQUENTIAL=0
SECURITY=0
selected=()
for arg in "$@"; do
  case "$arg" in
    --full)       FULL_BUILD=1 ;;
    --force)      FORCE=1 ;;
    --sequential) SEQUENTIAL=1 ;;
    --security)   SECURITY=1 ;;
    -h|--help)
      sed -n '2,29p' "${BASH_SOURCE[0]}" >&2
      exit 0
      ;;
    *) selected+=("$arg") ;;
  esac
done

# The recreate file set: the canonical stack, so this can never drift from
# `docker compose up`. The security-scan override is opt-in (CLAUDE.md): it
# turns on active scanning and a host bind mount, so only --security adds it.
compose_files="$(stack_compose_files)"
[[ "$SECURITY" == "1" ]] && compose_files="${compose_files};docker-compose.security.override.yml"
# Resolved before building: a missing compose file fails now, not after a build.
compose_base_args "$compose_files"

ensure_builder() {
  if ! docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
    echo "==> creating persistent buildx builder '${BUILDER_NAME}' ..."
    docker buildx create --name "$BUILDER_NAME" --driver docker-container --bootstrap >/dev/null
  fi
}

# Content hash of every file git considers part of this dir — tracked AND
# untracked-but-not-gitignored, so uncommitted local edits (the normal case
# mid-development) are caught. Not a byte-exact mirror of .dockerignore, but
# close enough for "does this need a rebuild": worst case it over-triggers a
# rebuild, it never silently skips a real change.
compute_hash() {
  local dir="$1"
  # `git ls-files -c` lists files still in the index, INCLUDING ones deleted
  # from the working tree but not yet staged — a normal mid-development state.
  # Drop paths that no longer exist before hashing, otherwise sha256sum errors
  # (xargs exit 123) and pipefail+set -e would kill the whole script. A deleted
  # file simply stops contributing to the hash, which correctly reads as a change.
  (cd "$REPO_ROOT" && git ls-files -co --exclude-standard -- "$dir" \
    | LC_ALL=C sort \
    | { while IFS= read -r f; do [ -e "$f" ] && printf '%s\n' "$f"; done; } \
    | xargs -r sha256sum 2>/dev/null) | sha256sum | awk '{print $1}'
}

echo "==> Checking which images changed..."
to_build=()
# The hash each build starts from; recorded only once its container is verified.
declare -A HASH_BY_SVC
for entry in "${SERVICES[@]}"; do
  IFS='|' read -r svc context dockerfile <<< "$entry"
  if [[ ${#selected[@]} -gt 0 ]]; then
    match=0
    for s in "${selected[@]}"; do [[ "$s" == "$svc" ]] && match=1; done
    [[ $match -eq 0 ]] && continue
  fi
  hash_file="${HASH_DIR}/${svc}.sha256"
  current="$(compute_hash "$context")"
  previous="$(cat "$hash_file" 2>/dev/null || echo '')"
  if [[ "$FORCE" == "1" || "$current" != "$previous" ]]; then
    to_build+=("$entry")
    HASH_BY_SVC["$svc"]="$current"
  else
    echo "    ${svc}: unchanged since last build — skipping"
  fi
done

if [[ ${#to_build[@]} -eq 0 ]]; then
  echo "==> Nothing changed — no images to rebuild, no containers to recreate."
  exit 0
fi

ensure_builder

# One shared function so the parallel and --sequential paths run the exact
# same build command — only how they're scheduled/awaited differs.
build_svc() {
  local svc="$1" context="$2" dockerfile="$3"
  local cache_dir="${CACHE_ROOT}/${svc}"
  local file_arg=()
  [[ -n "$dockerfile" ]] && file_arg=(-f "${REPO_ROOT}/${context}/${dockerfile}")

  local extra=()
  if [[ "$svc" == "agent-hub" ]]; then
    extra+=(--build-arg "VITE_BUILD_SHA=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo local)")
    # Skip the slow NC-embed second Vite build by default — see
    # agent-hub/Dockerfile's BUILD_EMBED arg. Pass --full when you actually
    # need to test the Nextcloud-embedded shell.
    [[ "$FULL_BUILD" != "1" ]] && extra+=(--build-arg "BUILD_EMBED=false")
  fi

  docker buildx build --builder "$BUILDER_NAME" --load \
    --cache-from "type=local,src=${cache_dir}" \
    --cache-to   "type=local,dest=${cache_dir},mode=max" \
    -t "${REGISTRY}/${svc}:${TAG}" \
    "${file_arg[@]}" \
    "${extra[@]}" \
    "${REPO_ROOT}/${context}"
}

built_services=()
failed_services=()

if [[ "$SEQUENTIAL" == "1" || ${#to_build[@]} -le 1 ]]; then
  for entry in "${to_build[@]}"; do
    IFS='|' read -r svc context dockerfile <<< "$entry"
    echo "==> Building ${svc} -> ${REGISTRY}/${svc}:${TAG} ..."
    if build_svc "$svc" "$context" "$dockerfile"; then
      built_services+=("$svc")
    else
      echo "==> ${svc}: BUILD FAILED"
      failed_services+=("$svc")
    fi
  done
else
  log_dir="$(mktemp -d)"
  echo "==> Building ${#to_build[@]} image(s) in parallel (logs: ${log_dir}) ..."
  pids=()
  pid_svc=()
  for entry in "${to_build[@]}"; do
    IFS='|' read -r svc context dockerfile <<< "$entry"
    ( build_svc "$svc" "$context" "$dockerfile" ) > "${log_dir}/${svc}.log" 2>&1 &
    pids+=("$!")
    pid_svc+=("$svc")
    echo "    started ${svc} (pid $!)"
  done

  for i in "${!pids[@]}"; do
    svc="${pid_svc[$i]}"
    if wait "${pids[$i]}"; then
      echo "==> ${svc}: build OK"
      built_services+=("$svc")
    else
      echo "==> ${svc}: BUILD FAILED — last 40 lines of ${log_dir}/${svc}.log:"
      tail -40 "${log_dir}/${svc}.log"
      failed_services+=("$svc")
    fi
  done
fi

if [[ ${#failed_services[@]} -gt 0 ]]; then
  echo "==> ${#failed_services[@]} build(s) failed, not recreated: ${failed_services[*]}"
fi

if [[ ${#built_services[@]} -eq 0 ]]; then
  echo "==> Nothing built successfully — nothing to recreate."
  exit 1
fi

echo "==> Recreating containers for: ${built_services[*]}"
# Hand compose the EXACT registry/tag this run just built, so the recreate
# can't drift onto a different image ref (compose would otherwise resolve
# ${TAG:-latest} itself). Exported env overrides the .env inside docker compose.
export REGISTRY TAG
docker "${COMPOSE_BASE[@]}" up -d --no-deps --force-recreate --pull never "${built_services[@]}"

# Every recreated container must run the image this run built; a stale one is
# a failure, never "Done".
for svc in "${built_services[@]}"; do
  verify_running_image "$svc" "${REGISTRY}/${svc}:${TAG}" || exit 1
done

# Only now is the change "done": a build whose recreate or verification failed
# keeps its old hash, so the next run rebuilds and retries instead of skipping.
for svc in "${built_services[@]}"; do
  printf '%s\n' "${HASH_BY_SVC[$svc]}" > "${HASH_DIR}/${svc}.sha256"
done

echo "==> Done. Rebuilt + recreated: ${built_services[*]}"
[[ ${#failed_services[@]} -eq 0 ]] || exit 1
