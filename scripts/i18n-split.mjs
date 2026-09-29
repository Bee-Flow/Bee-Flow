#!/usr/bin/env node
/**
 * i18n-split — split the monolithic English dictionary into one file per
 * namespace.
 *
 *   node scripts/i18n-split.mjs
 *
 * Input:  server/i18n/defaults/en.js, when it still holds the literal
 *         `const GUI_DEFAULTS = { … }` (the layout before 2026-09-24).
 * Output: server/i18n/defaults/en/<namespace>.js — `module.exports = { … }`
 *         with that namespace's entries, copied VERBATIM from the source text
 *         (each property together with the comments and blank lines in front
 *         of it, so section headers and notes survive the move);
 *         server/i18n/defaults/en/index.js — requires every namespace file and
 *         merges them into GUI_DEFAULTS;
 *         server/i18n/defaults/en.js — rewritten as a one-line re-export, so
 *         every `require('…/i18n/defaults/en')` keeps working.
 *
 * A namespace is the part of a key before the first `.` (`learn.x.y` → learn;
 * a key without a dot is its own namespace).
 *
 * Property boundaries come from a real parser (acorn, resolved from
 * server/node_modules — run `npm ci` in server/ first), never from a regex:
 * values contain quotes, `//`, and `{`.
 *
 * Which comment belongs to which key: everything between two properties goes
 * with the one BELOW it (a section header introduces what follows), except a
 * comment run that sits directly under a property and is followed by a blank
 * line — that closes the block above it (`// ── end … block ──`,
 * `// </learning-generated>`) and stays with the property above.
 *
 * IDEMPOTENT, and that is what makes it a merge tool too. When en.js is
 * already the re-export there is nothing to split and the script only
 * refreshes index.js from the files present. When en/<namespace>.js files
 * already exist and en.js is a monolith again, the two are MERGED:
 *   - a key only in the namespace files is kept (it landed after the split);
 *   - a key only in the monolith is appended to its namespace file;
 *   - a key in both keeps the namespace file's text, and when the English
 *     differs the script prints both, so you can pick one by hand.
 *
 * So a branch that still carries the old monolithic en.js resolves its merge
 * with main like this: on the en.js conflict, KEEP YOUR OWN en.js (the
 * monolith with your new keys), take main's en/ directory as is, and run
 *
 *     node scripts/i18n-split.mjs && node scripts/gen-i18n-defaults.mjs
 *
 * Your keys land in their namespace files, main's keys stay, en.js becomes the
 * re-export again and the frontend copy is regenerated. Then
 * `node scripts/i18n-key-guard.mjs --base origin/main` confirms nothing of
 * main's went missing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULTS = path.join(ROOT, 'server', 'i18n', 'defaults');
const MONOLITH = path.join(DEFAULTS, 'en.js');
const OUT_DIR = path.join(DEFAULTS, 'en');
const REL_OUT = 'server/i18n/defaults/en';

function loadAcorn() {
    try {
        return createRequire(path.join(ROOT, 'server', 'package.json'))('acorn');
    } catch {
        console.error('i18n-split: acorn is not installed. Run `npm ci` in server/ first.');
        process.exit(2);
    }
}

const NS_RX = /^[A-Za-z0-9_-]+$/;
const namespaceOf = (key) => key.split('.')[0];

/** Index just past the newline that ends the line containing `pos`. */
function lineEnd(src, pos) {
    const nl = src.indexOf('\n', pos);
    return nl === -1 ? src.length : nl + 1;
}

/** Index of the first character of the line containing `pos`. */
function lineStart(src, pos) {
    return src.lastIndexOf('\n', pos - 1) + 1;
}

function propKey(p, file) {
    if (p.type !== 'Property' || p.computed || p.method || p.shorthand || p.kind !== 'init') {
        throw new Error(`${file}: only plain 'key': value properties are allowed (offset ${p.start})`);
    }
    if (p.key.type === 'Literal' && typeof p.key.value === 'string') return p.key.value;
    if (p.key.type === 'Identifier') return p.key.name;
    throw new Error(`${file}: unsupported key at offset ${p.start}`);
}

/** The value's identity for "does the English differ": the string, else its source. */
function propValue(src, p) {
    return p.value.type === 'Literal' ? p.value.value : src.slice(p.value.start, p.value.end);
}

/**
 * Cut an object literal into per-property chunks of source text. Every chunk
 * starts at the beginning of a line and ends with a newline.
 */
