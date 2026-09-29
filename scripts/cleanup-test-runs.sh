#!/usr/bin/env bash
# Remove what the playbook test runs left behind (playbooks, their routines,
# apps and created tables; with --forms also the test forms and their
# "Answers — …" tables). DRY RUN unless --apply is given.
#
# Usage (from the repo root):
#   ./scripts/cleanup-test-runs.sh                  # list what would go
#   ./scripts/cleanup-test-runs.sh --apply          # delete that list
#   ./scripts/cleanup-test-runs.sh --forms --apply  # …including test forms
#   ./scripts/cleanup-test-runs.sh --keep <id>,<id> --apply
#   ./scripts/cleanup-test-runs.sh --match '^PB ' --apply   # only the harness cases
#
# Runs inside the server container as the org user the runs used, through the
# public DELETE routes — mirrors (Nextcloud / spreadsheet tables) are never
# touched, nor anything owned by someone else.
set -uo pipefail
cd "$(dirname "$0")/.."
C=${CONTAINER:-beeflow-server}
docker cp server/scripts/cleanup-test-runs.js "$C:/tmp/cleanup-test-runs.js" >/dev/null || exit 2
docker exec \
    -e "HARNESS_ORG=${HARNESS_ORG:-nc-nextcloud-nc-host-bee}" \
    -e "HARNESS_NC_UID=${HARNESS_NC_UID:-admin}" \
    -e "HARNESS_EMAIL=${HARNESS_EMAIL:-admin@example.com}" \
    "$C" node /tmp/cleanup-test-runs.js "$@"
