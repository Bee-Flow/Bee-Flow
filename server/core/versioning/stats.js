// @typecheck
/**
 * How much changed between two states of a notebook or document, as counts:
 *
 *   { wordsAdded, wordsRemoved, blocksChanged }
 *
 * The numbers the version history and the project's "what changed" feed show
 * next to an edit ("+120 words"). Counts only: nothing here keeps, logs or
 * returns a word of the content itself.
 *
 * The exact answer comes from the editor's own block-and-word diff, the same
 * `diffDocs` the browser uses for the compare view, bundled for the server as
 * core/markdown/editorCollab.cjs. When that bundle is not there (an older
 * build, a failed parse), a plain-text estimate answers instead: blocks are
 * lines of text, matched as wholes, and the words of the blocks that did not
 * match are compared as bags. Close enough for a badge, and it never throws.
 *
 * `contentHash` gives the fingerprint a version store compares to skip a
 * snapshot identical to the one before it.
 */

'use strict';

const crypto = require('crypto');

/** @typedef {{ wordsAdded: number, wordsRemoved: number, blocksChanged: number }} ChangeStats */
/** @typedef {string | { html?: string|null, markdown?: string|null } | null | undefined} Content */

/** Below this many words in total, and within one block, an edit is minor. */
const MINOR_WORDS = 5;
/** Past this many block pairs the estimate stops aligning and compares bags. */
const MAX_ALIGN_CELLS = 250_000;

const EMPTY = Object.freeze({ wordsAdded: 0, wordsRemoved: 0, blocksChanged: 0 });

// The generated bundle (server `npm run build:editor-collab`). Required by a
// variable path: a build without it must still load this module.
const BUNDLE_PATH = '../markdown/editorCollab.cjs';

let bundle; // undefined = not looked for yet, null = not available
function editorBundle() {
    if (bundle !== undefined) return bundle;
    try {
        const b = require(BUNDLE_PATH);
        bundle = b && typeof b.diffDocs === 'function' ? b : null;
    } catch {
        bundle = null;
    }
    return bundle;
}

let parser = null;
function domParser() {
    if (!parser) {
        const { JSDOM } = require('jsdom');
        parser = new JSDOM('').window.DOMParser;
    }
    return parser;
}

/** @param {Content} c @returns {{ html: string, markdown: string }} */
function partsOf(c) {
    if (typeof c === 'string') return /<\/?[a-z][\s\S]*>/i.test(c) ? { html: c, markdown: '' } : { html: '', markdown: c };
    if (!c || typeof c !== 'object') return { html: '', markdown: '' };
    return {
        html: typeof c.html === 'string' ? c.html : '',
        markdown: typeof c.markdown === 'string' ? c.markdown : '',
    };
}

/** @param {unknown} n */
const count = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Math.round(Number(n)) : 0);

/** @param {any} s @returns {ChangeStats} */
function cleanStats(s) {
    return {
        wordsAdded: count(s && s.wordsAdded),
        wordsRemoved: count(s && s.wordsRemoved),
        blocksChanged: count(s && s.blocksChanged),
    };
}

/** Exact counts through the editor's diff, or null when it cannot answer. */
function statsFromBundle(before, after) {
    const b = editorBundle();
    if (!b) return null;
    try {
        const toAst = (p) => {
            if (p.markdown && typeof b.markdownToAst === 'function') return b.markdownToAst(p.markdown);
            if (typeof b.htmlToAst === 'function') return b.htmlToAst(p.html || '', domParser());
            return null;
        };
        const a = toAst(before);
        const z = toAst(after);
        if (!a || !z) return null;
        const out = b.diffDocs(a, z);
        return out && out.stats ? cleanStats(out.stats) : null;
    } catch {
        return null;
    }
}

