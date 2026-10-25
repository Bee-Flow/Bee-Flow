#!/usr/bin/env node
// @typecheck
/**
 * `npm run typecheck` — type-check every server file that opted in with a
 * `// @typecheck` line in its header, and report errors for those files only.
 *
 * Why not `// @ts-check`: agent-hub's tests import server modules, so
 * agent-hub's own typecheck (strict, noImplicitAny) reaches most of the server
 * tree and honours every `// @ts-check` it finds — under ITS options. A server
 * file that passes this check would still break the frontend job (it did:
 * 364 errors from server/utils alone). A marker only this script reads keeps
 * the two checks independent, so the server can tighten at its own pace.
 *
 * How: TypeScript 7 (the native compiler) has no JavaScript API, so this
 * drives its CLI. For each level it writes a gitignored tsconfig next to
 * jsconfig.json (extends it, checkJs on, the level's options, `files` = the
 * files at that level plus types/*.d.ts), runs `tsc --pretty false` and keeps
 * only the diagnostics in those files. Whatever they require is loaded for its
 * types; with checkJs on tsc checks those files too, but their errors are
 * dropped here.
 *
 * Three levels, one marker line in the first 30 lines of a file, one tsc run each:
 *   // @typecheck                  the options of jsconfig.json
 *   // @typecheck noImplicitAny    + noImplicitAny
 *   // @typecheck strict           strictNullChecks, noImplicitAny, strictBindCallApply,
 *                                  strictFunctionTypes, noImplicitThis, alwaysStrict
 *                                  (useUnknownInCatchVariables stays off)
 * .js, .cjs, .mjs, .mts and .cts files count. A new file starts at `strict`
 * (scripts/check-new-code-types.mjs); an old one moves up a level at a time.
 * scripts/checkjs-ratchet.mjs keeps the number of files per level from falling.
 *
 * Usage: node scripts/typecheck.mjs [--list] [--file <path>] [--measure] [--promote]
 *   --list         print the marked files, the level after the path unless it is the base
 *   --file <path>  check one file (marked or not) at the level it carries
 *   --measure      per level: files, and what checking them at the next level would report
 *                  (the pending errors are printed; --summary leaves them out)
 *   --promote      rewrite the marker of every file that is already clean at a higher level
 *                  (test files stay where they are unless --tests)
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', 'coverage']);
const HEADER_LINES = 30;
const TSC = path.join(SERVER_DIR, 'node_modules', 'typescript', 'bin', 'tsc');

/** Any `// @typecheck` line. */
export const MARKER = /^\s*\/\/\s*@typecheck\b/m;
const MARKER_LINE = /^(\s*\/\/\s*@typecheck)\b[ \t]*(noImplicitAny|strict)?\b.*$/m;
/** Source files the check reads: JavaScript and the TypeScript the server will grow, not declarations. */
export const SOURCE_FILE = /\.(?:[cm]?js|[cm]ts)$/;
const DECLARATION = /\.d\.[cm]?ts$/;
const TEST_FILE = /\.test\.[cm]?[jt]s$|\.testkit\.|\.testutil\./;

/** @typedef {'base' | 'noImplicitAny' | 'strict'} Level */
/** @type {Level[]} */
export const LEVELS = ['base', 'noImplicitAny', 'strict'];

/** Compiler options each level adds on top of jsconfig.json. */
export const LEVEL_OPTIONS = {
    base: {},
    noImplicitAny: { noImplicitAny: true },
    strict: {
        strictNullChecks: true,
        noImplicitAny: true,
        strictBindCallApply: true,
        strictFunctionTypes: true,
        noImplicitThis: true,
        alwaysStrict: true,
        useUnknownInCatchVariables: false,
    },
};

/**
 * The level of a file's header: 'strict', 'noImplicitAny', 'base' (`// @typecheck`) or null.
 * @param {string} text
 * @returns {Level | null}
 */
export function levelOfText(text) {
    const head = text.split('\n').slice(0, HEADER_LINES).join('\n');
    const m = MARKER_LINE.exec(head);
    if (!m) return null;
    return m[2] === 'strict' ? 'strict' : m[2] === 'noImplicitAny' ? 'noImplicitAny' : 'base';
}

