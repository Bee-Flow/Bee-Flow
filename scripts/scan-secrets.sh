#!/usr/bin/env bash
# Bee Flow — monorepo secret scanner.
#
# Guards THIS monorepo (Bee-Flow/Bee-Flow) before code reaches GitHub.
#
# Uses `gitleaks` if installed (honoring ./.gitleaks.toml), otherwise a
# built-in regex fallback over git-tracked files.
#
# Usage:
#   ./scripts/scan-secrets.sh                  # or: npm run lint:gitleaks
#   ./scripts/scan-secrets.sh --range A..B     # the commits in A..B instead
#   ./scripts/scan-secrets.sh --changed        # only what this checkout changed
#   ./scripts/scan-secrets.sh --staged         # only what `git commit` records
#
# --range scans the patches of every commit in the range rather than the tree:
# a secret added in one commit and deleted in the next is gone from the tree
# but not from the history a non-squash merge brings along. CI runs it over a
# pull request's commits and over what a push to main adds. It needs gitleaks;
# the regex fallback below has no history mode.
#
# --changed and --staged scan a few files instead of all ~9,000, for the
# commit hooks. --changed reads the working-tree content of the tracked files
# that differ from HEAD (staged or not) plus the untracked files git does not
# ignore: the Claude Code hook runs BEFORE its command, so in
# `git add x && git commit` the file x is not staged yet when it looks.
# --staged reads the index, i.e. the blobs a `git commit` records whatever the
# working tree holds; .githooks/pre-commit uses it. Both use the same config,
# the same finding format and, without gitleaks, the same regex fallback as the
# tree scan. An empty list is a pass.
#
# Exits non-zero when potential secrets are found.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RED=$'\033[31m'; GRN=$'\033[32m'; DIM=$'\033[2m'; OFF=$'\033[0m'

range=""
subset=""
case "${1:-}" in
    "") ;;
    --range)
        range="${2:-}"
        # Two revisions and nothing else: gitleaks splits --log-opts on spaces,
        # so anything wider would be read as extra `git log` options.
        if ! [[ "$range" =~ ^[A-Za-z0-9._/@^~-]+\.\.[A-Za-z0-9._/@^~-]+$ ]] || [[ "$range" == -* ]]; then
            echo "${RED}✗ --range wants <rev>..<rev>, got '${range}'${OFF}" >&2
            exit 2
        fi
        if ! git rev-parse --verify --quiet "${range%%..*}^{commit}" >/dev/null ||
           ! git rev-parse --verify --quiet "${range##*..}^{commit}" >/dev/null; then
            echo "${RED}✗ --range ${range}: a revision is not in this clone (shallow checkout? CI needs fetch-depth: 0)${OFF}" >&2
            exit 2
        fi
        ;;
    --changed|--staged)
        subset="${1#--}"
        ;;
    *)
        echo "usage: $0 [--range <rev>..<rev> | --changed | --staged]" >&2
        exit 2
        ;;
esac

work="$(mktemp -d)"
# Out of $work first: --staged may cd into it, and Windows cannot remove a
# directory a process is standing in.
trap 'cd "$ROOT"; rm -rf "$work"' EXIT

# --changed / --staged: the repo paths to scan, NUL-separated, in $work/paths,
# and the directory they are read from, in $src. A git command that fails here
# fails the script (set -e), so a broken checkout never reads as "no files".
if [ -n "$subset" ]; then
    if [ "$subset" = staged ]; then
        what="staged file(s)"
        git diff --cached --name-only -z --diff-filter=ACMRT >"$work/paths"
        # The index content, not the working tree's: `git add -p` and an edit
        # after `git add` both make the two differ.
        src="$work/index"
        mkdir "$src"
        git checkout-index -z --stdin --prefix="$src/" <"$work/paths"
    else
        what="changed or untracked file(s)"
        base=HEAD
        # A repository without a first commit diffs against the empty tree.
        git rev-parse --verify --quiet HEAD >/dev/null || base="$(git hash-object -t tree /dev/null)"
        { git diff --name-only -z --no-renames "$base" --; git ls-files -z -o --exclude-standard; } >"$work/listed"
        # Deleted files have nothing to scan, and the tree scan skips symlinks
        # too (gitleaks does not follow them). A file this process cannot read
        # cannot be staged by it either.
        kept=()
        while IFS= read -r -d '' f; do
            [ -f "$f" ] && [ ! -L "$f" ] && [ -r "$f" ] && kept+=("$f")
        done <"$work/listed"
        : >"$work/paths"
        [ "${#kept[@]}" -eq 0 ] || printf '%s\0' "${kept[@]}" >"$work/paths"
        src="$ROOT"
    fi
    count="$(tr -cd '\0' <"$work/paths" | wc -c | tr -d ' ')"
    if [ "$count" -eq 0 ]; then
        echo "${GRN}✓ nothing to scan: no ${what}${OFF}"
        exit 0
    fi
    what="${count} ${what}"
