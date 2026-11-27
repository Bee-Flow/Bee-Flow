// @typecheck strict
'use strict';
/**
 * The first-party mount rows as the text of the use() calls they replay, for the static route
 * sweep (testUtils/routeSurfaceSweep.js), which reads index.js and routes/ai.js as TEXT.
 *
 * Those files do not spell out a module's mounts: they call the loader
 * (`firstParty.mount(app, gates, 'main')`, `firstParty.mountAi(router, gates)`,
 * modules/firstParty/loader.js), and the rows live in firstParty/<id>.mounts.js. expandMountCalls
 * replaces each such call in a host file's text with one `<receiver>.use(<path>, ...handlers);`
 * per row of that slot (aiMounts rows for mountAi), in the order of
 * modules/firstParty/order.json, with every `require('../x')` of the row rewritten to the host
 * file's directory. The sweep then reads a module's mount exactly as it read the app.use line
 * it came from: the same path, the same gate words, the same router reference.
 *
 * A row is read from its object literal: `key: '...'`, `slot: '...'` (none for an aiMounts
 * row), `path: '...'` or `path: null`, then `handlers: (g) => [ ... ]`, in that order (the
 * shape every part file uses). Every row of a slot is included, `when` or not: the sweep reads
 * every mount the text can make, as it read the env-switched app.use lines.
 */

const path = require('node:path');

/** @typedef {{ key: string, slot: string | null, path: string | null, elements: string, file: string, index: number }} TextRow */
/** @typedef {{ file: string, text: string }} PartFile  file: its tree path ('firstParty/<id>.mounts.js') */

const LOADER_SPEC = /(?:^|\/)modules\/firstParty\/loader(?:\.js)?$/;

/**
 * The closing index of the bracket that opens at `open`, strings skipped.
 * @param {string} src
 * @param {number} open
 */
function closingBracket(src, open) {
    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
        const c = src[i];
        if (c === '\'' || c === '"' || c === '`') {
            const q = c;
            i += 1;
            while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1;
        } else if (c === '(' || c === '[' || c === '{') depth += 1;
        else if (c === ')' || c === ']' || c === '}') {
            depth -= 1;
            if (depth === 0) return i;
        }
    }
    return src.length;
}

/**
 * The rows of one part file (its text with comments blanked).
 * @param {string} clean
 * @param {string} file the part file, relative to the server root
 * @returns {TextRow[]}
 */
function rowsOf(clean, file) {
    /** @type {TextRow[]} */
    const rows = [];
    for (const m of clean.matchAll(/handlers\s*:\s*\(\s*\w*\s*\)\s*=>\s*\[/g)) {
        const at = /** @type {number} */ (m.index);
        const start = clean.lastIndexOf('key:', at);
        if (start === -1) continue;
        const head = clean.slice(start, at);
        const key = /key\s*:\s*'([^']+)'/.exec(head);
        const pathLit = /path\s*:\s*('[^']*'|null)/.exec(head);
        if (!key || !pathLit) continue;
        const open = at + m[0].length - 1;
        rows.push({
            key: /** @type {string} */ (key[1]),
            slot: /slot\s*:\s*'(\w+)'/.exec(head)?.[1] ?? null,
            path: pathLit[1] === 'null' ? null : /** @type {string} */ (pathLit[1]),
            elements: clean.slice(open + 1, closingBracket(clean, open)).trim().replace(/,$/, ''),
            file,
            index: rows.length,
        });
    }
    return rows;
}

/**
 * The row's require() specifiers, made relative to the host file instead of the part file.
 * @param {string} elements
 * @param {string} partFile
 * @param {string} hostFile
 */
function rebase(elements, partFile, hostFile) {
    return elements.replace(/require\(\s*'(\.[^']+)'\s*\)/g, (_all, /** @type {string} */ spec) => {
        const target = path.posix.join(path.posix.dirname(partFile), spec);
        let rel = path.posix.relative(path.posix.dirname(hostFile), target);
        if (!rel.startsWith('.')) rel = `./${rel}`;
        return `require('${rel}')`;
    });
}

/**
 * Every row of every part file, sorted as the loader sorts them.
 * @param {PartFile[]} parts
 * @param {(src: string) => string} strip
 * @param {{ mounts: string[], aiMounts: string[] }} order
 * @param {boolean} ai
 */
function sortedRows(parts, strip, order, ai) {
    const listed = ai ? order.aiMounts : order.mounts;
    const rank = (/** @type {TextRow} */ r) => (listed.includes(r.key) ? listed.indexOf(r.key) : listed.length);
    const rows = parts.flatMap(({ file, text }) => rowsOf(strip(text), file));
    return rows.filter((r) => (r.slot === null) === ai)
        .sort((a, b) => rank(a) - rank(b) || a.file.localeCompare(b.file) || a.index - b.index);
}

/**
 * The mounts part files of every root of the tree, by name. Hidden roots too (core mode): the
 * sweep guards the repository's source, not the routes one edition mounts (testUtils/serverTree.js).
 * @returns {PartFile[]}
 */
function defaultMountParts() {
    const fs = require('node:fs');
    const { walkServerTree } = require('./serverTree');
    return walkServerTree({ under: 'firstParty', filter: (rel, e) => e.isDirectory() || rel.endsWith('.mounts.js') })
        .sort((a, b) => a.treePath.localeCompare(b.treePath))
        .map((f) => ({ file: f.treePath, text: fs.readFileSync(f.abs, 'utf8') }));
}

/**
 * The host file's text with every loader mount call replaced by the use() calls of its rows.
 * @template {string | null} S
 * @param {S} src the host file's text (null passes through)
 * @param {string} hostFile relative to the server root, e.g. 'index.js'
 * @param {{ strip: (src: string) => string, requiresOf: (clean: string) => Map<string, { spec: string, prop: string | null }>,
 *   parts?: () => PartFile[], order?: { mounts: string[], aiMounts: string[] } }} ctx
 *   parts: the mounts part files (default: those of every root of the tree, defaultMountParts)
 *   requiresOf: the local name -> require() binding map of a file's text (routeSurfaceSweep parseRequires)
 * @returns {S}
 */
function expandMountCalls(src, hostFile, ctx) {
    if (src === null) return src;
    const loaderNames = [...ctx.requiresOf(ctx.strip(src))].filter(([, b]) => !b.prop && LOADER_SPEC.test(b.spec)).map(([name]) => name);
    if (!loaderNames.length) return src;
    const callRx = new RegExp(`\\b(?:${loaderNames.join('|')})\\s*\\.\\s*(mount|mountAi)\\s*\\(\\s*(\\w+)\\s*,[^;]*?(?:,\\s*'(\\w+)'\\s*)?\\)\\s*;`, 'g');
    const order = ctx.order || require('../modules/firstParty/order.json');
    /** @type {PartFile[] | null} */
    let parts = null;
    return /** @type {S} */ (src.replace(callRx, (_all, /** @type {string} */ fn, /** @type {string} */ receiver, /** @type {string | undefined} */ slot) => {
        if (!parts) parts = (ctx.parts || defaultMountParts)();
        const ai = fn === 'mountAi';
        return sortedRows(parts, ctx.strip, order, ai)
            .filter((r) => ai || r.slot === slot)
            .map((r) => `${receiver}.use(${r.path === null ? '' : `${r.path}, `}${rebase(r.elements, r.file, hostFile)});`)
            .join('\n');
    }));
}

module.exports = { expandMountCalls, rowsOf, defaultMountParts };