/**
 * The text with its marker line set to `level`, or unchanged when it has no marker.
 * @param {string} text
 * @param {Level} level
 */
export function withLevel(text, level) {
    const lines = text.split('\n');
    for (let i = 0; i < Math.min(lines.length, HEADER_LINES); i++) {
        const m = MARKER_LINE.exec(lines[i]);
        if (m) {
            lines[i] = `${m[1]}${level === 'base' ? '' : ` ${level}`}`;
            break;
        }
    }
    return lines.join('\n');
}

/**
 * Every opted-in file, relative to `dir`, with its level.
 * @param {string} [dir]
 * @param {string} [prefix]
 * @returns {{ file: string, level: Level }[]}
 */
export function markedFiles(dir = SERVER_DIR, prefix = '') {
    /** @type {{ file: string, level: Level }[]} */
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            if (!SKIP.has(entry.name)) out.push(...markedFiles(path.join(dir, entry.name), rel));
        } else if (entry.isFile() && SOURCE_FILE.test(entry.name) && !DECLARATION.test(entry.name)) {
            const level = levelOfText(readFileSync(path.join(dir, entry.name), 'utf8'));
            if (level) out.push({ file: rel, level });
        }
    }
    return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/**
 * The opted-in files (every level), or with `only` just those at that level.
 * @param {string} [dir]
 * @param {string} [prefix]
 * @param {Level | null} [only]
 */
export function checkedFiles(dir = SERVER_DIR, prefix = '', only = null) {
    return markedFiles(dir, prefix).filter((f) => !only || f.level === only).map((f) => f.file);
}

/**
 * `file(line,col): error TSnnnn: message` lines from `tsc --pretty false`,
 * with indented continuation lines folded into the message. A diagnostic
 * without a file (an options error) has file null.
 * @param {string} output
 * @returns {{ file: string | null, line: number, col: number, code: string, text: string }[]}
 */
export function parseDiagnostics(output) {
    /** @type {{ file: string | null, line: number, col: number, code: string, text: string }[]} */
    const out = [];
    for (const line of output.split(/\r?\n/)) {
        const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line);
        if (m) {
            out.push({ file: m[1], line: Number(m[2]), col: Number(m[3]), code: m[4], text: m[5] });
            continue;
        }
        const g = /^error (TS\d+): (.*)$/.exec(line);
        if (g) {
            out.push({ file: null, line: 0, col: 0, code: g[1], text: g[2] });
        } else if (/^\s+\S/.test(line) && out.length > 0) {
            out[out.length - 1].text += `\n${line}`;
        }
    }
    return out;
}

/**
 * Type-check `files` (relative to `dir`) at `level` and return the diagnostics in those
 * files plus file-less ones. `dir` holds jsconfig.json and optionally types/.
 * With `single` the generated config gets a per-process name, so parallel
 * `--file` runs never overwrite each other's.
 * @param {string[]} files
 * @param {{ dir?: string, single?: boolean, tsc?: string, level?: Level }} [opts]
 */
