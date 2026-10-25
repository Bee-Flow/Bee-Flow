#!/usr/bin/env node
/**
 * File budget — the largest files may not grow.
 *
 * The root-level counterpart of mobile/quality-budget.json: every package has
 * a line limit per file (a default for source, a higher one for tests), and a
 * file that was already over it when the gate landed keeps its measured line
 * count as a personal ceiling. That ceiling only comes down. A new file over
 * the limit fails, a budgeted file that grows past its ceiling fails; a file
 * that shrinks passes, and `--update` writes the lower number.
 *
 * The count ratchet's `big-file` metric only counts HOW MANY files are over
 * the limit, so a 1,500-line file could grow to 3,000 without a word. This
 * gate pins each one.
 *
 * Unlike mobile's budget, a ceiling above the measured size is not a failure:
 * every refactor that removes a line from one of the ~800 budgeted files would
 * otherwise have to touch the budget file too, and parallel branches would
 * collide in it. The gate says how many ceilings can come down; `--update`
 * lowers them (and drops the files that are back under the limit).
 *
 * Data files — templates, fixtures, generated bundles, dictionaries, prompt
 * text — are long because their content is long, not because their structure
 * is. They are listed in the budget's "data" list, each glob with a reason,
 * and skipped. A data glob that matches no file fails: a stale exemption is
 * a hole a future file could fall through.
 *
 * Budget: <package>/.file-budget.json
 *   limit       line limit for source files (default per package below)
 *   testLimit   line limit for test files (default 1000)
 *   data        [{ glob, reason }] — package-relative globs (`*` stays in one
 *               path segment, `**` crosses them), skipped entirely
 *   files       { "<package-relative path>": ceiling } — files over the limit
 *
 * Usage:
 *   node scripts/file-budget.mjs <package>...            gate
 *   node scripts/file-budget.mjs <package>... --update   lower the ceilings (never raises, never adds)
 *   node scripts/file-budget.mjs <package>... --list     files over the limit, largest first
 *   node scripts/file-budget.mjs <package>... --list --top 20
 *
 * Code files (.js .ts .mjs ...) are measured in code lines: comments and blank
 * lines do not count (scripts/code-lines.mjs, the unit count-ratchet's `big-file`
 * uses too), so JSDoc and type comments cannot push a file over. Other files
 * (Python) are measured in physical lines as `wc -l` counts them. The files are the package's tracked and untracked-but-not-ignored
 * files (`git ls-files -co --exclude-standard`), so a build artefact or a
 * local data directory cannot move a number; outside a git work tree the
 * package directory is walked instead, minus the usual build directories.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { codeLineCount, isCodeFile } from './code-lines.mjs';
import { isEntryPoint } from './entry-point.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const JS = { extensions: /\.(?:[cm]?[jt]sx?)$/, test: /(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/ };
const PY = { extensions: /\.py$/, test: /(?:^|\/)tests?\/|(?:^|\/)test_[^/]*\.py$|_test\.py$/ };

/** Defaults for a package's first budget; the budget file is what counts after that. */
export const PACKAGE_DEFAULTS = {
    server: { limit: 400, language: JS },
    'agent-hub': { limit: 400, language: JS },
    desktop: { limit: 400, language: JS },
    'guard-service': { limit: 600, language: PY },
};
const FALLBACK = { limit: 400, language: JS };
export const TEST_LIMIT = 1000;

const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-runtime', 'build', 'coverage', '.vite', '__pycache__', '.venv', '.git']);

/** Physical lines, as `wc -l` counts them, plus a last line without a newline. */
export const lineCount = (text) => (text.match(/\n/g) || []).length + (text.endsWith('\n') || text === '' ? 0 : 1);

