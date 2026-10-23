#!/bin/bash
# One typecheck at a time (several at once ran a 15 GB machine out of memory).
# Usage: tsc-locked.sh <files-list>   prints only the errors in those files; retries a killed run.
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$ROOT/agent-hub" || exit 2
for i in 1 2 3; do
  out=$(flock /tmp/bee-flow-tsc.lock node ./node_modules/typescript-7/bin/tsc --noEmit --pretty false 2>&1); st=$?
  if [ $st -le 2 ] && { [ $st -eq 0 ] || echo "$out" | grep -q "error TS"; }; then echo "$out" | grep -F -f "$1"; echo "(typecheck finished, status $st)"; exit 0; fi
  echo "(typecheck was killed, retrying)" >&2; sleep 5
done
echo "TYPECHECK DID NOT FINISH"; exit 1
