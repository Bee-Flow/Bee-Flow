#!/usr/bin/env node
/**
 * runtime-watch — is a runtime we ship behind on a security release, or past
 * its end of life?
 *
 * Lockfile scanners (npm audit, OSV-Scanner, Dependabot) read package trees.
 * None of them looks at the interpreter underneath: a Node.js security release
 * (the brotli decoder, 2026-10) or a Python/Redis/Postgres cycle that went EOL
 * is invisible to all three. This script is that missing half.
 *
 * DISCOVERY, NOT A LIST. Every tracked `.nvmrc`, `.node-version`,
 * `.python-version`, every `FROM` in a Dockerfile and every `image:` in a
 * compose file is read from `git ls-files`, so a new service or a new base
 * image is checked from the commit that adds it. An image whose product is not
 * in PRODUCTS is reported as unchecked, by name, never skipped in silence.
 *
 * Sources: nodejs.org/dist/index.json (its `security` flag marks the releases
 * that fix a vulnerability) and endoflife.date (cycle EOL and latest patch).
 *
 * Levels: `high` = a newer security release in the same line, or the cycle is
 * past EOL. `notice` = behind the latest patch, or not pinned to a version.
 * A feed that cannot be read is an `error`: a runtime that could not be
 * checked is never reported as fine.
 *
 *   node scripts/runtime-watch.mjs [--json out.json]
 *
 * Zero dependencies: node:* only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from './entry-point.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Image name (last path segment, or the full name where the segment is
// ambiguous) -> endoflife.date product. `node` is checked against nodejs.org
// as well, because only that feed says which release was a security release.
export const PRODUCTS = {
    node: 'nodejs',
    python: 'python',
    golang: 'go',
    nginx: 'nginx',
    redis: 'redis',
    postgres: 'postgresql',
    alpine: 'alpine-linux',
    // pgvector/pgvector:pg15 is Postgres 15 with an extension.
    'pgvector/pgvector': 'postgresql',
};

// Our own images and Dockerfile stage aliases are not runtimes to check.
const OWN_IMAGE = /^(ghcr\.io\/bee-flow\/|beeflow-|scratch$)/;

const VERSION_FILES = { '.nvmrc': 'node', '.node-version': 'node', '.python-version': 'python' };

/** `${A:-${B:-x}}` -> `x`: compose defaults, innermost wins. */
function expandDefaults(ref) {
    let prev;
    let out = ref;
    while (prev !== out) {
        prev = out;
        out = out.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:?-([^${}]*)\}/g, '$1');
    }
    return out;
}

/**
 * Split an image reference into the name we key PRODUCTS on and the tag.
 * Returns null for anything that is not a third-party image.
 */
export function parseImageRef(raw, stages = new Set()) {
    const ref = expandDefaults(raw.trim()).split('@')[0];
    if (!ref || ref.includes('$') || OWN_IMAGE.test(ref) || stages.has(ref)) return null;
    const slash = ref.lastIndexOf('/');
    const colon = ref.lastIndexOf(':');
    const name = colon > slash ? ref.slice(0, colon) : ref;
    const tag = colon > slash ? ref.slice(colon + 1) : 'latest';
    // docker.io/library/node, library/node and node are the same image.
    const key = name.replace(/^(docker\.io\/)?(library\/)?/, '');
    return { image: name, key, tag };
}

/** Leading version of a tag: `22.23.4-alpine` -> `22.23.4`, `pg15` -> `15`. */
export function versionOf(tag) {
    const m = /^(?:v|pg)?(\d+(?:\.\d+)*)/.exec(tag);
    return m ? m[1] : null;
}

/** Every runtime pin in the tracked tree, with the file and line it sits on. */
export function discover(root = ROOT, files = gitFiles(root)) {
    const pins = [];
    for (const file of files) {
        const base = path.basename(file);
        let text;
        try {
            text = fs.readFileSync(path.join(root, file), 'utf8');
        } catch {
            continue;
        }
        const lines = text.split('\n');
        if (VERSION_FILES[base]) {
            const v = lines[0].trim().replace(/^v/, '');
            pins.push({ file, line: 1, ref: `${VERSION_FILES[base]}@${v}`, key: VERSION_FILES[base], version: versionOf(v) });
        } else if (/(^|\.)Dockerfile$|^Dockerfile(\.|$)/.test(base)) {
            const stages = new Set();
            lines.forEach((l, i) => {
                const m = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(l);
                if (!m) return;
                const parsed = parseImageRef(m[1], stages);
                if (m[2]) stages.add(m[2]);
                if (parsed) pins.push({ file, line: i + 1, ref: m[1], key: parsed.key, image: parsed.image, version: versionOf(parsed.tag) });
            });
        } else if (/^(docker-)?compose[^/]*\.ya?ml$/.test(base)) {
            lines.forEach((l, i) => {
                const m = /^\s*image:\s*["']?([^"'\s#]+)/.exec(l);
                const parsed = m && parseImageRef(m[1]);
                if (parsed) pins.push({ file, line: i + 1, ref: m[1], key: parsed.key, image: parsed.image, version: versionOf(parsed.tag) });
            });
        }
    }
    return pins;
}

function gitFiles(root) {
    return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        .split('\0')
        .filter(Boolean);
}

/** Numeric compare of dotted versions; missing parts count as 0. */
export function cmpVersion(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) return d;
    }
    return 0;
}

