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
 * drives its CLI. It writes a gitignored tsconfig next to jsconfig.json
 * (extends it, checkJs on, `files` = the marked files plus types/*.d.ts), runs
 * `tsc --pretty false` and keeps only the diagnostics in marked files.
 * Whatever the marked files require is loaded for its types; with checkJs on
 * tsc checks those files too, but their errors are dropped here, as before
 * (TS 6 needed an in-memory `@ts-check` rewrite because checking the whole
 * require graph ran out of a 2 GB heap; the native compiler does not).
 *
 * Usage: node scripts/typecheck.mjs [--list] [--file <path>]
 *   --list         print the marked files
 *   --file <path>  check one file (marked or not) and report only its errors
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', 'coverage']);
export const MARKER = /^\s*\/\/\s*@typecheck\b/m;
const TSC = path.join(SERVER_DIR, 'node_modules', 'typescript', 'bin', 'tsc');

/** The opted-in files: `// @typecheck` within the first lines. */
export function checkedFiles(dir = SERVER_DIR, prefix = '') {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            if (!SKIP.has(entry.name)) out.push(...checkedFiles(path.join(dir, entry.name), rel));
        } else if (entry.isFile() && /\.[cm]?js$/.test(entry.name)) {
            const head = readFileSync(path.join(dir, entry.name), 'utf8').split('\n').slice(0, 30).join('\n');
            if (MARKER.test(head)) out.push(rel);
        }
    }
    return out.sort();
}

/**
 * `file(line,col): error TSnnnn: message` lines from `tsc --pretty false`,
 * with indented continuation lines folded into the message. A diagnostic
 * without a file (an options error) has file null.
 */
export function parseDiagnostics(output) {
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
 * Type-check `files` (relative to `dir`) and return the diagnostics in those
 * files plus file-less ones. `dir` holds jsconfig.json and optionally types/.
 * With `single` the generated config gets a per-process name, so parallel
 * `--file` runs never overwrite each other's.
 */
export function runTypecheck(files, { dir = SERVER_DIR, single = false, tsc = TSC } = {}) {
    const ambient = readdirSafe(path.join(dir, 'types')).filter((f) => f.endsWith('.d.ts')).map((f) => `types/${f}`);
    const configPath = path.join(dir, single ? `.typecheck.${process.pid}.tsconfig.json` : '.typecheck.tsconfig.json');
    const config = {
        extends: './jsconfig.json',
        compilerOptions: { checkJs: true, noEmit: true },
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

export function formatDiagnostic(d) {
    return d.file === null ? `error ${d.code}: ${d.text}` : `${d.file}(${d.line},${d.col}): error ${d.code}: ${d.text}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const fileArg = process.argv.indexOf('--file');
    let files;
    if (fileArg !== -1) {
        const target = process.argv[fileArg + 1];
        if (!target) {
            console.error('typecheck: --file needs a path');
            process.exit(2);
        }
        files = [path.relative(SERVER_DIR, path.resolve(process.cwd(), target))];
    } else {
        files = checkedFiles();
        if (process.argv.includes('--list')) {
            for (const f of files) console.log(f);
            process.exit(0);
        }
        if (files.length === 0) {
            console.log('typecheck: no server file carries // @typecheck yet');
            process.exit(0);
        }
    }

    const { diagnostics, crashed, output } = runTypecheck(files, { single: fileArg !== -1 });
    if (crashed) {
        process.stderr.write(output);
        console.error('\ntypecheck: tsc stopped before checking (output above)');
        process.exit(2);
    }
    if (diagnostics.length > 0) {
        for (const d of diagnostics) console.log(formatDiagnostic(d));
        console.error(`\ntypecheck: ${diagnostics.length} error(s) in ${fileArg !== -1 ? files[0] : 'files marked // @typecheck'}`);
        process.exit(1);
    }
    console.log(fileArg !== -1 ? `typecheck: ${files[0]}, no errors` : `typecheck: ${files.length} file(s) with // @typecheck, no errors`);
}

function readdirSafe(dir) {
    try { return readdirSync(dir); } catch { return []; }
}
