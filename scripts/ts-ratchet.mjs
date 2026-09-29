#!/usr/bin/env node
/**
 * TypeScript ratchet — a count that may only fall.
 *
 * Phase 3 converts the frontend to TypeScript directory by directory, which
 * takes months. A "no .js under src" gate would be red for all of them, and a
 * gate that is always red is switched off within a fortnight. So each package
 * commits the number of untyped source files it may still carry
 * (<package>/.ts-ratchet.json), CI fails when a change raises it, and
 * `--update` lowers it after a conversion. It never raises the count: a new
 * .js or .jsx file is the one thing this gate exists to refuse.
 *
 * Usage:
 *   node scripts/ts-ratchet.mjs <package>             gate (counts <package>/src)
 *   node scripts/ts-ratchet.mjs <package> --update    lower the budget
 *   node scripts/ts-ratchet.mjs <package> --list      print the files still counted
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const pkg = args.find((a) => !a.startsWith('--'));
if (!pkg) {
    console.error('ts-ratchet: usage: node scripts/ts-ratchet.mjs <package> [--update] [--list]');
    process.exit(2);
}
const update = args.includes('--update');
const list = args.includes('--list');

const dir = path.resolve(ROOT, pkg);
const srcDir = path.join(dir, 'src');
const budgetFile = path.join(dir, '.ts-ratchet.json');

// Anything a bundler would not compile from source: no .js hides in here today,
// but a vendored copy or a build artefact must not be able to inflate the count.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.vite']);

function collect(from, into) {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const full = path.join(from, entry.name);
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) collect(full, into);
        } else if (entry.isFile() && /\.jsx?$/.test(entry.name)) {
            into.push(path.relative(dir, full).split(path.sep).join('/'));
        }
    }
    return into;
}

if (!fs.existsSync(srcDir)) {
    console.error(`ts-ratchet: ${path.relative(ROOT, srcDir)} not found — is "${pkg}" a package directory?`);
    process.exit(2);
}

const files = collect(srcDir, []).sort();
const count = files.length;

if (list) {
    for (const f of files) console.log(f);
}

const existing = fs.existsSync(budgetFile) ? JSON.parse(fs.readFileSync(budgetFile, 'utf8')) : null;

if (update || !existing) {
    const next = {
        _comment: `Highest number of .js/.jsx files ${pkg}/src may still carry. Lower it with \`node scripts/ts-ratchet.mjs ${pkg} --update\` after a conversion; raising it is a deliberate edit that belongs in a commit message with a reason.`,
        _generated: new Date().toISOString().slice(0, 10),
        jsFiles: existing ? Math.min(count, existing.jsFiles) : count,
    };
    fs.writeFileSync(budgetFile, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`Budget written to ${path.relative(ROOT, budgetFile)}: ${next.jsFiles} .js/.jsx files (measured ${count})`);
    process.exit(0);
}

if (count > existing.jsFiles) {
    console.error(`❌ ${pkg}: ${count} .js/.jsx files under src, budget is ${existing.jsFiles} — write the ${count - existing.jsFiles} new one(s) in TypeScript rather than raising the budget`);
    process.exit(1);
}
if (count < existing.jsFiles) {
    console.log(`✅ ${pkg}: ${count} .js/.jsx files under src, under the budget of ${existing.jsFiles}. Run \`node scripts/ts-ratchet.mjs ${pkg} --update\` to lower it.`);
} else {
    console.log(`➖ ${pkg}: ${count} .js/.jsx files under src, at budget`);
}
