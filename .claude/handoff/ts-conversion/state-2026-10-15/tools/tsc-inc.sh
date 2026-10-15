#!/usr/bin/env bash
# Incremental agent-hub typecheck for DRAFTING rounds only (cache per worktree in
# ${TSC_CACHE_DIR:-/tmp/beeflow-tsc-cache}). Final checks before a merge or push stay
# a full `npm run typecheck`. Usage, from <worktree>/agent-hub:
#   /home/user/Bee-Flow/.claude/handoff/ts-conversion/state-2026-10-15/tools/tsc-inc.sh
dir="${TSC_CACHE_DIR:-/tmp/beeflow-tsc-cache}"; mkdir -p "$dir"
key=$(pwd | sha1sum | cut -c1-12)
exec "$(dirname "$0")/heavy.sh" node --max-old-space-size=6144 ./node_modules/typescript/bin/tsc \
  --noEmit --incremental --tsBuildInfoFile "$dir/$key.tsbuildinfo" "$@"
