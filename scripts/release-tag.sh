#!/usr/bin/env bash
# Tag a downstream repo with the version found in its source-of-truth file.
#
# Each downstream repo has its own version scheme — connector ships on
# 0.1.x via appinfo/info.xml, hive ships on 1.x via package.json. They
# must be tagged independently, never with the same tag string. This
# helper reads each repo's source version and refuses to tag anything
# else, so the v0.1.11/v1.2.0 mixup that triggered the rewrite of this
# tooling can't recur.
#
# Run AFTER the downstream-repo sync has populated $SYNC_ROOT (default
# /tmp/bee-flow-sync) — the helper checks the version on the synced
# checkout, not the monorepo subdir, so what gets tagged matches what
# was pushed.
#
# Usage:
#   ./scripts/release-tag.sh <connector|hive>          # tag + push
#   ./scripts/release-tag.sh <connector|hive> --dry-run  # report only
#   ./scripts/release-tag.sh <connector|hive> --tag vX.Y.Z  # safety check:
#       exits non-zero unless vX.Y.Z matches the source version

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC_ROOT="${SYNC_ROOT:-/tmp/bee-flow-sync}"

declare -A REPO_DIR=(
    [connector]="$SYNC_ROOT/connector"
    [hive]="$SYNC_ROOT/hive"
)

read_version() {
    local repo="$1"
    case "$repo" in
        connector)
            grep -oPm1 '(?<=<version>)[^<]+' "${REPO_DIR[connector]}/appinfo/info.xml"
            ;;
        hive)
            node -p "require('${REPO_DIR[hive]}/package.json').version"
            ;;
        *)
            echo "unknown repo: $repo (expected: connector | hive)" >&2
            exit 2
            ;;
    esac
}

if [ $# -lt 1 ]; then
    echo "usage: $(basename "$0") <connector|hive> [--dry-run] [--tag vX.Y.Z]" >&2
    exit 2
fi

REPO="$1"; shift
DRY_RUN=0
EXPECT_TAG=""
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=1; shift ;;
        --tag)     EXPECT_TAG="$2"; shift 2 ;;
        *)         echo "unknown flag: $1" >&2; exit 2 ;;
    esac
done

DIR="${REPO_DIR[$REPO]:-}"
if [ -z "$DIR" ] || [ ! -d "$DIR/.git" ]; then
    echo "✗ $REPO repo not found at $DIR" >&2
    echo "  Run the downstream-repo sync first, so \$SYNC_ROOT ($SYNC_ROOT) holds the synced checkout." >&2
    echo "  SYNC_ROOT defaults to /tmp/bee-flow-sync; set it if your sync writes elsewhere." >&2
    exit 1
fi

VER="$(read_version "$REPO")"
TAG="v$VER"

if [ -n "$EXPECT_TAG" ] && [ "$EXPECT_TAG" != "$TAG" ]; then
    echo "✗ source version is $TAG but --tag was $EXPECT_TAG — refusing" >&2
    echo "  ($REPO ships on its own version track; check the source file before tagging)" >&2
    exit 1
fi

if git -C "$DIR" ls-remote --tags --exit-code origin "refs/tags/$TAG" >/dev/null 2>&1; then
    echo "✗ $TAG already exists on $REPO remote — bump the source version instead of retagging" >&2
    exit 1
fi

if [ "$DRY_RUN" = "1" ]; then
    echo "would tag $REPO with $TAG on $(git -C "$DIR" rev-parse --short origin/main)"
    exit 0
fi

git -C "$DIR" fetch --quiet origin
git -C "$DIR" tag "$TAG" origin/main
git -C "$DIR" push origin "$TAG"
echo "✓ tagged $REPO $TAG → $(git -C "$DIR" rev-parse --short origin/main)"
