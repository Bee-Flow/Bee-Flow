#!/usr/bin/env node
/**
 * checkJs ratchet — the number of server files that opted in to type checking
 * with `// @typecheck` may only RISE.
 *
 * The server gets its types from JSDoc, checked file by file
 * (`cd server && npm run typecheck`). This is the other
 * half: a file that is checked today must stay checked, so removing the line to
 * silence an error fails here instead of quietly shrinking the checked set.
 *
 * Three levels (server/scripts/typecheck.mjs): `// @typecheck`, `// @typecheck noImplicitAny`
 * and `// @typecheck strict`. Each has its own floor: `checkedFiles` (any level),
 * `noImplicitAnyFiles` (that level or strict) and `strictFiles`. A file that moves
 * down a level fails the floor of the level it left.
 *
 * Mirror image of the count ratchets: the budget is a floor, `--update` only
 * raises it.
 *
 * Usage:
 *   node scripts/checkjs-ratchet.mjs <package>            gate
 *   node scripts/checkjs-ratchet.mjs <package> --update   raise the floor
 *   node scripts/checkjs-ratchet.mjs <package> --list     the files not yet checked, by folder
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', 'coverage', 'dist', 'build']);
const TS_CHECK = /^\s*\/\/\s*@typecheck\b/m;
const LEVEL = /^\s*\/\/\s*@typecheck[ \t]+(noImplicitAny|strict)\b/m;
const TEST_FILE = /\.test\.[cm]?[jt]s$/;

const args = process.argv.slice(2);
const pkg = args.find((a) => !a.startsWith('--'));
const update = args.includes('--update');
const list = args.includes('--list');
if (!pkg) {
    console.error('checkjs-ratchet: usage: node scripts/checkjs-ratchet.mjs <package> [--update] [--list]');
    process.exit(2);
}
const dir = path.resolve(ROOT, pkg);
if (!fs.existsSync(dir)) {
    console.error(`checkjs-ratchet: ${pkg} not found`);
    process.exit(2);
}

function collect(from, into) {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const full = path.join(from, entry.name);
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) collect(full, into);
        } else if (entry.isFile() && /\.(?:[cm]?js|[cm]ts)$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name) && !TEST_FILE.test(entry.name)) {
            into.push(full);
        }
    }
    return into;
}

let checked = 0;
let noImplicitAny = 0;
let strict = 0;
const unchecked = new Map();
const files = collect(dir, []);
for (const file of files) {
    const head = fs.readFileSync(file, 'utf8').split('\n').slice(0, 30).join('\n');
    if (TS_CHECK.test(head)) {
        checked++;
        const level = LEVEL.exec(head)?.[1];
        if (level) noImplicitAny++;
        if (level === 'strict') strict++;
    } else {
        const folder = path.relative(dir, path.dirname(file)).split(path.sep)[0] || '.';
        unchecked.set(folder, (unchecked.get(folder) || 0) + 1);
    }
}

if (list) {
    for (const [folder, n] of [...unchecked].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(5)}  ${folder}/`);
    console.log('');
}

const budgetFile = path.join(dir, '.checkjs-ratchet.json');
const existing = fs.existsSync(budgetFile) ? JSON.parse(fs.readFileSync(budgetFile, 'utf8')) : null;
const share = files.length ? ((checked / files.length) * 100).toFixed(1) : '0.0';
const measured = { checkedFiles: checked, noImplicitAnyFiles: noImplicitAny, strictFiles: strict };
const floorOf = (key) => existing?.[key] ?? 0;

if (update || !existing) {
    const next = {
        _comment: `Lowest number of ${pkg} source files that must carry // @typecheck (any level), // @typecheck noImplicitAny (that level or strict) and // @typecheck strict. Raise them with \`node scripts/checkjs-ratchet.mjs ${pkg} --update\` after moving more files up; lowering one is a deliberate edit that belongs in a commit message with a reason.`,
        _generated: new Date().toISOString().slice(0, 10),
        checkedFiles: Math.max(checked, floorOf('checkedFiles')),
        noImplicitAnyFiles: Math.max(noImplicitAny, floorOf('noImplicitAnyFiles')),
        strictFiles: Math.max(strict, floorOf('strictFiles')),
    };
    fs.writeFileSync(budgetFile, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`Floors written to ${path.relative(ROOT, budgetFile)}: ${next.checkedFiles} checked, ${next.noImplicitAnyFiles} noImplicitAny, ${next.strictFiles} strict (measured ${checked} of ${files.length}, ${share}%)`);
    process.exit(0);
}

let failed = false;
if (checked < existing.checkedFiles) {
    console.error(`❌ ${pkg}: ${checked} files carry // @typecheck, the floor is ${existing.checkedFiles} — fix the type error rather than removing the check`);
    failed = true;
}
if (noImplicitAny < floorOf('noImplicitAnyFiles')) {
    console.error(`❌ ${pkg}: ${noImplicitAny} files carry // @typecheck noImplicitAny (or strict), the floor is ${floorOf('noImplicitAnyFiles')} — fix the type error rather than lowering the level`);
    failed = true;
}
if (strict < floorOf('strictFiles')) {
    console.error(`❌ ${pkg}: ${strict} files carry // @typecheck strict, the floor is ${floorOf('strictFiles')} — fix the type error rather than lowering the level`);
    failed = true;
}
if (failed) process.exit(1);
const over = Object.keys(measured).some((k) => measured[k] > floorOf(k));
const line = `${checked} of ${files.length} files checked (${share}%), ${noImplicitAny} at noImplicitAny, ${strict} strict`;
if (over) {
    console.log(`✅ ${pkg}: ${line}, over the floors. Run \`node scripts/checkjs-ratchet.mjs ${pkg} --update\` to raise them.`);
} else {
    console.log(`➖ ${pkg}: ${line}, at the floors`);
}