/** The text of one side as normalised lines (blocks). */
function blocksOf(p) {
    let text = '';
    if (p.markdown) {
        text = p.markdown;
    } else if (p.html) {
        try {
            text = require('../../utils/htmlSanitizer').htmlToPlainText(p.html);
        } catch {
            text = p.html.replace(/<[^>]*>/g, '\n');
        }
    }
    return text
        .split(/\n+/)
        .map((line) => line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
}

const wordsOf = (line) => line.split(' ').filter(Boolean);

/** Indexes of the blocks each side has that the other does not, by LCS when affordable. */
function unmatchedBlocks(a, b) {
    if (a.length * b.length > MAX_ALIGN_CELLS) {
        // Too large to align: compare as bags of whole lines.
        const bag = new Map();
        for (const line of a) bag.set(line, (bag.get(line) || 0) + 1);
        const onlyB = [];
        for (const line of b) {
            const n = bag.get(line) || 0;
            if (n > 0) bag.set(line, n - 1);
            else onlyB.push(line);
        }
        const onlyA = [];
        for (const [line, n] of bag) for (let i = 0; i < n; i += 1) onlyA.push(line);
        return { onlyA, onlyB };
    }
    const m = a.length;
    const n = b.length;
    const table = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i -= 1) {
        for (let j = n - 1; j >= 0; j -= 1) {
            table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
        }
    }
    const onlyA = [];
    const onlyB = [];
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
        if (a[i] === b[j]) { i += 1; j += 1; } else if (table[i + 1][j] >= table[i][j + 1]) { onlyA.push(a[i]); i += 1; } else { onlyB.push(b[j]); j += 1; }
    }
    while (i < m) onlyA.push(a[i++]);
    while (j < n) onlyB.push(b[j++]);
    return { onlyA, onlyB };
}

/** The plain-text estimate. */
function estimateStats(before, after) {
    const { onlyA, onlyB } = unmatchedBlocks(blocksOf(before), blocksOf(after));
    const bag = new Map();
    for (const w of onlyA.flatMap(wordsOf)) bag.set(w, (bag.get(w) || 0) + 1);
    let wordsAdded = 0;
    for (const w of onlyB.flatMap(wordsOf)) {
        const n = bag.get(w) || 0;
        if (n > 0) bag.set(w, n - 1);
        else wordsAdded += 1;
    }
    let wordsRemoved = 0;
    for (const n of bag.values()) wordsRemoved += n;
    return { wordsAdded, wordsRemoved, blocksChanged: Math.max(onlyA.length, onlyB.length) };
}

/**
 * Counts of what changed from `before` to `after`. Each side is an HTML
 * string, a Markdown string, or `{ html, markdown }` (Markdown is preferred:
 * it is what notebooks store as their source).
 *
 * @param {Content} before
 * @param {Content} after
 * @returns {ChangeStats}
 */
function versionStats(before, after) {
    const a = partsOf(before);
    const z = partsOf(after);
    if (!a.html && !a.markdown && !z.html && !z.markdown) return { ...EMPTY };
    return statsFromBundle(a, z) || estimateStats(a, z);
}

/**
 * Small enough to fold away in a feed: a handful of words inside one block.
 * @param {Partial<ChangeStats>|null|undefined} stats
 */
function isMinorChange(stats) {
    if (!stats) return false;
    const s = cleanStats(stats);
    return s.wordsAdded + s.wordsRemoved < MINOR_WORDS && s.blocksChanged <= 1;
}

/**
 * Add two sets of counts.
 * @param {Partial<ChangeStats>|null|undefined} a
 * @param {Partial<ChangeStats>|null|undefined} b
 * @returns {ChangeStats}
 */
function addStats(a, b) {
    const x = cleanStats(a || EMPTY);
    const y = cleanStats(b || EMPTY);
    return {
        wordsAdded: x.wordsAdded + y.wordsAdded,
        wordsRemoved: x.wordsRemoved + y.wordsRemoved,
        blocksChanged: x.blocksChanged + y.blocksChanged,
    };
}

/**
 * A stable fingerprint of a state, to skip a snapshot identical to the last.
 * Whitespace between tags and at line ends does not count as a change.
 * @param {Content} content
 */
function contentHash(content) {
    const p = partsOf(content);
    const norm = (s) => s.replace(/>\s+</g, '><').replace(/[ \t]+$/gm, '').trim();
    return crypto.createHash('sha256').update(`${norm(p.markdown)}\u0000${norm(p.html)}`).digest('hex');
}

/** Test hook: forget the bundle lookup, or pretend one is (not) there. */
function _setBundle(b) { bundle = b === undefined ? undefined : (b || null); }

module.exports = {
    versionStats,
    estimateStats,
    isMinorChange,
    addStats,
    cleanStats,
    contentHash,
    MINOR_WORDS,
    _setBundle,
};
