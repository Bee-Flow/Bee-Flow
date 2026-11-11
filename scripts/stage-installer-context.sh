#!/usr/bin/env bash
# Stage the build context of the installer image (installer/Dockerfile): the
# four files of this checkout that the image carries, in installer/bundle.
# release-latest.yml runs it on the release tag before building the image.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bundle="$root/installer/bundle"
rm -rf "$bundle"
mkdir -p "$bundle"
cp "$root/beeflow-install.sh" "$root/selfhost.sh" "$root/docker-compose.from-registry.yml" "$root/.env.selfhost.example" "$bundle/"
echo "Staged $(ls -A "$bundle" | wc -l) files in installer/bundle"
