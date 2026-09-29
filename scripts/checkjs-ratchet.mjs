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
const TEST_FILE = /\.test\.[cm]?js$/;

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
        } else if (entry.isFile() && /\.[cm]?js$/.test(entry.name) && !TEST_FILE.test(entry.name)) {
            into.push(full);
        }
    }
    return into;
}

let checked = 0;
const unchecked = new Map();
const files = collect(dir, []);
for (const file of files) {
    const head = fs.readFileSync(file, 'utf8').split('\n').slice(0, 30).join('\n');
    if (TS_CHECK.test(head)) {
        checked++;
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

if (update || !existing) {
    const next = {
        _comment: `Lowest number of ${pkg} source files that must carry // @typecheck. Raise it with \`node scripts/checkjs-ratchet.mjs ${pkg} --update\` after opting more files in; lowering it is a deliberate edit that belongs in a commit message with a reason.`,
        _generated: new Date().toISOString().slice(0, 10),
        checkedFiles: existing ? Math.max(checked, existing.checkedFiles) : checked,
    };
    fs.writeFileSync(budgetFile, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`Floor written to ${path.relative(ROOT, budgetFile)}: ${next.checkedFiles} (measured ${checked} of ${files.length}, ${share}%)`);
    process.exit(0);
}

if (checked < existing.checkedFiles) {
    console.error(`❌ ${pkg}: ${checked} files carry // @typecheck, the floor is ${existing.checkedFiles} — fix the type error rather than removing the check`);
    process.exit(1);
}
if (checked > existing.checkedFiles) {
    console.log(`✅ ${pkg}: ${checked} of ${files.length} files checked (${share}%), over the floor of ${existing.checkedFiles}. Run \`node scripts/checkjs-ratchet.mjs ${pkg} --update\` to raise it.`);
} else {
    console.log(`➖ ${pkg}: ${checked} of ${files.length} files checked (${share}%), at the floor`);
}
