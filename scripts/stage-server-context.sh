#!/usr/bin/env bash
# Stage what the server image takes from gitignored folders of its build
# context (./server), so a local image carries the same extras as the one CI
# pushes. Used by .github/workflows/build-push-ghcr.yml (job `server`),
# scripts/build-images.sh and scripts/build-images.ps1.
#
# Usage:
#   scripts/stage-server-context.sh [--install] [runtime-bundle|sbom|all]
#
#   runtime-bundle  App Studio headless runtime (agent-hub `npm run build:runtime`)
#                   -> server/vendor/app-runtime/{app-runtime.mjs,app-runtime.css}.
#                   The server screenshots Studio apps with it
#                   (server/services/appStudioRender.js). Without it the render
#                   service answers "screenshots unavailable".
#                   --install runs `npm ci` in agent-hub first (CI, a fresh
#                   checkout). Without it agent-hub/node_modules must exist: this
#                   script never wipes a developer's install.
#   sbom            CycloneDX documents per npm workspace -> server/sbom/
#                   (read at run time by server/compliance/lib/sbomLocator.js).
#                   Lockfile-only, needs no install. Stamped with BUILD_SHA, which
#                   must be the APP_BUILD_SHA build-arg of the same image.
#   all (default)   both; one failing does not stop the other, the exit code says.
#
# Env: BUILD_SHA  the commit the image is built from (default: git HEAD, else "local")
#      BUILD_REF  branch/tag name stamped into the SBOM (optional)
#
# Both are OPTIONAL for the image (server/Dockerfile): a failure here is a
# warning for the caller to weigh (CI: continue-on-error unless releasing prod;
# the local scripts: warn and build anyway). The folders are emptied first, so
# a failed run never leaves the previous build's files to be shipped.
# The server image's build context stays ./server on purpose: widening it to
# the repo root would wreck its layer cache and drag the monorepo into every build.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="${REPO_ROOT}/server"

install=0
what=all
for arg in "$@"; do
  case "$arg" in
    --install) install=1 ;;
    runtime-bundle|sbom|all) what="$arg" ;;
    *) echo "usage: $0 [--install] [runtime-bundle|sbom|all]" >&2; exit 2 ;;
  esac
done

BUILD_SHA="${BUILD_SHA:-$(git -C "$REPO_ROOT" rev-parse --verify -q HEAD 2>/dev/null || echo local)}"
export BUILD_SHA

stage_runtime_bundle() {
  rm -rf "${SERVER_DIR}/vendor/app-runtime"
  cd "${REPO_ROOT}/agent-hub"
  if [[ $install -eq 1 ]]; then
    npm ci --no-audit --no-fund --prefer-offline
  elif [[ ! -d node_modules ]]; then
    echo "agent-hub/node_modules is missing; run 'cd agent-hub && npm ci' (or pass --install)" >&2
    return 1
  fi
  npm run build:runtime
  # The artefact contract is exactly these two files. Refuse to stage a partial
  # bundle: a truncated .mjs would surface at render time as an opaque mount
  # failure instead of a clean "unavailable".
  test -s dist-runtime/app-runtime.mjs
  test -s dist-runtime/app-runtime.css
  mkdir -p ../server/vendor/app-runtime
  cp dist-runtime/app-runtime.mjs dist-runtime/app-runtime.css ../server/vendor/app-runtime/
  du -h ../server/vendor/app-runtime/*
}

# Adds the beeflow:* properties that let the compliance check prove the SBOM
# belongs to the running build.
stamp() {
  node - "$1" "$2" <<'NODE'
const fs = require('fs');
const [file, workspace] = process.argv.slice(2);
const bom = JSON.parse(fs.readFileSync(file, 'utf8'));
if (bom.bomFormat !== 'CycloneDX') throw new Error(`${file}: not a CycloneDX document`);
bom.metadata = bom.metadata || {};
bom.metadata.timestamp = bom.metadata.timestamp || new Date().toISOString();
const props = (bom.metadata.properties || []).filter(p => !/^beeflow:/.test(p.name));
props.push({ name: 'beeflow:build_sha', value: process.env.BUILD_SHA });
props.push({ name: 'beeflow:workspace', value: workspace });
if (process.env.BUILD_REF) props.push({ name: 'beeflow:build_ref', value: process.env.BUILD_REF });
bom.metadata.properties = props;
fs.writeFileSync(file, JSON.stringify(bom));
console.log(`${file}: ${(bom.components || []).length} components, build ${process.env.BUILD_SHA.slice(0, 12)}`);
NODE
}

# One CycloneDX document per npm workspace: `--package-lock-only` describes the
# lockfile the image installs from (no install needed), `--omit=dev` matches
# `npm ci --omit=dev` in the Dockerfile. sbom/cyclonedx.json is the SERVER
# workspace's document, which is what the image's own SBOM means; the others
# ride along for questionnaire packs (GET /api/compliance/sbom). They are
# refreshed only when the server image rebuilds, deliberately.
stage_sbom() {
  cd "$REPO_ROOT"
  rm -rf server/sbom
  mkdir -p server/sbom
  local ws out
  for ws in server agent-hub nextcloud-connector; do
    if [ ! -f "$ws/package-lock.json" ]; then
      echo "::notice::$ws has no package-lock.json — no SBOM generated for it"
      continue
    fi
    out="server/sbom/${ws}.cyclonedx.json"
    (cd "$ws" && npm sbom --sbom-format=cyclonedx --package-lock-only --omit=dev) > "$out"
    stamp "$out" "$ws"
  done
  # The image's own SBOM is the server workspace's document.
  test -s server/sbom/server.cyclonedx.json
  cp server/sbom/server.cyclonedx.json server/sbom/cyclonedx.json
  du -h server/sbom/*
}

case "$what" in
  runtime-bundle) stage_runtime_bundle ;;
  sbom)           stage_sbom ;;
  all)
    rc=0
    # Separate processes, not `(fn) || ...`: errexit is off inside a function
    # called in an || list, so a failing step would not stop its function.
    fwd=()
    [[ $install -eq 1 ]] && fwd=(--install)
    for part in runtime-bundle sbom; do
      bash "${BASH_SOURCE[0]}" ${fwd[@]+"${fwd[@]}"} "$part" || { echo "stage-server-context: $part failed" >&2; rc=1; }
    done
    exit $rc
    ;;
esac
