#!/usr/bin/env bash
# Run one REAL playbook case inside the server container — the whole film:
# table → routine builder → fill → app builder → app turns — and judge it
# against the case's expectation. The case files live in
# server/scripts/playbook-cases/; the driver is server/scripts/drive-playbook.js.
#
# Usage (from the repo root):
#   ./scripts/playbook-live-run.sh server/scripts/playbook-cases/01-invoice-new-table.json
#   ./scripts/playbook-live-run.sh --all            # every case, in file order, one report each
#
# Reports land in ./playbook-runs/<case>.<timestamp>.json (gitignored) and a
# one-line verdict per case in ./playbook-runs/summary.txt.
# Exit codes follow the driver: 0 pass · 1 mismatch · 2 harness · 3 stream/API error.
set -uo pipefail
cd "$(dirname "$0")/.."

C=${CONTAINER:-beeflow-server}
DRIVER=server/scripts/drive-playbook.js
mkdir -p playbook-runs

# A freshly recreated container answers ECONNREFUSED for a minute (measured
# 2026-09-14: six cases "ran" in one second). Wait for /api/health first.
wait_healthy() {
    local tries=0
    until docker exec "$C" node -e "require('http').get('http://127.0.0.1:3001/api/health',(r)=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))" 2>/dev/null; do
        tries=$((tries+1))
        if [[ $tries -ge 60 ]]; then echo "server in $C not healthy after 120 s" >&2; return 1; fi
        [[ $tries -eq 1 ]] && echo "waiting for the server in $C to answer /api/health…"
        sleep 2
    done
}
wait_healthy || exit 2

run_case() {
    local case_file=$1
    local name; name=$(basename "$case_file" .json)
    local stamp; stamp=$(date +%Y%m%d-%H%M%S)
    docker cp server/scripts/drive-builder.js "$C:/tmp/drive-builder.js" >/dev/null
    docker cp server/scripts/drive-app-builder.js "$C:/tmp/drive-app-builder.js" >/dev/null
    docker cp "$DRIVER" "$C:/tmp/drive-playbook.js" >/dev/null
    docker cp "$case_file" "$C:/tmp/case.json" >/dev/null
    docker exec \
        -e "HARNESS_ORG=${HARNESS_ORG:-nc-nextcloud-nc-host-bee}" \
        -e "HARNESS_NC_UID=${HARNESS_NC_UID:-admin}" \
        -e "HARNESS_EMAIL=${HARNESS_EMAIL:-admin@example.com}" \
        "$C" node /tmp/drive-playbook.js --case /tmp/case.json --out /tmp/playbook-run.json --print-calls
    local rc=$?
    local out="playbook-runs/$name.$stamp.json"
    docker cp "$C:/tmp/playbook-run.json" "$out" 2>/dev/null && echo "  transcript: $out"
    echo "$stamp $name exit=$rc" >> playbook-runs/summary.txt
    return $rc
}

if [[ "${1:-}" == "--all" ]]; then
    overall=0
    for f in server/scripts/playbook-cases/*.json; do
        run_case "$f" || overall=1
    done
    exit $overall
fi

[[ -f "${1:-}" ]] || { echo "case not found: ${1:-<none>}" >&2; exit 2; }
run_case "$1"
