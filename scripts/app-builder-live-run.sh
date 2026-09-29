#!/usr/bin/env bash
# Run one REAL App Studio build inside the server container and judge it
# against a brief's expectation — the live-run gate for App Studio builder
# work (the sibling of builder-live-run.sh).
#
# Usage (from the repo root):
#   ./scripts/app-builder-live-run.sh [brief.json | --brief <name>]
#     brief.json defaults to server/scripts/builder-briefs/facturen-app.json;
#     `--brief invoice-tracker` picks server/scripts/builder-briefs/<name>.json
#     (the 2026-09-13 "app with tables" brief: two own tables with rows, two
#     screens, forms, no form twice).
#
# Env: CONTAINER (beeflow-server), HARNESS_ORG, HARNESS_NC_UID, HARNESS_EMAIL —
# see builder-live-run.sh. The driver (server/scripts/drive-app-builder.js)
# runs INSIDE the container so the org's tenant key never reaches the host.
# Exit codes: 0 matched · 1 mismatch (app kept, id printed) · 2 harness error
# · 3 stream error. The transcript lands in ./app-builder-run.<timestamp>.json.
set -euo pipefail

cd "$(dirname "$0")/.."

C=${CONTAINER:-beeflow-server}
if [[ "${1:-}" == "--brief" && -n "${2:-}" ]]; then
    BRIEF="server/scripts/builder-briefs/$2.json"
else
    BRIEF=${1:-server/scripts/builder-briefs/facturen-app.json}
fi
DRIVER=server/scripts/drive-app-builder.js

[[ -f "$BRIEF" ]] || { echo "brief not found: $BRIEF" >&2; exit 2; }
[[ -f "$DRIVER" ]] || { echo "driver not found: $DRIVER" >&2; exit 2; }

created=$(docker inspect -f '{{.Created}}' "$C" 2>/dev/null || true)
if [[ -z "$created" ]]; then
    echo "warning: container $C not found or not inspectable — is the stack up?" >&2
else
    ref=$(mktemp)
    trap 'rm -f "$ref"' EXIT
    if touch -d "$created" "$ref" 2>/dev/null; then
        newer=$(find server -path server/node_modules -prune -o -type f -name '*.js' -newer "$ref" -print | head -n 5)
        if [[ -n "$newer" ]]; then
            echo "warning: server source newer than the $C image (created $created):" >&2
            echo "$newer" | sed 's/^/    /' >&2
            echo "    rebuild first: ./scripts/build-images.sh build dev server --recreate" >&2
        fi
    fi
fi

docker cp "$DRIVER" "$C:/tmp/drive-app-builder.js"
docker cp "$BRIEF" "$C:/tmp/app-brief.json"

set +e
docker exec \
    -e "HARNESS_ORG=${HARNESS_ORG:-nc-nextcloud-nc-host-bee}" \
    -e "HARNESS_NC_UID=${HARNESS_NC_UID:-admin}" \
    -e "HARNESS_EMAIL=${HARNESS_EMAIL:-admin@example.com}" \
    "$C" node /tmp/drive-app-builder.js --brief-json /tmp/app-brief.json --out /tmp/app-builder-run.json --print-calls
rc=$?
set -e

out="./app-builder-run.$(date +%Y%m%d-%H%M%S).json"
if docker cp "$C:/tmp/app-builder-run.json" "$out" 2>/dev/null; then
    echo "transcript: $out"
else
    echo "no transcript to copy (driver exit $rc)" >&2
fi
exit $rc
