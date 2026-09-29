#!/usr/bin/env node
/**
 * Bundle-size budget for a Vite build — what a browser downloads, gzipped.
 *
 * Reads every .js and .css file under <package>/dist/assets after `vite build`
 * and compares two numbers with <package>/.bundle-budget.json:
 *
 *   totalGzip    the whole build, gzipped: what a cold cache costs
 *   largestGzip  the biggest single chunk: what blocks first paint when that
 *                chunk is on the critical path
 *
 * Unlike the count ratchets this is a BUDGET, not a floor that only moves one
 * way: features legitimately add code. `--update` writes the measurement plus
 * 5% headroom, so ordinary work fits and a PR that doubles a dependency does
 * not. Raising the budget beyond that is a deliberate edit with a reason in the
 * commit message — which is the point: the growth becomes a decision.
 *
 * Usage:
 *   node scripts/bundle-ratchet.mjs <package>            gate (build first)
 *   node scripts/bundle-ratchet.mjs <package> --update   rewrite the budget from this build
 *   node scripts/bundle-ratchet.mjs <package> --list     the ten largest chunks
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEADROOM = 1.05;

const args = process.argv.slice(2);
const pkg = args.find((a) => !a.startsWith('--'));
const update = args.includes('--update');
const list = args.includes('--list');
if (!pkg) {
    console.error('bundle-ratchet: usage: node scripts/bundle-ratchet.mjs <package> [--update] [--list]');
    process.exit(2);
}
const dir = path.resolve(ROOT, pkg);
const assets = path.join(dir, 'dist', 'assets');
if (!fs.existsSync(assets)) {
    console.error(`bundle-ratchet: ${path.relative(ROOT, assets)} not found — run the build first. A build that did not happen is not a pass.`);
    process.exit(2);
}

function collect(from, into) {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const full = path.join(from, entry.name);
        if (entry.isDirectory()) collect(full, into);
        else if (/\.(m?js|css)$/.test(entry.name)) into.push(full);
    }
    return into;
}

const chunks = collect(assets, []).map((file) => ({
    file: path.relative(assets, file).split(path.sep).join('/'),
    gzip: zlib.gzipSync(fs.readFileSync(file), { level: 9 }).length,
}));
if (chunks.length === 0) {
    console.error(`bundle-ratchet: no .js or .css under ${path.relative(ROOT, assets)}`);
    process.exit(2);
}
const totalGzip = chunks.reduce((n, c) => n + c.gzip, 0);
const largest = chunks.reduce((a, b) => (b.gzip > a.gzip ? b : a));
const kb = (n) => `${(n / 1024).toFixed(1)} kB`;

if (list) {
    for (const c of [...chunks].sort((a, b) => b.gzip - a.gzip).slice(0, 10)) console.log(`${kb(c.gzip).padStart(10)}  ${c.file}`);
    console.log('');
}

const budgetFile = path.join(dir, '.bundle-budget.json');
const existing = fs.existsSync(budgetFile) ? JSON.parse(fs.readFileSync(budgetFile, 'utf8')) : null;

if (update || !existing) {
    const next = {
        _comment: `Gzipped size budget for ${pkg}/dist/assets (bytes): the measurement plus 5%. Rewrite it with \`node scripts/bundle-ratchet.mjs ${pkg} --update\` after a build; a raise belongs in a commit message with a reason.`,
        _generated: new Date().toISOString().slice(0, 10),
        totalGzip: Math.round(totalGzip * HEADROOM),
        largestGzip: Math.round(largest.gzip * HEADROOM),
    };
    fs.writeFileSync(budgetFile, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`Budget written to ${path.relative(ROOT, budgetFile)}: total ${kb(next.totalGzip)}, largest chunk ${kb(next.largestGzip)} (measured ${kb(totalGzip)} / ${kb(largest.gzip)} in ${largest.file})`);
    process.exit(0);
}

const over = [];
if (totalGzip > existing.totalGzip) over.push(`total ${kb(totalGzip)} is over the budget of ${kb(existing.totalGzip)}`);
if (largest.gzip > existing.largestGzip) over.push(`largest chunk ${largest.file} at ${kb(largest.gzip)} is over the budget of ${kb(existing.largestGzip)}`);
if (over.length) {
    console.error(`❌ ${pkg}: ${over.join('; ')} — lazy-load the new code or drop a dependency (\`--list\` shows the largest chunks)`);
    process.exit(1);
}
console.log(`✅ ${pkg}: total ${kb(totalGzip)} of ${kb(existing.totalGzip)}, largest chunk ${kb(largest.gzip)} of ${kb(existing.largestGzip)}`);
