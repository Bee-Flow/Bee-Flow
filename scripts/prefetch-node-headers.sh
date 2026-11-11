#!/usr/bin/env bash
# Download the Node headers into node-gyp's cache BEFORE `npm ci` runs.
#
# Why: npm runs the install scripts of native modules in parallel. When the
# headers are not cached yet, every node-gyp process downloads and unpacks
# node-v<version>-headers.tar.gz into the same ~/.cache/node-gyp/<version>, and
# one of them can read common.gypi while another is still writing it
# ("common.gypi, line 0: SyntaxError: invalid syntax", issue #627). With the
# headers in place no install script downloads anything, so the race is gone.
#
# Usage: scripts/prefetch-node-headers.sh <package directory>
# Uses the node-gyp version that package's lockfile pins; a package without
# node-gyp in its lockfile is skipped (it builds nothing natively through it).
# Best effort: a failed download only warns, and npm ci then fetches the
# headers itself as it did before.
set -euo pipefail

dir="${1:?usage: prefetch-node-headers.sh <package directory>}"
# The package directory is relative to the repository root, whatever the
# caller's working directory (a composite action step runs in the job's).
cd "$(dirname "$0")/.."
lock="$dir/package-lock.json"
[ -f "$lock" ] || { echo "prefetch-node-headers: no $lock, skipped"; exit 0; }

version="$(node -e '
  const lock = require(require("path").resolve(process.argv[1]));
  const entry = (lock.packages || {})["node_modules/node-gyp"];
  process.stdout.write(entry && entry.version ? entry.version : "");
' "$lock")"

if [ -z "$version" ]; then
  echo "prefetch-node-headers: $lock pins no node-gyp, skipped"
  exit 0
fi

if ! npx --yes "node-gyp@$version" install; then
  echo "::warning::prefetch-node-headers: node-gyp@$version install failed; npm ci will fetch the headers itself"
fi
