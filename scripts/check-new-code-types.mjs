#!/usr/bin/env node
/**
 * New server code is typed from its first commit.
 *
 * A server source file ADDED since the base commit (the merge-base with origin/main) must be
 * TypeScript (.mts or .cts) or carry `// @typecheck strict` in its header, so the strict
 * level (server/scripts/typecheck.mjs) only ever gains files. Old files are not touched: they
 * move up a level at a time (`npm run typecheck -- --promote`).
 *
 * Not counted: tests and their kits, declaration files, migrations, the i18n dictionaries,
 * generated files, fixtures and everything outside server/ or under node_modules.
 *
 * Usage:
 *   node scripts/check-new-code-types.mjs --base <rev>     files added since <rev> (plus untracked ones)
 *   node scripts/check-new-code-types.mjs --files a.js,b.mts   check these paths
 * Exit 1 lists each file that needs the marker or a rename.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from './entry-point.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = /\.(?:[cm]?js|[cm]ts)$/;
const TYPESCRIPT = /\.[cm]ts$/;
const STRICT = /^\s*\/\/\s*@typecheck[ \t]+strict\b/m;
const EXEMPT = [
    /\.d\.[cm]?ts$/,
    /\.(?:test|spec)\.[cm]?[jt]s$/,
    /\.(?:testkit|testutil|fixture|golden|generated)\.[cm]?[jt]s$/,
    /(^|\/)(node_modules|coverage|migrations|__fixtures__|fixtures)\//,
    /^server\/i18n\//,
    /^server\/types\//,
];

/** Does this repo-relative path fall under the rule? */
export function needsTypes(file) {
    return file.startsWith('server/') && SOURCE.test(file) && !EXEMPT.some((re) => re.test(file));
}

/**
 * The files that break the rule among `files` (repo-relative); `read` returns a file's text.
 * @param {string[]} files
 * @param {(f: string) => string} read
 */
export function violations(files, read) {
    return files.filter((f) => {
        if (!needsTypes(f) || TYPESCRIPT.test(f)) return false;
        return !STRICT.test(read(f).split('\n').slice(0, 30).join('\n'));
    });
}

function git(args, cwd = ROOT) {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.split('\n').filter(Boolean);
}

/** Files added since `base`, plus untracked ones. */
export function addedFiles(base, cwd = ROOT) {
    return [...new Set([
        ...git(['diff', '--name-only', '--diff-filter=A', `${base}...HEAD`], cwd),
        ...git(['diff', '--name-only', '--diff-filter=A', 'HEAD'], cwd),
        ...git(['ls-files', '--others', '--exclude-standard'], cwd),
    ])];
}

export function main(argv = process.argv.slice(2), cwd = ROOT, log = console) {
    const val = (flag) => { const i = argv.indexOf(flag); return i === -1 ? null : argv[i + 1]; };
    const filesArg = val('--files');
    const base = val('--base');
    if (!filesArg && !base) {
        log.error('check-new-code-types: pass --base <rev> or --files a,b');
        return 2;
    }
    const files = filesArg ? filesArg.split(',').filter(Boolean) : addedFiles(base, cwd);
    const bad = violations(files, (f) => fs.readFileSync(path.join(cwd, f), 'utf8'));
    for (const f of bad) log.error(`new-code-types: ${f} is new server code: write it as .mts, or put \`// @typecheck strict\` in its header`);
    if (bad.length === 0) log.log(`new-code-types: ${files.filter(needsTypes).length} new server source file(s), all typed`);
    return bad.length ? 1 : 0;
}

if (isEntryPoint(import.meta.url)) process.exit(main());
