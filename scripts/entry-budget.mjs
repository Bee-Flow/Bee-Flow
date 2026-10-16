#!/usr/bin/env node
/**
 * Entry budget for a Vite build: what the public entry (dist/index.html) loads
 * before it can paint. Complements bundle-ratchet.mjs, which budgets the whole
 * build: a build can stay under its total while the CSS every marketing
 * pageview waits for grows (issue 245: 459 KB render-blocking, mostly Tailwind
 * utilities only the signed-in app needs).
 *
 * Reads <package>/dist/index.html and measures
 *
 *   blockingCss*  every <link rel="stylesheet"> (render-blocking), raw and gzipped
 *   entryJsGzip   the module script plus every modulepreload, gzipped
 *
 * against <package>/.entry-budget.json. The budget is the measurement plus 3%
 * (ordinary edits fit); `--update` creates it when missing and otherwise only ever LOWERS it, so a win is locked in
 * and a raise is a deliberate edit of the JSON with a reason in the commit.
 *
 * Usage:
 *   node scripts/entry-budget.mjs <package>            gate (build first)
 *   node scripts/entry-budget.mjs <package> --update   lower the budget to this build
 *   node scripts/entry-budget.mjs <package> --list     the files the entry loads
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEADROOM = 1.03;
const METRICS = ['blockingCssBytes', 'blockingCssGzip', 'entryJsGzip'];

const args = process.argv.slice(2);
const pkg = args.find((a) => !a.startsWith('--'));
const update = args.includes('--update');
const list = args.includes('--list');
if (!pkg) {
    console.error('entry-budget: usage: node scripts/entry-budget.mjs <package> [--update] [--list]');
    process.exit(2);
}
const dir = path.resolve(ROOT, pkg);
const indexHtml = path.join(dir, 'dist', 'index.html');
if (!fs.existsSync(indexHtml)) {
    console.error(`entry-budget: ${path.relative(ROOT, indexHtml)} not found: run the build first. A build that did not happen is not a pass.`);
    process.exit(2);
}

/** Attribute value of `name` in one tag's source, or null. */
function attr(tag, name) {
    const m = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
    return m ? m[1] : null;
}

/** Entry assets from index.html: { css: [href], js: [href] }, deduplicated, in document order. */
function entryAssets(html) {
    const css = new Set();
    const js = new Set();
    for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
        const rel = (attr(tag, 'rel') || '').toLowerCase();
        const href = attr(tag, 'href');
        if (!href) continue;
        if (rel === 'stylesheet' && !attr(tag, 'media')) css.add(href);
        else if (rel === 'modulepreload') js.add(href);
    }
    for (const [tag] of html.matchAll(/<script\b[^>]*>/gi)) {
        const src = attr(tag, 'src');
        if ((attr(tag, 'type') || '').toLowerCase() === 'module' && src) js.add(src);
    }
    return { css: [...css], js: [...js] };
}

function sizeOf(href) {
    const file = path.join(dir, 'dist', href.replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/^\/+/, '').split(/[?#]/)[0]);
    if (!fs.existsSync(file)) {
        console.error(`entry-budget: index.html references ${href} but ${path.relative(ROOT, file)} does not exist`);
        process.exit(2);
    }
    const buf = fs.readFileSync(file);
    return { href, bytes: buf.length, gzip: zlib.gzipSync(buf, { level: 9 }).length };
}

const assets = entryAssets(fs.readFileSync(indexHtml, 'utf8'));
const css = assets.css.map(sizeOf);
const js = assets.js.map(sizeOf);
const sum = (rows, key) => rows.reduce((n, r) => n + r[key], 0);
const measured = {
    blockingCssBytes: sum(css, 'bytes'),
    blockingCssGzip: sum(css, 'gzip'),
    entryJsGzip: sum(js, 'gzip'),
};
const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;

if (list) {
    for (const r of [...css, ...js]) console.log(`${kb(r.bytes).padStart(10)} ${kb(r.gzip).padStart(10)} gz  ${r.href}`);
    console.log('');
}
if (css.length === 0 && js.length === 0) {
    console.error('entry-budget: index.html loads no stylesheet and no script: not a Vite build output');
    process.exit(2);
}

const budgetFile = path.join(dir, '.entry-budget.json');
const existing = fs.existsSync(budgetFile) ? JSON.parse(fs.readFileSync(budgetFile, 'utf8')) : null;

if (!existing && !update) {
    console.error(`entry-budget: ${path.relative(ROOT, budgetFile)} not found: without a budget the gate would pass at any size. Create it deliberately with \`node scripts/entry-budget.mjs ${pkg} --update\`.`);
    process.exit(2);
}

if (update) {
    const next = { ...(existing || {}) };
    delete next._comment;
    for (const m of METRICS) {
        const target = Math.round(measured[m] * HEADROOM);
        next[m] = existing && Number.isFinite(existing[m]) ? Math.min(existing[m], target) : target;
    }
    const out = {
        _comment: `What the public entry (${pkg}/dist/index.html) loads before paint: render-blocking CSS (raw and gzipped bytes) and the module script plus modulepreloads (gzipped). Measurement plus 3%. \`node scripts/entry-budget.mjs ${pkg} --update\` only lowers it; a raise is a deliberate edit with a reason in the commit message.`,
        ...Object.fromEntries(METRICS.map((m) => [m, next[m]])),
    };
    fs.writeFileSync(budgetFile, `${JSON.stringify(out, null, 2)}\n`);
    console.log(`Entry budget written to ${path.relative(ROOT, budgetFile)}: ${METRICS.map((m) => `${m} ${kb(out[m])}`).join(', ')}`);
    process.exit(0);
}

/**
 * The order in which each stylesheet first mentions a cascade layer, whether in
 * an `@layer a, b;` statement or a `@layer a {` block (the minifier rewrites
 * the former into the latter): `utilities` must come last, `properties` first.
 */
function layerOrderProblems() {
    const assets = path.join(dir, 'dist', 'assets');
    const files = fs.existsSync(assets) ? fs.readdirSync(assets).filter((f) => f.endsWith('.css')) : [];
    const problems = [];
    for (const f of files) {
        const order = [];
        for (const m of fs.readFileSync(path.join(assets, f), 'utf8').matchAll(/@layer\s+([a-z][a-z, ]*)[;{]/g)) {
            for (const name of m[1].split(',').map((x) => x.trim())) if (name && !order.includes(name)) order.push(name);
        }
        if (!order.includes('utilities')) continue;
        if (order[order.length - 1] !== 'utilities') problems.push(`${f} declares layer order ${order.join(', ')}: utilities must come last`);
        if (order.includes('properties') && order[0] !== 'properties') problems.push(`${f} declares layer order ${order.join(', ')}: properties must come first`);
    }
    return problems;
}

const over = METRICS.filter((m) => measured[m] > existing[m]).map((m) => `${m} ${kb(measured[m])} is over the budget of ${kb(existing[m])}`);
over.push(...layerOrderProblems());
if (over.length) {
    console.error(`❌ ${pkg}: ${over.join('; ')}. Keep new CSS/JS out of the public entry (lazy-load it, or import it from the chunk that needs it); \`--list\` shows what the entry loads.`);
    process.exit(1);
}
console.log(`✅ ${pkg}: blocking CSS ${kb(measured.blockingCssBytes)} (${kb(measured.blockingCssGzip)} gz), entry JS ${kb(measured.entryJsGzip)} gz, all within budget`);
