#!/usr/bin/env bash
# Run one REAL automation-builder build inside the server container and
# judge it against a brief's expectation.
#
# Usage (from the repo root):
#   ./scripts/builder-live-run.sh [brief.json]
#     brief.json defaults to server/scripts/builder-briefs/invoices-facturen.json
#
# Env:
#   CONTAINER        server container name; default beeflow-server
#   HARNESS_ORG      org whose connector tenant key signs the harness JWT
#   HARNESS_NC_UID   Nextcloud uid the build runs as
#   HARNESS_EMAIL    e-mail claim of that user
#
# The driver (server/scripts/drive-builder.js) runs INSIDE the container: it
# reads the org's tenant key from the config store, and that key must never
# reach the host disk or a shell history. Its exit code is this script's:
#   0 build matched the expectation      1 mismatch (draft kept, id printed)
#   2 harness error (no key, HTTP != 200) 3 stream ended in error/aborted
# The full SSE transcript lands in ./builder-run.<timestamp>.json (gitignored).
set -euo pipefail

cd "$(dirname "$0")/.."

C=${CONTAINER:-beeflow-server}
BRIEF=${1:-server/scripts/builder-briefs/invoices-facturen.json}
DRIVER=server/scripts/drive-builder.js

[[ -f "$BRIEF" ]] || { echo "brief not found: $BRIEF" >&2; exit 2; }
[[ -f "$DRIVER" ]] || { echo "driver not found: $DRIVER" >&2; exit 2; }

# A build exercises the container's copy of the server, not the checkout. A
# newer source file on the host means the run would test code the container
# does not have — say so up front, the run itself cannot tell.
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
    else
        echo "warning: could not parse container Created time '$created'; skipping the staleness check" >&2
    fi
fi

docker cp "$DRIVER" "$C:/tmp/drive-builder.js"
docker cp "$BRIEF" "$C:/tmp/brief.json"

set +e
docker exec \
    -e "HARNESS_ORG=${HARNESS_ORG:-nc-nextcloud-nc-host-bee}" \
    -e "HARNESS_NC_UID=${HARNESS_NC_UID:-admin}" \
    -e "HARNESS_EMAIL=${HARNESS_EMAIL:-admin@example.com}" \
    "$C" node /tmp/drive-builder.js --brief-json /tmp/brief.json --out /tmp/builder-run.json --print-calls --cleanup
rc=$?
set -e

out="./builder-run.$(date +%Y%m%d-%H%M%S).json"
if docker cp "$C:/tmp/builder-run.json" "$out" 2>/dev/null; then
    echo "transcript: $out"
else
    # The driver writes the transcript only after the stream ends; a harness
    # error before that (exit 2) leaves nothing to copy.
    echo "no transcript to copy (driver exit $rc)" >&2
fi
exit $rc
