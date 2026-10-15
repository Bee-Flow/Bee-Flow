#!/usr/bin/env bash
# Run a memory-heavy check (agent-hub tsc ~5 GB, vitest, jest) in one of N shared
# slots so parallel agents never overload the machine. N adapts to the machine:
#   N = min(cores / 4, free-ish memory GB / 8), at least 1; override with HEAVY_SLOTS.
# Usage: .claude/handoff/ts-conversion/state-2026-10-15/tools/heavy.sh <command...>
if [ -z "$HEAVY_SLOTS" ]; then
  cores=$(nproc 2>/dev/null || echo 4)
  memgb=$(awk '/MemTotal/ {print int($2/1048576)}' /proc/meminfo 2>/dev/null || echo 16)
  a=$(( cores / 4 )); b=$(( memgb / 8 ))
  N=$(( a < b ? a : b )); [ "$N" -lt 1 ] && N=1
else
  N=$HEAVY_SLOTS
fi
LOCKDIR="${TMPDIR:-/tmp}/beeflow-heavy-slots"; mkdir -p "$LOCKDIR"
while :; do
  for i in $(seq 1 "$N"); do
    exec 9>"$LOCKDIR/slot-$i.lock"
    if flock -n 9; then "$@"; rc=$?; flock -u 9; exit $rc; fi
  done
  sleep 2
done