export function runTypecheck(files, { dir = SERVER_DIR, single = false, tsc = TSC, level = 'base' } = {}) {
    const ambient = readdirSafe(path.join(dir, 'types')).filter((f) => f.endsWith('.d.ts')).map((f) => `types/${f}`);
    const tag = level === 'base' ? '' : `${level.toLowerCase()}.`;
    const configPath = path.join(dir, single ? `.typecheck.${tag}${process.pid}.tsconfig.json` : `.typecheck.${tag}tsconfig.json`);
    const config = {
        extends: './jsconfig.json',
        compilerOptions: { checkJs: true, noEmit: true, ...LEVEL_OPTIONS[level] },
        files: [...files, ...ambient],
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    let result;
    try {
        result = spawnSync(process.execPath, [tsc, '-p', configPath, '--pretty', 'false'], {
            cwd: dir,
            encoding: 'utf8',
            maxBuffer: 256 * 1024 * 1024,
        });
    } finally {
        if (single) rmSync(configPath, { force: true });
    }
    if (result.error) throw result.error;
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const all = parseDiagnostics(output);
    const wanted = new Set(files.map((f) => path.normalize(f)));
    const diagnostics = all.filter((d) => d.file === null || wanted.has(path.relative(dir, path.resolve(dir, d.file))));
    // tsc exits non-zero when it reports errors; non-zero without a single
    // parsed diagnostic means it never got as far as checking.
    const crashed = result.status !== 0 && all.length === 0;
    return { diagnostics, crashed, output };
}

/** @param {{ file: string | null, line: number, col: number, code: string, text: string }} d */
export function formatDiagnostic(d) {
    return d.file === null ? `error ${d.code}: ${d.text}` : `${d.file}(${d.line},${d.col}): error ${d.code}: ${d.text}`;
}

/**
 * Check each level's files at that level: one tsc run per non-empty level.
 * @param {{ file: string, level: Level }[]} marked
 * @param {{ dir?: string, single?: boolean, tsc?: string }} [opts]
 */
export function checkLevels(marked, opts = {}) {
    const runs = [];
    for (const level of LEVELS) {
        const files = marked.filter((f) => f.level === level).map((f) => f.file);
        if (files.length === 0) continue;
        runs.push({ level, files, ...runTypecheck(files, { ...opts, level }) });
    }
    return runs;
}

/**
 * Run `files` at `level` and report which of them are clean.
 * @param {string[]} files
 * @param {Level} level
 * @param {{ dir?: string, tsc?: string }} [opts]
 */
export function cleanAt(files, level, opts = {}) {
    if (files.length === 0) return { clean: [], diagnostics: [], crashed: false, output: '' };
    const r = runTypecheck(files, { ...opts, level });
    const bad = new Set(r.diagnostics.map((d) => (d.file === null ? null : path.normalize(d.file))));
    // A file-less error (a broken option) means nothing can be called clean.
    const clean = bad.has(null) || r.crashed ? [] : files.filter((f) => !bad.has(path.normalize(f)));
    return { clean, diagnostics: r.diagnostics, crashed: r.crashed, output: r.output };
}

/**
 * Move every file that is clean at a higher level up to it. Base -> noImplicitAny first,
 * then everything at noImplicitAny (the new arrivals too) -> strict, so a file can jump two.
 * @param {{ dir?: string, tsc?: string, tests?: boolean, write?: boolean }} [opts]
 * @returns {{ promoted: Record<string, Level>, crashed: boolean, output: string }}
 */
export function promote({ dir = SERVER_DIR, tsc = TSC, tests = false, write = true } = {}) {
    const marked = markedFiles(dir);
    /** @type {Map<string, Level>} */
    const level = new Map(marked.map((f) => [f.file, f.level]));
    const eligible = (/** @type {string} */ f) => tests || !TEST_FILE.test(f);
    /** @type {Record<string, Level>} */
    const promoted = {};
    for (const [from, to] of /** @type {[Level, Level][]} */ ([['base', 'noImplicitAny'], ['noImplicitAny', 'strict']])) {
        const files = [...level].filter(([f, l]) => l === from && eligible(f)).map(([f]) => f);
        const r = cleanAt(files, to, { dir, tsc });
        if (r.crashed) return { promoted, crashed: true, output: r.output };
        for (const f of r.clean) { level.set(f, to); promoted[f] = to; }
    }
    if (write) {
        for (const [f, l] of Object.entries(promoted)) {
            const abs = path.join(dir, f);
            writeFileSync(abs, withLevel(readFileSync(abs, 'utf8'), l));
        }
    }
    return { promoted, crashed: false, output: '' };
}

/**
 * Per level: how many files, and what the next level would say about them.
 * @param {{ dir?: string, tsc?: string }} [opts]
 */
export function measure({ dir = SERVER_DIR, tsc = TSC } = {}) {
    const marked = markedFiles(dir);
    const count = (/** @type {Level} */ l) => marked.filter((f) => f.level === l).length;
    const rows = [{ level: /** @type {Level} */ ('base'), files: count('base') }, { level: /** @type {Level} */ ('noImplicitAny'), files: count('noImplicitAny') }, { level: /** @type {Level} */ ('strict'), files: count('strict') }];
    const pending = [];
    // Everything below `strict` checked at strict, everything at `base` checked at noImplicitAny.
    for (const [from, to] of /** @type {[Level[], Level][]} */ ([[['base'], 'noImplicitAny'], [['base', 'noImplicitAny'], 'strict']])) {
        const files = marked.filter((f) => from.includes(f.level)).map((f) => f.file);
        const r = cleanAt(files, to, { dir, tsc });
        pending.push({ to, files: files.length, clean: r.clean.length, errors: r.diagnostics.length, diagnostics: r.diagnostics, crashed: r.crashed, output: r.output });
    }
    return { rows, pending };
}

/** @param {string} dir */
function readdirSafe(dir) {
    try { return readdirSync(dir); } catch { return []; }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv.slice(2));
}