/** A package-relative glob as a RegExp: `**` crosses segments, `*` and `?` do not. */
export function globToRegExp(glob) {
    let out = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*' && glob[i + 1] === '*') {
            const slash = glob[i + 2] === '/';
            out += slash ? '(?:.*/)?' : '.*';
            i += slash ? 2 : 1;
        } else if (c === '*') out += '[^/]*';
        else if (c === '?') out += '[^/]';
        else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${out}$`);
}

function walk(dir, base, into) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, base, into);
        else if (entry.isFile()) into.push(path.relative(base, full).split(path.sep).join('/'));
    }
    return into;
}

/** Package-relative paths of the files that exist, gitignored ones excluded. */
export function listFiles(dir) {
    const res = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: dir, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (res.error || res.status !== 0) return walk(dir, dir, []);
    return res.stdout.split('\0').filter((rel) => {
        if (!rel || rel.split('/').some((segment) => SKIP_DIRS.has(segment))) return false;
        try {
            return fs.statSync(path.join(dir, rel)).isFile(); // a deleted tracked file is still in the index
        } catch {
            return false;
        }
    });
}

/**
 * Measure a package against a budget. Pure apart from reading the files.
 * Returns the rows over the limit and everything the gate has to say.
 */
export function measure({ dir, files, budget, language }) {
    const data = (budget.data || []).map((entry) => ({ ...entry, re: globToRegExp(entry.glob), hits: 0 }));
    const ceilings = budget.files || {};
    const rows = [];
    let dataSkipped = 0;
    for (const rel of files) {
        if (!language.extensions.test(rel)) continue;
        const hit = data.find((entry) => entry.re.test(rel));
        if (hit) {
            hit.hits++;
            dataSkipped++;
            continue;
        }
        const isTest = language.test.test(rel);
        const limit = isTest ? budget.testLimit : budget.limit;
        const text = fs.readFileSync(path.join(dir, rel), 'utf8');
        const lines = isCodeFile(rel) ? codeLineCount(text) : lineCount(text);
        const ceiling = ceilings[rel];
        if (lines <= limit && ceiling === undefined) continue;
        rows.push({ rel, lines, limit, ceiling, isTest });
    }
    const seen = new Set(rows.map((row) => row.rel));
    const gone = Object.keys(ceilings).filter((rel) => !seen.has(rel));
    const overLimit = rows.filter((row) => row.lines > row.limit);
    return {
        rows,
        overLimit,
        unbudgeted: overLimit.filter((row) => row.ceiling === undefined),
        grew: overLimit.filter((row) => row.ceiling !== undefined && row.lines > row.ceiling),
        // A ceiling above the measured size, a file back under the limit, a budgeted file that is gone.
        loose: rows.filter((row) => row.ceiling !== undefined && (row.lines < row.ceiling || row.lines <= row.limit)).length + gone.length,
        staleData: data.filter((entry) => entry.hits === 0).map(({ glob }) => glob),
        dataSkipped,
    };
}

/** The ceilings --update writes: only lower, only for files still over the limit, never a new one. */
export function lowered(result) {
    const next = {};
    for (const row of result.overLimit) {
        if (row.ceiling === undefined) continue;
        next[row.rel] = Math.min(row.lines, row.ceiling);
    }
    return next;
}

/** All over-limit files at their measured size: the budget a package starts with. */
export function initial(result) {
    return Object.fromEntries(result.overLimit.map((row) => [row.rel, row.lines]));
}

const sortedObject = (obj) => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));

function commentFor(pkg) {
    return `Per-file line budget for ${pkg} (scripts/file-budget.mjs, npm run lint:file-budget). A source file may have at most \`limit\` code lines (comments and blank lines are not counted; Python files count physical lines), a test file \`testLimit\`; a file listed under \`files\` was already over it and may not grow past its ceiling. Ceilings only come down: \`node scripts/file-budget.mjs ${pkg} --update\` lowers them after a split. Touch a budgeted file, split it. Adding a file or raising a ceiling is a deliberate edit that belongs in a commit message with a reason. \`data\` lists generated files, fixtures, templates and dictionaries whose length is content, each with a reason; they are skipped.`;
}

