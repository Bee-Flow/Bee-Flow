// @typecheck
/**
 * Counting what changed between two document bodies, without reading them
 * twice and without a diff library.
 *
 * A version row carries `stats` ({ wordsAdded, wordsRemoved, blocksChanged }):
 * numbers for the history panel and the project's "what changed" feed, never
 * text. They are computed on every save, so the method has to be linear in the
 * size of the document: a word MULTISET difference (how many more of each word
 * there are now, how many fewer) instead of a sequence diff. It over-reports a
 * moved sentence as nothing changed, and that is the right error for a count
 * that only has to say "a small edit" or "a rewrite".
 *
 * `contentHash` is what lets a checkpoint of identical content be skipped: the
 * fields a person sees, never the resolved house style (which is derived and
 * would make every restyle of the organisation look like an edit).
 */

'use strict';

const crypto = require('crypto');

const BLOCK_END = /<\/(?:p|h[1-6]|li|tr|td|th|div|section|article|blockquote|pre|table|ul|ol|figure|header|footer)>|<br\s*\/?>/gi;
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/**
 * The readable text of a body: tags gone, blocks on their own line, the
 * common entities decoded.
 *
 * @param {unknown} html
 * @returns {string}
 */
function htmlToText(html) {
    return String(html ?? '')
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(BLOCK_END, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] || m)
        .replace(/[ \t\f\v]+/g, ' ')
        .replace(/\s*\n\s*/g, '\n')
        .trim();
}

/** @param {string} text */
function words(text) {
    return text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) || [];
}

/**
 * @param {string[]} items
 * @returns {Map<string, number>}
 */
function bag(items) {
    const m = new Map();
    for (const w of items) m.set(w, (m.get(w) || 0) + 1);
    return m;
}

/**
 * How many of `b`'s items are not in `a` (counting duplicates).
 *
 * @param {Map<string, number>} a
 * @param {Map<string, number>} b
 */
function surplus(a, b) {
    let n = 0;
    for (const [k, count] of b) n += Math.max(0, count - (a.get(k) || 0));
    return n;
}

/** @param {string} html */
function blocks(html) {
    return String(html ?? '')
        .split(BLOCK_END)
        .map((s) => htmlToText(s).replace(/\s+/g, ' ').trim())
        .filter(Boolean);
}

/**
 * @param {unknown} beforeHtml
 * @param {unknown} afterHtml
 * @returns {{ wordsAdded: number, wordsRemoved: number, blocksChanged: number }}
 */
function wordStats(beforeHtml, afterHtml) {
    const before = bag(words(htmlToText(beforeHtml)));
    const after = bag(words(htmlToText(afterHtml)));
    const blocksBefore = bag(blocks(String(beforeHtml ?? '')));
    const blocksAfter = bag(blocks(String(afterHtml ?? '')));
    return {
        wordsAdded: surplus(before, after),
        wordsRemoved: surplus(after, before),
        blocksChanged: Math.max(surplus(blocksBefore, blocksAfter), surplus(blocksAfter, blocksBefore)),
    };
}

/**
 * @param {unknown} html
 * @returns {number}
 */
function countWords(html) {
    return words(htmlToText(html)).length;
}

/**
 * A stable fingerprint of what a person sees in a document.
 *
 * @param {{ name?: string, docType?: string, description?: string, bodyHtml?: string, css?: string, settings?: object }} doc
 * @returns {string}
 */
function contentHash(doc) {
    const settings = { ...(doc?.settings || {}) };
    delete settings.resolvedHouseStyleCss;
    const keys = Object.keys(settings).sort();
    const stable = JSON.stringify([
        doc?.name || '', doc?.docType || '', doc?.description || '', doc?.bodyHtml || '', doc?.css || '',
        keys.map((k) => [k, settings[k]]),
    ]);
    return crypto.createHash('sha256').update(stable).digest('hex');
}

module.exports = { htmlToText, wordStats, countWords, contentHash };