function chunksOf(src, obj, file) {
    const props = obj.properties;
    const openEnd = lineEnd(src, obj.start);
    if (src.slice(obj.start + 1, openEnd).trim() !== '') throw new Error(`${file}: expected a newline after the opening {`);
    const closeLine = lineStart(src, obj.end - 1);
    if (src.slice(closeLine, obj.end - 1).trim() !== '') throw new Error(`${file}: expected the closing } on a line of its own`);
    const out = [];
    const seen = new Map();
    let start = openEnd;
    for (let i = 0; i < props.length; i++) {
        const p = props[i];
        const key = propKey(p, file);
        if (seen.has(key)) throw new Error(`${file}: key ${key} is defined twice — keep one and run again`);
        seen.set(key, true);
        const end = lineEnd(src, p.end);
        const next = props[i + 1];
        if (next && next.start < end) throw new Error(`${file}: ${key} shares its line with the next key`);
        const pStart = lineStart(src, p.start);
        if (src.slice(pStart, p.start).trim() !== '') throw new Error(`${file}: ${key} does not start on its own line`);
        // A comment run directly under the previous property, closed by a
        // blank line, belongs to that property (see the header).
        if (out.length) {
            const gap = src.slice(start, pStart).split('\n');
            let n = 0;
            while (n < gap.length - 1 && gap[n].trim().startsWith('//')) n++;
            if (n > 0 && n < gap.length - 1 && gap[n].trim() === '') {
                const moved = gap.slice(0, n).join('\n') + '\n';
                out[out.length - 1].text += moved;
                start += moved.length;
            }
        }
        out.push({ key, ns: namespaceOf(key), value: propValue(src, p), text: src.slice(start, end) });
        start = end;
    }
    const tail = src.slice(start, closeLine);
    return { chunks: out, tail: tail.trim() === '' ? '' : tail };
}

function parse(acorn, src, file) {
    try {
        return acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script' });
    } catch (e) {
        throw new Error(`${file}: ${e.message}`);
    }
}

/** The GUI_DEFAULTS object literal of a monolithic en.js, or null. */
function monolithObject(ast) {
    for (const s of ast.body) {
        if (s.type !== 'VariableDeclaration') continue;
        for (const d of s.declarations) {
            if (d.id.type === 'Identifier' && d.id.name === 'GUI_DEFAULTS' && d.init?.type === 'ObjectExpression') return d.init;
        }
    }
    return null;
}

/** The `module.exports = { … }` object literal of a namespace file. */
function namespaceObject(ast, file) {
    for (const s of ast.body) {
        const e = s.type === 'ExpressionStatement' ? s.expression : null;
        if (e?.type === 'AssignmentExpression' && e.right.type === 'ObjectExpression'
            && e.left.type === 'MemberExpression' && e.left.object.name === 'module' && e.left.property.name === 'exports') {
            return e.right;
        }
    }
    throw new Error(`${file}: no \`module.exports = { … }\` found`);
}

export function namespaceHeader(ns) {
    return [
        `// English GUI defaults — namespace "${ns}": every key whose part before the first "." is "${ns}".`,
        '// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)',
        '// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.',
        '',
    ].join('\n');
}

function renderNamespace(ns, chunks, tail) {
    const body = chunks.map((c) => c.text).join('').replace(/^(?:[ \t]*\n)+/, '');
    return `${namespaceHeader(ns)}module.exports = {\n${body}${tail}};\n`;
}

export function renderIndex(namespaces) {
    const width = Math.max(...namespaces.map((ns) => JSON.stringify(ns).length));
    const lines = namespaces.map((ns) => `    ${`${JSON.stringify(ns)}:`.padEnd(width + 1)} require('./${ns}.js'),`);
    return `'use strict';
/**
 * English GUI String Defaults — the canonical catalogue of every translatable
 * frontend string, the fallback for any locale that does not override a key.
 *
 * One file per namespace (the part of a key before the first "."), so two
 * branches adding keys to different namespaces never touch the same file.
 * Every namespace file is listed below explicitly; a file in this directory
 * that is NOT listed, a key filed under the wrong namespace, and a key defined
 * twice all THROW at require time rather than silently vanish.
 *
 * Adding a namespace: create ./<namespace>.js (copy the header of any sibling)
 * and add it to NAMESPACES. After any change here, regenerate the frontend
 * copy: \`node scripts/gen-i18n-defaults.mjs\`.
 *
 * First written by scripts/i18n-split.mjs, which rewrites this file from the
 * namespace files present whenever it runs — so a hand edit is fine, as long
 * as it only adds or removes NAMESPACES entries.
 */

const fs = require('node:fs');

const NAMESPACES = {
${lines.join('\n')}
};

function build() {
    const merged = {};
    for (const [ns, entries] of Object.entries(NAMESPACES)) {
        for (const [key, value] of Object.entries(entries)) {
            const keyNs = key.split('.')[0];
            if (keyNs !== ns) {
                throw new Error(\`i18n: key "\${key}" is in en/\${ns}.js but its namespace is "\${keyNs}" — move it to en/\${keyNs}.js\`);
            }
            if (Object.prototype.hasOwnProperty.call(merged, key)) {
                throw new Error(\`i18n: key "\${key}" is defined more than once in server/i18n/defaults/en/\`);
            }
            merged[key] = value;
        }
    }
    const listed = new Set(Object.keys(NAMESPACES).map((ns) => \`\${ns}.js\`));
    const unlisted = fs.readdirSync(__dirname)
        .filter((f) => f.endsWith('.js') && f !== 'index.js' && !listed.has(f));
    if (unlisted.length) {
        throw new Error(\`i18n: \${unlisted.join(', ')} in server/i18n/defaults/en/ is not listed in NAMESPACES (index.js) — its keys would be lost\`);
    }
    return merged;
}

const GUI_DEFAULTS = build();

// Get all namespace categories for the GUI editor filter
function getGUINamespaces() {
    const namespaces = new Set();
    for (const key of Object.keys(GUI_DEFAULTS)) {
        const ns = key.split('.')[0];
        namespaces.add(ns);
    }
    return Array.from(namespaces).sort();
}

module.exports = {
    GUI_DEFAULTS,
    getGUINamespaces,
};
`;
}