function readBudget(file) {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function runPackage(pkg, { update, list, top }) {
    const dir = path.resolve(ROOT, pkg);
    if (!fs.existsSync(dir)) {
        console.error(`file-budget: ${pkg} not found — is "${pkg}" a package directory?`);
        return 2;
    }
    const defaults = PACKAGE_DEFAULTS[pkg] ?? FALLBACK;
    const budgetFile = path.join(dir, '.file-budget.json');
    const existing = readBudget(budgetFile);
    const budget = {
        limit: existing?.limit ?? defaults.limit,
        testLimit: existing?.testLimit ?? TEST_LIMIT,
        data: existing?.data ?? [],
        files: existing?.files ?? {},
    };
    const result = measure({ dir, files: listFiles(dir), budget, language: defaults.language });
    const budgetRel = path.relative(ROOT, budgetFile).split(path.sep).join('/');

    if (list) {
        const rows = [...result.overLimit].sort((a, b) => b.lines - a.lines || a.rel.localeCompare(b.rel));
        console.log(`${pkg}: ${rows.length} files over the limit (${budget.limit} source, ${budget.testLimit} test)`);
        for (const row of rows.slice(0, top ?? rows.length)) {
            const mark = row.ceiling === undefined ? 'NEW ' : row.lines > row.ceiling ? 'GREW' : '    ';
            console.log(`${String(row.lines).padStart(6)} / ${String(row.ceiling ?? row.limit).padStart(5)}  ${mark}  ${row.rel}`);
        }
        console.log('');
    }

    if (update || !existing) {
        const files = existing ? lowered(result) : initial(result);
        const next = {
            _comment: existing?._comment ?? commentFor(pkg),
            _generated: new Date().toISOString().slice(0, 10),
            limit: budget.limit,
            testLimit: budget.testLimit,
            data: budget.data,
            files: sortedObject(files),
        };
        fs.writeFileSync(budgetFile, `${JSON.stringify(next, null, 2)}\n`);
        console.log(`Budget written to ${budgetRel}: ${Object.keys(files).length} files with a ceiling (measured ${result.overLimit.length} over the limit, ${result.dataSkipped} data files skipped)`);
        if (!existing) return 0;
        budget.files = files;
        Object.assign(result, measure({ dir, files: listFiles(dir), budget, language: defaults.language }));
    }

    let failed = false;
    for (const row of result.unbudgeted) {
        failed = true;
        console.error(`❌ ${pkg}: ${row.rel} has ${row.lines} lines, over the ${row.limit}-line ${row.isTest ? 'test ' : ''}limit — split it by responsibility (or, if it is data, list it under "data" in ${budgetRel} with a reason)`);
    }
    for (const row of result.grew) {
        failed = true;
        console.error(`❌ ${pkg}: ${row.rel} grew to ${row.lines} lines, its ceiling is ${row.ceiling} — split it rather than raising the ceiling`);
    }
    for (const glob of result.staleData) {
        failed = true;
        console.error(`❌ ${pkg}: data entry "${glob}" in ${budgetRel} matches no file — remove it`);
    }
    if (failed) {
        if (update) console.error(`   --update never adds a file or raises a ceiling; that is a hand edit with a reason in the commit.`);
        return 1;
    }
    const summary = `${result.overLimit.length} files over the limit (${budget.limit} source, ${budget.testLimit} test), none past its ceiling, ${result.dataSkipped} data files skipped`;
    if (result.loose > 0 && !update) {
        console.log(`✅ ${pkg}: ${summary}. ${result.loose} ${result.loose === 1 ? 'ceiling' : 'ceilings'} can come down: run \`node scripts/file-budget.mjs ${pkg} --update\`.`);
    } else {
        console.log(`➖ ${pkg}: ${summary}, at budget`);
    }
    return 0;
}

export function main(argv = process.argv.slice(2)) {
    const packages = [];
    let top;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--top') top = Number(argv[++i]);
        else if (!argv[i].startsWith('--')) packages.push(argv[i]);
    }
    const flags = { update: argv.includes('--update'), list: argv.includes('--list'), top };
    if (!packages.length || (top !== undefined && !(top > 0))) {
        console.error('file-budget: usage: node scripts/file-budget.mjs <package>... [--update] [--list [--top N]]');
        return 2;
    }
    let code = 0;
    for (const pkg of packages) code = Math.max(code, runPackage(pkg, flags));
    return code;
}

if (isEntryPoint(import.meta.url)) process.exit(main());
