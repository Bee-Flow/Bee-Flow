---
name: jscpd
description: Detect copy-paste duplication (clones) in source code with jscpd. Option reference and AI reporter usage for the dry-refactoring workflow.
---

# jscpd

Copy-paste detector. Finds duplicated code blocks ("clones") across the repo so you can
refactor them. This skill is the option reference for the **[dry-refactoring](../dry-refactoring/SKILL.md)**
workflow.

## Running it

No install needed — `npx` fetches jscpd on demand (currently v5.x). Works identically on
Windows (PowerShell or the Bash tool), macOS, and Linux.

```bash
npx jscpd --reporters ai <path>
```

`<path>` is a directory or file, e.g. `server/core`, `agent-hub/src`, or `.` for the whole
repo. Forward-slash paths and globs work on Windows too — jscpd normalizes them.

Repo defaults live in **[.jscpd.json](../../../.jscpd.json)** at the repo root (ignore globs
for `node_modules`, builds, venvs, `migrations/`, `deploy/`; `minLines: 10`; respects
`.gitignore`). Any CLI flag below overrides the config file.

## The `ai` reporter

`--reporters ai` prints one line per clone in a compact, machine-parsable form: the two
duplicated locations (file + line range) and the size. That's the format the
[dry-refactoring](../dry-refactoring/SKILL.md) workflow parses. Other reporters:
`console`, `console-full`, `json`, `html`, `markdown`, `sarif`, `xcode`, `badge`, `xml`,
`csv`, `threshold`, `silent`.

## Useful options

| Flag | Purpose |
|------|---------|
| `-r, --reporters <list>` | Output format(s), comma-separated. Use `ai` for this workflow. |
| `-l, --min-lines <n>` | Minimum clone size in lines (default in our config: 10). Raise to cut noise. |
| `-k, --min-tokens <n>` | Minimum clone size in tokens. |
| `-x, --max-lines <n>` | Skip files longer than N lines. |
| `-m, --mode <mild\|weak\|strict>` | Detection strictness. `weak` skips comment/empty tokens (our default). |
| `-f, --format <list>` | Restrict to file types, e.g. `javascript,typescript,python`. |
| `-i, --ignore <globs>` | Extra glob patterns to skip, comma-separated. |
| `--no-gitignore` | Do NOT respect `.gitignore` (by default jscpd does). |
| `-t, --threshold <pct>` | Fail (non-zero exit) if duplication exceeds this %. Handy in CI. |
| `-o, --output <dir>` | Output directory for file reporters (html/json/etc.). |
| `-c, --config <file>` | Explicit config path (defaults to `.jscpd.json`). |
| `-s, --silent` | Suppress progress output. |
| `--formats-list` | List all supported languages and exit. |

## Examples

```bash
# Scan one service, AI output for refactoring
npx jscpd --reporters ai server/core

# Only meaningful clones (>= 20 lines), JS/TS only
npx jscpd --reporters ai --min-lines 20 --format javascript,typescript agent-hub/src

# Whole repo, human-readable console output (uses .jscpd.json ignores)
npx jscpd .

# CI gate: fail if > 5% duplication
npx jscpd --threshold 5 server agent-hub
```

## Next step

Once you have the clone list, hand off to **[dry-refactoring](../dry-refactoring/SKILL.md)**
to design and apply the fix (extract function / module / constant / base class), then
re-run jscpd to confirm the clone is gone.