export const REEXPORT = `/**
 * English GUI String Defaults — moved to ./en/, one file per namespace
 * (./en/<namespace>.js, merged by ./en/index.js). This file stays so every
 * \`require('…/i18n/defaults/en')\` keeps working. Do not add keys here.
 */
module.exports = require('./en/index.js');
`;

function main() {
    const acorn = loadAcorn();
    fs.mkdirSync(OUT_DIR, { recursive: true });

    // Existing namespace files (a previous split, or main's side of a merge).
    const existing = new Map();
    for (const f of fs.readdirSync(OUT_DIR).filter((n) => n.endsWith('.js') && n !== 'index.js').sort()) {
        const ns = f.slice(0, -3);
        const file = `${REL_OUT}/${f}`;
        const src = fs.readFileSync(path.join(OUT_DIR, f), 'utf8');
        const { chunks, tail } = chunksOf(src, namespaceObject(parse(acorn, src, file), file), file);
        for (const c of chunks) {
            if (c.ns !== ns) throw new Error(`${file}: key ${c.key} belongs in ${REL_OUT}/${c.ns}.js`);
        }
        existing.set(ns, { chunks, tail });
    }

    const monoSrc = fs.readFileSync(MONOLITH, 'utf8');
    const obj = monolithObject(parse(acorn, monoSrc, 'server/i18n/defaults/en.js'));
    const conflicts = [];
    let added = 0;
    let written = 0;
    if (obj) {
        const { chunks, tail } = chunksOf(monoSrc, obj, 'server/i18n/defaults/en.js');
        const byNs = new Map();
        for (const c of chunks) {
            if (!NS_RX.test(c.ns)) throw new Error(`key ${c.key}: namespace "${c.ns}" cannot be a file name`);
            if (!byNs.has(c.ns)) byNs.set(c.ns, []);
            byNs.get(c.ns).push(c);
        }
        if (tail && chunks.length) chunks[chunks.length - 1].text += tail;
        for (const [ns, list] of byNs) {
            const have = existing.get(ns) || { chunks: [], tail: '' };
            const index = new Map(have.chunks.map((c) => [c.key, c]));
            for (const c of list) {
                const kept = index.get(c.key);
                if (!kept) { have.chunks.push(c); added++; continue; }
                if (kept.value !== c.value) {
                    conflicts.push(`${c.key}\n    kept (${REL_OUT}/${ns}.js): ${JSON.stringify(kept.value)}\n    en.js (not taken):  ${JSON.stringify(c.value)}`);
                }
            }
            existing.set(ns, have);
        }
        for (const [ns, { chunks: list, tail: t }] of existing) {
            const target = path.join(OUT_DIR, `${ns}.js`);
            const text = renderNamespace(ns, list, t);
            if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== text) {
                fs.writeFileSync(target, text);
                written++;
            }
        }
        fs.writeFileSync(MONOLITH, REEXPORT);
    }

    const namespaces = [...existing.keys()].sort();
    if (!namespaces.length) throw new Error('no namespaces found — nothing to write');
    fs.writeFileSync(path.join(OUT_DIR, 'index.js'), renderIndex(namespaces));

    if (!obj) {
        console.log(`i18n-split: en.js is already the re-export — nothing to split. index.js lists ${namespaces.length} namespaces.`);
    } else {
        const keys = [...existing.values()].reduce((n, e) => n + e.chunks.length, 0);
        console.log(`i18n-split: ${keys} keys in ${namespaces.length} namespace files (${written} written, ${added} keys added from en.js); en.js is now the re-export.`);
    }
    if (conflicts.length) {
        console.log(`\n${conflicts.length} key(s) differ between en.js and the namespace files — the namespace file was kept. Edit by hand if en.js had the right English:\n  ${conflicts.join('\n  ')}`);
    }
    console.log('Next: node scripts/gen-i18n-defaults.mjs');
}

// Run as a command, not imported by a test (see entry-point.mjs).
if (isEntryPoint(import.meta.url)) {
    try {
        main();
    } catch (e) {
        console.error(`i18n-split: ${e.message}`);
        process.exit(1);
    }
}