/** @param {string[]} args */
function main(args) {
    if (args.includes('--measure')) {
        const { rows, pending } = measure();
        for (const p of pending) {
            if (p.crashed) { process.stderr.write(p.output); console.error(`typecheck: tsc stopped before checking (${p.to} level)`); process.exit(2); }
            if (!args.includes('--summary')) for (const d of p.diagnostics) console.log(`${formatDiagnostic(d)}  [${p.to}]`);
        }
        console.log(rows.map((r) => `${r.level}: ${r.files} files`).join(', '));
        for (const p of pending) console.log(`at ${p.to}: ${p.errors} errors pending, ${p.clean} of ${p.files} files already clean`);
        return;
    }
    if (args.includes('--promote')) {
        const r = promote({ tests: args.includes('--tests') });
        if (r.crashed) { process.stderr.write(r.output); console.error('typecheck: tsc stopped before checking (output above)'); process.exit(2); }
        const to = Object.values(r.promoted);
        console.log(`typecheck: promoted ${to.length} file(s): ${to.filter((l) => l === 'noImplicitAny').length} to noImplicitAny, ${to.filter((l) => l === 'strict').length} to strict`);
        return;
    }

    const fileArg = args.indexOf('--file');
    const single = fileArg !== -1;
    /** @type {{ file: string, level: Level }[]} */
    let marked;
    if (single) {
        const target = args[fileArg + 1];
        if (!target) {
            console.error('typecheck: --file needs a path');
            process.exit(2);
        }
        const file = path.relative(SERVER_DIR, path.resolve(process.cwd(), target));
        marked = [{ file, level: levelOfText(readFileSync(path.join(SERVER_DIR, file), 'utf8')) ?? 'base' }];
    } else {
        marked = markedFiles();
        if (args.includes('--list')) {
            for (const f of marked) console.log(f.level === 'base' ? f.file : `${f.file} ${f.level}`);
            return;
        }
        if (marked.length === 0) {
            console.log('typecheck: no server file carries // @typecheck yet');
            return;
        }
    }

    const runs = checkLevels(marked, { single });
    const crashed = runs.find((r) => r.crashed);
    if (crashed) {
        process.stderr.write(crashed.output);
        console.error(`\ntypecheck: tsc stopped before checking (${crashed.level} level, output above)`);
        process.exit(2);
    }
    const diagnostics = runs.flatMap((r) => r.diagnostics.map((d) => ({ ...d, level: r.level })));
    if (diagnostics.length > 0) {
        for (const d of diagnostics) console.log(`${formatDiagnostic(d)}${d.level === 'base' ? '' : `  [${d.level}]`}`);
        console.error(`\ntypecheck: ${diagnostics.length} error(s) in ${single ? marked[0].file : 'files marked // @typecheck'}`);
        process.exit(1);
    }
    const counts = LEVELS.map((l) => `${marked.filter((f) => f.level === l).length} ${l}`).join(', ');
    console.log(single ? `typecheck: ${marked[0].file}, no errors` : `typecheck: ${marked.length} file(s) with // @typecheck (${counts}), no errors`);
}
