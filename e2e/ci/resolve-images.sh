#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# e2e/ci/resolve-images.sh — mixed-tag image resolution for the smoke stack
# ══════════════════════════════════════════════════════════════════
#
# For every image the CI stack (profiles core+search) needs, pull either:
#   • $IMAGE_PREFIX/<img>:sha-$SHA      when this run built that service
#     ($SHA set AND the workflow key appears in $BUILT), or
#   • $IMAGE_PREFIX/<img>:$FALLBACK_TAG otherwise (default: prod)
# and retag whatever was pulled to :smoke. The throwaway .env written by
# write-env.sh sets TAG=smoke, so docker compose picks up exactly these.
#
# Inputs (env):
#   IMAGE_PREFIX   registry prefix                         (default ghcr.io/bee-flow)
#   BUILT          csv of workflow service keys built this run (may be empty)
#   SHA            full git sha of this run's build            (may be empty)
#   FALLBACK_TAG   tag for services NOT built this run     (default prod)
#
# Side effect: writes resolved-images.md (markdown table image → source)
# into the current working directory; the workflow cats it into
# $GITHUB_STEP_SUMMARY.
#
# NOTE: the workflow-key → image-name mapping below MUST stay in sync with
# the build jobs / promote wiring in .github/workflows/build-push-ghcr.yml
# (changes outputs: server, agent-hub, search → images server, agent-hub,
# search-api).
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

IMAGE_PREFIX="${IMAGE_PREFIX:-ghcr.io/bee-flow}"
BUILT="${BUILT:-}"
SHA="${SHA:-}"
FALLBACK_TAG="${FALLBACK_TAG:-prod}"
CANDIDATE_DIGESTS="${CANDIDATE_DIGESTS:-}"

# workflow-key:image-name pairs (keep in sync with build-push-ghcr.yml).
MAPPING=(
  "server:server"
  "agent-hub:agent-hub"
  "search:search-api"
)

echo "[resolve-images] IMAGE_PREFIX=$IMAGE_PREFIX BUILT='$BUILT' SHA='$SHA' FALLBACK_TAG='$FALLBACK_TAG'"

SUMMARY_FILE="resolved-images.md"
{
  echo "### Smoke stack images"
  echo ""
  echo "| Image | Resolved from |"
  echo "|-------|---------------|"
} > "$SUMMARY_FILE"

# True when $1 appears as a whole comma-separated element of $BUILT.
built_this_run() {
  case ",$BUILT," in
    *",$1,"*) return 0 ;;
    *)        return 1 ;;
  esac
}

for pair in "${MAPPING[@]}"; do
  key="${pair%%:*}"
  img="${pair#*:}"
  if [[ -n "$CANDIDATE_DIGESTS" ]] && built_this_run "$key"; then
    job="$key"
    [[ "$key" == search ]] && job=search-api
    digest="$(jq -er --arg job "$job" '.[$job].outputs.digest // empty' <<< "$CANDIDATE_DIGESTS")"
    [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "::error::Invalid candidate digest for $key"; exit 1; }
    src="$IMAGE_PREFIX/$img@$digest"
  elif [[ -n "$SHA" ]] && built_this_run "$key"; then
    src="$IMAGE_PREFIX/$img:sha-$SHA"
  else
    src="$IMAGE_PREFIX/$img:$FALLBACK_TAG"
  fi
  dst="$IMAGE_PREFIX/$img:smoke"
  echo "[resolve-images] $dst  <=  $src"
  docker pull "$src"
  docker tag "$src" "$dst"
  echo "| \`$IMAGE_PREFIX/$img\` | \`$src\` |" >> "$SUMMARY_FILE"
done

# Coverage gap: services built this run that the smoke stack does NOT exercise
# (only server/agent-hub/search run in profiles core+search). They will still be
# promoted to :latest/:prod, but the smoke suite never touched them — surface
# that loudly so a backend-only release isn't mistaken for "smoke-verified".
if [[ -n "$BUILT" ]]; then
  covered=" server agent-hub search "
  uncovered=""
  IFS=',' read -ra keys <<< "$BUILT"
  for k in "${keys[@]}"; do
    [[ -z "$k" ]] && continue
    [[ "$covered" == *" $k "* ]] || uncovered="${uncovered:+$uncovered, }$k"
  done
  if [[ -n "$uncovered" ]]; then
    echo "::warning::Built this run but NOT exercised by the smoke suite (promoted unverified): $uncovered"
    {
      echo ""
      echo "> ⚠️ **Promoted without smoke coverage:** $uncovered — the smoke stack only runs server/agent-hub/search. Verify these separately."
    } >> "$SUMMARY_FILE"
  fi
fi

echo "[resolve-images] wrote $SUMMARY_FILE"
echo "[resolve-images] local images under $IMAGE_PREFIX:"
docker image ls "$IMAGE_PREFIX/*"
