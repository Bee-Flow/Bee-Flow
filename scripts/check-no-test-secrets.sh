#!/usr/bin/env bash
# Fail CI when test-fixture secrets leak into non-test source.
#
# Tests legitimately set MASTER_ENCRYPTION_KEY (and similar) to short
# placeholder strings so the encryption module doesn't crash. Those
# assignments must stay inside test files — anything outside __tests__/ or
# *.test.js / *.spec.js indicates someone copy-pasted a fixture into prod
# code, which would (a) leak a known key shape and (b) crash if it lands
# on a system where the env var is also set.
#
# Allowed locations:
#   * any file under a __tests__/ directory
#   * filenames ending in .test.js or .spec.js
#   * this script itself
#
# Usage:
#   ./scripts/check-no-test-secrets.sh             # or: npm run lint:secrets
#   ./scripts/check-no-test-secrets.sh --changed   # tracked files changed vs HEAD + untracked
#   ./scripts/check-no-test-secrets.sh --staged    # the index: what `git commit` records
#
# The files come from git, not from walking the directory: tracked plus
# untracked-but-not-ignored. A walk also read gitignored build output and the
# other checkouts under .claude/worktrees/, so another session's uncommitted
# work could block this one's commit. In a fresh clone both lists are the same.
# --changed and --staged mean the same as in scripts/scan-secrets.sh.
#
# Exits non-zero with a useful error if any other file matches.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

mode=""
case "${1:-}" in
    "") ;;
    --changed|--staged) mode="${1#--}" ;;
    *)
        echo "usage: $0 [--changed | --staged]" >&2
        exit 2
        ;;
esac

# Patterns that should never appear outside test files.
# Tightly anchored so we don't flag the variable name in legitimate
# configuration code (e.g. `process.env.MASTER_ENCRYPTION_KEY` reads).
PATTERNS=(
    "MASTER_ENCRYPTION_KEY[[:space:]]*=[[:space:]]*['\"]test[-_]"
    "SESSION_SECRET[[:space:]]*=[[:space:]]*['\"]test[-_]"
    "STRIPE_WEBHOOK_SECRET[[:space:]]*=[[:space:]]*['\"]whsec_test"
)

# Whitelist patterns (path fragments). A match here is OK even if the
# pattern appears.
ALLOW_PATHS=(
    "/__tests__/"
    ".test.js"
    ".spec.js"
    ".test.ts"
    ".spec.ts"
    ".test.jsx"
    ".spec.jsx"
    ".test.tsx"
    ".spec.tsx"
    "scripts/check-no-test-secrets.sh"
)

work="$(mktemp -d)"
# Out of $work first: --staged may cd into it, and Windows cannot remove a
# directory a process is standing in.
trap 'cd "$ROOT"; rm -rf "$work"' EXIT

# The candidate paths, NUL-separated. A failing git command fails the script
# (set -e) rather than reading as an empty list.
case "$mode" in
    "")
        { git ls-files -z; git ls-files -z -o --exclude-standard; } >"$work/listed"
        ;;
    changed)
        base=HEAD
        git rev-parse --verify --quiet HEAD >/dev/null || base="$(git hash-object -t tree /dev/null)"
        { git diff --name-only -z --no-renames "$base" --; git ls-files -z -o --exclude-standard; } >"$work/listed"
        ;;
    staged)
        git diff --cached --name-only -z --diff-filter=ACMRT >"$work/listed"
        mkdir "$work/index"
        git checkout-index -z --stdin --prefix="$work/index/" <"$work/listed"
        cd "$work/index"
        ;;
esac

# The same selection the old `grep -R --include … --exclude-dir …` made, and
# the same `./path:line:text` output (hence the ./ prefix and -H).
files=()
while IFS= read -r -d '' f; do
    case "/$f" in */node_modules/*|*/.git/*|*/dist/*|*/build/*) continue ;; esac
    case "$f" in *.js|*.ts|*.jsx|*.tsx) ;; *) continue ;; esac
    [ -f "$f" ] && files+=("./$f")
done <"$work/listed"

if [ "${#files[@]}" -eq 0 ]; then
    echo "OK: nothing to scan (no ${mode:-tracked} .js/.ts/.jsx/.tsx files)."
    exit 0
fi
printf '%s\0' "${files[@]}" >"$work/files"

found_violations=0

for pat in "${PATTERNS[@]}"; do
    # Tolerate absence (|| true).
    matches=$(xargs -0 grep -HIn -E "$pat" <"$work/files" 2>/dev/null || true)
    if [ -z "$matches" ]; then
        continue
    fi
    while IFS= read -r line; do
        [ -z "$line" ] && continue
        file="${line%%:*}"
        is_allowed=0
        for allow in "${ALLOW_PATHS[@]}"; do
            if [[ "$file" == *"$allow"* ]]; then
                is_allowed=1
                break
            fi
        done
        if [ "$is_allowed" -eq 0 ]; then
            if [ "$found_violations" -eq 0 ]; then
                echo "Test fixture secret detected outside test files:"
                echo
            fi
            echo "  $line"
            found_violations=1
        fi
    done <<< "$matches"
done

if [ "$found_violations" -ne 0 ]; then
    echo
    echo "Move these assignments into a __tests__/ directory or a .test.js / .spec.js file."
    exit 1
fi

echo "OK: no test fixture secrets in production source."