function cycleFor(cycles, version) {
    const parts = version.split('.');
    // Longest match first: Python and Go cycles are major.minor, Node's major.
    for (let n = parts.length; n > 0; n--) {
        const c = cycles.find((x) => String(x.cycle) === parts.slice(0, n).join('.'));
        if (c) return c;
    }
    return null;
}

function isEol(cycle, today) {
    return cycle.eol === true || (typeof cycle.eol === 'string' && cycle.eol <= today);
}

/**
 * Judge one pin against the feeds. `feeds` is { nodeIndex, eol: { product: cycles } }
 * with a value of `undefined` for a feed that could not be read.
 */
export function judge(pin, feeds, today) {
    const product = PRODUCTS[pin.key];
    const where = { file: pin.file, line: pin.line, ref: pin.ref };
    if (!product) return [{ ...where, level: 'unchecked', id: `RUNTIME-${pin.key}`, message: `${pin.ref}: no version feed for this image` }];
    if (!pin.version) return [{ ...where, level: 'notice', id: `RUNTIME-${pin.key}-unpinned`, message: `${pin.ref}: no version in the tag, so its runtime cannot be checked (a digest pin still moves only by hand)` }];

    const out = [];
    const id = `RUNTIME-${pin.key}-${pin.version}`;
    const cycles = feeds.eol[product];
    if (!cycles) return [{ ...where, level: 'error', id, message: `${pin.ref}: the endoflife.date feed for ${product} could not be read` }];
    const cycle = cycleFor(cycles, pin.version);
    if (!cycle) {
        out.push({ ...where, level: 'notice', id, message: `${pin.ref}: ${product} ${pin.version} is not a cycle endoflife.date knows` });
    } else if (isEol(cycle, today)) {
        out.push({ ...where, level: 'high', id, message: `${pin.ref}: ${product} ${cycle.cycle} reached end of life${typeof cycle.eol === 'string' ? ` on ${cycle.eol}` : ''} and gets no security fixes` });
    }

    const full = pin.version.split('.').length >= 3;
    if (product === 'nodejs') {
        if (!feeds.nodeIndex) return [...out, { ...where, level: 'error', id, message: `${pin.ref}: nodejs.org/dist/index.json could not be read` }];
        const major = pin.version.split('.')[0];
        const fixes = feeds.nodeIndex
            .filter((r) => r.security && r.version.slice(1).split('.')[0] === major)
            .filter((r) => full && cmpVersion(r.version.slice(1), pin.version) > 0)
            .sort((a, b) => cmpVersion(b.version.slice(1), a.version.slice(1)));
        if (fixes.length) {
            out.push({ ...where, level: 'high', id, message: `${pin.ref}: Node.js ${fixes[0].version} (${fixes[0].date}) is a security release newer than ${pin.version}${fixes.length > 1 ? ` (${fixes.length} security releases behind)` : ''}` });
            return out;
        }
    }
    if (cycle && full && cycle.latest && cmpVersion(String(cycle.latest), pin.version) > 0 && !out.some((f) => f.level === 'high')) {
        out.push({ ...where, level: 'notice', id, message: `${pin.ref}: ${product} ${cycle.latest} is out (${cycle.latestReleaseDate || 'date unknown'})` });
    }
    return out;
}

async function getJson(url, fetchImpl) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const res = await fetchImpl(url, { signal: AbortSignal.timeout(20000), headers: { accept: 'application/json' } });
            if (res.ok) return await res.json();
        } catch {
            // retried once below, then reported as an unreadable feed
        }
    }
    return undefined;
}

export async function loadFeeds(pins, fetchImpl = fetch) {
    const products = [...new Set(pins.map((p) => PRODUCTS[p.key]).filter(Boolean))];
    const eol = {};
    await Promise.all(products.map(async (p) => {
        eol[p] = await getJson(`https://endoflife.date/api/${p}.json`, fetchImpl);
    }));
    const nodeIndex = products.includes('nodejs') ? await getJson('https://nodejs.org/dist/index.json', fetchImpl) : undefined;
    return { nodeIndex, eol };
}

export async function run({ root = ROOT, files, fetchImpl = fetch, today = new Date().toISOString().slice(0, 10) } = /** @type {any} */ ({})) {
    const pins = discover(root, files);
    const feeds = await loadFeeds(pins, fetchImpl);
    return { pins: pins.length, findings: pins.flatMap((p) => judge(p, feeds, today)) };
}

if (isEntryPoint(import.meta.url)) {
    const i = process.argv.indexOf('--json');
    const result = await run();
    if (i > 0) fs.writeFileSync(process.argv[i + 1], JSON.stringify(result, null, 2));
    console.log(`runtime-watch: ${result.pins} runtime pins`);
    for (const f of result.findings) console.log(`${f.level.padEnd(9)} ${f.file}:${f.line}  ${f.message}`);
}
