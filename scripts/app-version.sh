#!/usr/bin/env bash
# The product version to stamp into the server image (build-arg APP_VERSION,
# read by server/modules/appVersion.js). One source for CI and the local build
# scripts (build-push-ghcr.yml, build-images.sh, build-images.ps1):
#
#   1. $APP_VERSION when set (CI passes the version input of a prod run, e.g. v1.5.0)
#   2. else the highest release tag v<major>.<minor>.<patch> of the checkout
#
# Prints the version without the leading "v", or nothing when none is known or
# the value is not a dotted number (the server then runs unstamped and warns).
# Needs the tags (CI: git fetch --tags); no history is required.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

v="${APP_VERSION:-}"
if [[ -z "$v" ]]; then
  v="$(git -C "$REPO_ROOT" tag --list 'v[0-9]*' --sort=-v:refname 2>/dev/null | head -n1)"
fi
v="${v#v}"
if [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?$ ]]; then
  printf '%s\n' "$v"
fi
exit 0