fi

if command -v gitleaks >/dev/null 2>&1; then
    extra=()
    [ -f "$ROOT/.gitleaks.toml" ] && extra+=(--config "$ROOT/.gitleaks.toml")

    # What a failing run prints: rule, file and line of each finding, and the
    # commit in --range mode. Never the value, and deliberately not --verbose
    # either: that prints the matched line, and --redact only blanks the
    # secret itself, not whatever sits next to it on the line. Without one of
    # the two a red run in CI said only "leaks found: N".
    tmpl="$work/findings.tmpl"
    report="$work/findings.txt"
    printf '%s\n%s' '{{ range . }}  {{ .RuleID }}  {{ .File }}:{{ .StartLine }}{{ if .Commit }}  commit {{ printf "%.12s" .Commit }}{{ end }}' '{{ end }}' >"$tmpl"
    listing=(--redact --report-format template --report-template "$tmpl" --report-path "$report")

    if [ -n "$range" ]; then
        echo "${DIM}scanning the commits in ${range} with gitleaks…${OFF}"
        if gitleaks git --no-banner --log-opts="$range" "${listing[@]}" "${extra[@]}" "$ROOT"; then
            echo "${GRN}✓ gitleaks: no leaks in the commits of ${range}${OFF}"
            exit 0
        fi
        echo "${RED}✗ gitleaks found potential secrets in the commits of ${range}:${OFF}"
        cat "$report"
        echo "${DIM}  a secret that a later commit removed still needs rotating: it is in the history${OFF}"
        exit 1
    fi

    # The same --no-git directory scan as the tree scan below, over a copy of
    # just the listed files (--staged exported its copy above).
    if [ -n "$subset" ]; then
        echo "${DIM}scanning the ${what} with gitleaks…${OFF}"
        if [ "$subset" = changed ]; then
            src="$work/tree"
            mkdir "$src"
            # A file that vanished or grew since it was listed makes tar exit
            # non-zero, which under set -e would end the scan before gitleaks
            # ran on the rest. Copy what can be copied and say so.
            if ! tar --null -T "$work/paths" -cf - 2>/dev/null | tar -xf - -C "$src" 2>/dev/null; then
                echo "${DIM}  some listed files could not be copied (changed or removed meanwhile); scanning the rest${OFF}" >&2
            fi
        fi
        if gitleaks detect --source "$src" --no-git --no-banner "${listing[@]}" "${extra[@]}"; then
            echo "${GRN}✓ gitleaks: no leaks in the ${what}${OFF}"
            exit 0
        fi
        echo "${RED}✗ gitleaks found potential secrets in the ${what}:${OFF}"
        sed "s#${src}/##" "$report"
        exit 1
    fi

    # Pre-push gate: scan only git-TRACKED files (current working-tree content) —
    # that is exactly what reaches GitHub. We export them to a temp dir and scan
    # with --no-git, so gitleaks never trips over gitignored operator files
    # (.env, deploy-*.sh, .install-env.json) or pre-existing leaks buried in old
    # history. (Those are a separate concern: rotate the affected credentials.)
    echo "${DIM}scanning tracked files with gitleaks…${OFF}"
    tree="$work/tree"
    mkdir "$tree"
    git ls-files -z | tar --null -T - -cf - 2>/dev/null | tar -xf - -C "$tree" 2>/dev/null
    if gitleaks detect --source "$tree" --no-git --no-banner "${listing[@]}" "${extra[@]}"; then
        echo "${GRN}✓ gitleaks: no leaks in tracked files${OFF}"
        exit 0
    fi
    echo "${RED}✗ gitleaks found potential secrets in tracked files:${OFF}"
    sed "s#${tree}/##" "$report"
    exit 1
fi

if [ -n "$range" ]; then
    echo "${RED}✗ --range needs gitleaks; the regex fallback only reads the tree${OFF}" >&2
    echo "${DIM}  Install it: https://github.com/gitleaks/gitleaks${OFF}" >&2
    exit 2
fi

if [ -n "$subset" ]; then
    echo "${DIM}gitleaks not installed — using built-in regex fallback over the ${what}.${OFF}"
    # Relative paths either way, so a finding names the repo path.
    cd "$src"
else
    echo "${DIM}gitleaks not installed — using built-in regex fallback over tracked files.${OFF}"
fi
echo "${DIM}  Install gitleaks for the full ruleset: https://github.com/gitleaks/gitleaks${OFF}"

# name : ERE pattern (extended regex for grep -E).
patterns=(
  'aws_access_key:AKIA[0-9A-Z]{16}'
  'openai_key:sk-[A-Za-z0-9]{40,}'
  'anthropic_key:sk-ant-(api03|admin01)-[A-Za-z0-9_-]{40,}'
  'github_pat_classic:gh[psour]_[A-Za-z0-9]{36,}'
  'github_pat_finegrained:github_pat_[A-Za-z0-9_]{60,}'
  'google_api_key:AIza[0-9A-Za-z_-]{35}'
  'gcp_service_acct_key:"private_key"[[:space:]]*:[[:space:]]*"-----BEGIN'
  'slack_token:xox[abprs]-[A-Za-z0-9-]{10,}'
  'stripe_live_secret:sk_live_[A-Za-z0-9]{24,}'
  'stripe_live_restricted:rk_live_[A-Za-z0-9]{24,}'
  'private_key_pem:-----BEGIN ([A-Z]+ )?PRIVATE KEY-----'
  'ssh_private_key:-----BEGIN OPENSSH PRIVATE KEY-----'
  'generic_secret_assignment:(api[_-]?key|secret|password|token|access[_-]?token)[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9_/+=-]{32,}["'"'"']'
)

# Allow-list path fragments (placeholders / shipped public material / tests).
# COARSER than .gitleaks.toml, knowingly: there test files are exempt from the
# generic rule only, and each provider-shaped fixture is pinned to its file and
# value. This fallback has no per-pattern allowlist, so it still skips test
# files for every pattern. It is the local no-gitleaks convenience; CI always
# installs gitleaks and never takes this path.
allow_paths=(
  '.example'
  'server/license/bundled-public-key.pem'
  '__tests__/'
  '.test.'
  '.spec.'
  # Synthetic PII eval corpus: intentionally contains secret-shaped fake
  # values (AKIA…, sk-…) so the guard service can be evaluated against them.
  'guard-service/eval/corpus/'
  # The rule files themselves: they spell out the private-key markers.
  '.gitleaks.toml'
  'scripts/scan-secrets.sh'
)

# Scan only git-tracked files — that is exactly what reaches GitHub. (Or, with
# --changed / --staged, only the listed ones.)
scan_files=()
while IFS= read -r -d '' f; do
    skip=0
    for ap in "${allow_paths[@]}"; do
        case "$f" in *"$ap"*) skip=1; break;; esac
    done
    [ "$skip" -eq 0 ] && [ -f "$f" ] && scan_files+=("$f")
done < <(if [ -n "$subset" ]; then cat "$work/paths"; else git ls-files -z; fi)

if [ "${#scan_files[@]}" -eq 0 ]; then
    if [ -n "$subset" ]; then
        echo "${GRN}✓ nothing to scan: the ${what} are all allow-listed${OFF}"
    else
        echo "${GRN}✓ no tracked files to scan${OFF}"
    fi
    exit 0
fi

# -H: a batch of one file would otherwise print its lines without the name.
# -e and --: a pattern that starts with '-' (the private-key rules) or a file
# named like an option (`-q`) would otherwise be read as a grep flag, and
# grep's exit 2 would read as "no match".
hits=0
for entry in "${patterns[@]}"; do
    name="${entry%%:*}"
    pat="${entry#*:}"
    matches=$(printf '%s\0' "${scan_files[@]}" | xargs -0 grep -HEnI -e "$pat" -- 2>/dev/null || true)
    [ -z "$matches" ] && continue
    hits=$((hits + 1))
    echo "${RED}✗ $name${OFF}"
    # sed prints the first 8 but reads everything: `| head -8` closed the pipe
    # early, the sed before it died of SIGPIPE, and pipefail turned a finding
    # into exit 141, which the commit hook reads as "did not finish".
    echo "$matches" | sed -E "s#$pat#[REDACTED:$name]#g" | sed -n '1,8s/^/    /p'
done

if [ "$hits" -gt 0 ]; then
    echo "${RED}✗ regex fallback found $hits potential secret type(s)${OFF}"
    exit 1
fi
if [ -n "$subset" ]; then
    echo "${GRN}✓ regex fallback: no secrets found in the ${what}${OFF}"
else
    echo "${GRN}✓ regex fallback: no secrets found in tracked files${OFF}"
fi
exit 0
