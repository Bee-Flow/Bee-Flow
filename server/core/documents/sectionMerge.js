// @typecheck
/**
 * Three-way merge of a designed document's body, block by block.
 *
 * Two people save the same document: one of them saved from the revision the
 * other has since replaced. Instead of refusing the second save (the old dead
 * end: "This document changed"), the server merges it against the revision
 * both started from:
 *
 *   base    the body at the revision the late writer read (expectedVersionId)
 *   mine    the body the late writer sends now
 *   theirs  the body that is stored now
 *
 * THE UNIT IS A BLOCK. The body's top-level nodes are the blocks, and an
 * element carrying `data-doc-section` is a SECTION: a block whose identity is
 * its id, not its content, so a section two people both touched can still be
 * lined up, and merged again one level down (its own children as blocks). Any
 * other block is identified by its content: an edited paragraph is a removed
 * one plus an added one, which is what lets diff3 see which side changed it.
 *
 * The rule is diff3's: between anchors that neither side moved, a stretch only
 * one side changed takes that side; a stretch both changed identically takes
 * either; a stretch both changed differently is a CONFLICT. Adjacent edits
 * conflict, as they do in version control, rather than being guessed at.
 *
 * The answer is the merged body when nothing conflicts, and always the list of
 * parts (clean HTML and conflicts with all three sides) the editor's "compare
 * and choose" dialog needs: the person picks a side per conflict and the
 * parts, joined, are the body they save.
 *
 * Parsed with htmlparser2 in HTML mode and entity decoding off, so a block
 * serialises back byte for byte and template tokens inside tables
 * (`{{#each lines}}<tr>…`) stay where they are instead of being
 * foster-parented out of the table by a spec parser.
 */

'use strict';

const cheerio = require('cheerio');

// Past this many blocks the body is merged as one block: a document this long
// is not what a person types by hand, and the DP table grows with the square.
const MAX_BLOCKS = 1500;
const MAX_DEPTH = 3;
const LABEL_MAX = 80;

/**
 * @typedef {{ sig: string, content: string, html: string, sectionId: string|null, node: any }} Block
 * @typedef {{ kind: 'clean', html: string } | { kind: 'conflict', key: string, label: string, base: string, mine: string, theirs: string }} MergePart
 * @typedef {{ html: string|null, parts: MergePart[], conflicts: number, fromOthers: string[], othersOutsideSections: boolean }} MergeResult
 */

const normalise = (html) => String(html ?? '').replace(/\s+/g, ' ').trim();

/**
 * @param {string} html
 * @returns {{ lead: string, blocks: Block[], $: import('cheerio').CheerioAPI }}
 */
function parseBlocks(html) {
    const $ = cheerio.load(String(html ?? ''), { xml: { xmlMode: false, decodeEntities: false } }, false);
    /** @type {Block[]} */
    const blocks = [];
    let lead = '';
    const root = /** @type {any} */ ($.root()[0]);
    for (const node of root.children || []) {
        const raw = $.html(node);
        if (node.type === 'text' && !raw.trim()) {
            // Whitespace between blocks travels with the block before it, so the
            // merged body keeps the author's line breaks without them counting
            // as a change.
            if (blocks.length) blocks[blocks.length - 1].html += raw;
            else lead += raw;
            continue;
        }
        const sectionId = node.type === 'tag' && node.attribs ? (node.attribs['data-doc-section'] || null) : null;
        const content = normalise(raw);
        blocks.push({ sig: sectionId ? `section:${sectionId}` : `block:${content}`, content, html: raw, sectionId, node });
    }
    return { lead, blocks, $ };
}

/**
 * Longest common subsequence on signatures, as a map from `a` index to `b`
 * index (-1 when unmatched).
 *
 * @param {Block[]} a
 * @param {Block[]} b
 * @returns {Int32Array}
 */
function lcsMap(a, b) {
    const n = a.length;
    const m = b.length;
    const dp = new Uint16Array((n + 1) * (m + 1));
    const at = (i, j) => i * (m + 1) + j;
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[at(i, j)] = a[i].sig === b[j].sig
                ? dp[at(i + 1, j + 1)] + 1
                : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
        }
    }
    const map = new Int32Array(n).fill(-1);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i].sig === b[j].sig) { map[i] = j; i++; j++; }
        else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) i++;
        else j++;
    }
    return map;
}

/** @param {Block[]} list */
const joinHtml = (list) => list.map((b) => b.html).join('');
/** @param {Block[]} x @param {Block[]} y */
const sameSeq = (x, y) => x.length === y.length && x.every((b, i) => b.content === y[i].content);

/**
 * A short, human label for a conflict: the section's first heading, or the
 * start of its text.
 *
 * @param {Block[]} list
 * @param {import('cheerio').CheerioAPI} $
 */
function labelOf(list, $) {
    for (const b of list) {
        if (b.node?.type !== 'tag') continue;
        const heading = $(b.node).is('h1,h2,h3,h4,h5,h6') ? $(b.node) : $(b.node).find('h1,h2,h3,h4,h5,h6').first();
        const text = (heading.length ? heading.text() : $(b.node).text()).replace(/\s+/g, ' ').trim();
        if (text) return text.slice(0, LABEL_MAX);
    }
    const text = list.map((b) => $(b.node).text()).join(' ').replace(/\s+/g, ' ').trim();
    return text.slice(0, LABEL_MAX);
}

/** @param {any} node */
function openTag(node) {
    const attrs = Object.entries(node.attribs || {})
        .map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${String(v).replace(/"/g, '&quot;')}"`))
        .join('');
    return `<${node.name}${attrs}>`;
}

/** @param {any} node @param {import('cheerio').CheerioAPI} $ */
const innerHtml = (node, $) => $(node).html() || '';
/** @param {any} node */
const attrsOf = (node) => JSON.stringify(Object.entries(node.attribs || {}).sort(([a], [b]) => a.localeCompare(b)));

/**
 * @param {string} baseHtml
 * @param {string} mineHtml
 * @param {string} theirsHtml
 * @param {number} depth
 * @param {string} path
 * @param {string} [sectionLabel]  the enclosing section's heading, which names a conflict inside it
 * @returns {MergeResult}
 */
function mergeLevel(baseHtml, mineHtml, theirsHtml, depth, path, sectionLabel = '') {
    const base = parseBlocks(baseHtml);
    const mine = parseBlocks(mineHtml);
    const theirs = parseBlocks(theirsHtml);
    /** @type {MergePart[]} */
    const parts = [];
    /** @type {string[]} */
    const fromOthers = [];
    let othersOutsideSections = false;
    let conflicts = 0;
    let n = 0;
    const clean = (html) => { if (html) parts.push({ kind: 'clean', html }); };
    const conflict = (b, m, t) => {
        conflicts++;
        parts.push({
            kind: 'conflict', key: `${path}${n++}`, label: sectionLabel || labelOf(m.length ? m : t.length ? t : b, mine.$),
            base: joinHtml(b), mine: joinHtml(m), theirs: joinHtml(t),
        });
    };
    const tookTheirs = (list) => {
        for (const b of list) {
            if (b.sectionId) fromOthers.push(b.sectionId);
            else othersOutsideSections = true;
        }
    };

    clean(mine.lead);
    const tooLong = [base, mine, theirs].some((x) => x.blocks.length > MAX_BLOCKS);
    const bm = tooLong ? new Int32Array(0) : lcsMap(base.blocks, mine.blocks);
    const bt = tooLong ? new Int32Array(0) : lcsMap(base.blocks, theirs.blocks);

    /** A stretch between anchors. */
    const chunk = (b, m, t) => {
        if (!b.length && !m.length && !t.length) return;
        if (sameSeq(m, b)) { clean(joinHtml(t)); if (!sameSeq(t, b)) tookTheirs(t.length ? t : b); return; }
        if (sameSeq(t, b) || sameSeq(m, t)) { clean(joinHtml(m)); return; }
        conflict(b, m, t);
    };

    /** A block both sides kept in place; only a section can differ inside. */
    const anchor = (b, m, t) => {
        if (m.content === b.content) { clean(t.html); if (t.content !== b.content) tookTheirs([t]); return; }
        if (t.content === b.content || m.content === t.content) { clean(m.html); return; }
        const sameAttrs = attrsOf(m.node) === attrsOf(b.node) || attrsOf(t.node) === attrsOf(b.node) || attrsOf(m.node) === attrsOf(t.node);
        if (!m.sectionId || depth >= MAX_DEPTH || !sameAttrs || m.node.type !== 'tag') { conflict([b], [m], [t]); return; }
        const inner = mergeLevel(innerHtml(b.node, base.$), innerHtml(m.node, mine.$), innerHtml(t.node, theirs.$), depth + 1, `${path}${m.sectionId}/`, labelOf([m], mine.$));
        const shell = attrsOf(m.node) === attrsOf(b.node) ? t.node : m.node;
        const trailing = m.html.slice(mine.$.html(m.node).length);
        clean(openTag(shell));
        parts.push(...inner.parts);
        clean(`</${shell.name}>${trailing}`);
        conflicts += inner.conflicts;
        fromOthers.push(...inner.fromOthers);
        if (inner.fromOthers.length || inner.othersOutsideSections) fromOthers.push(m.sectionId);
    };

    let i = 0; let j = 0; let k = 0;
    for (let a = 0; a < bm.length; a++) {
        if (bm[a] < j || bt[a] < k || bm[a] === -1 || bt[a] === -1) continue;
        chunk(base.blocks.slice(i, a), mine.blocks.slice(j, bm[a]), theirs.blocks.slice(k, bt[a]));
        anchor(base.blocks[a], mine.blocks[bm[a]], theirs.blocks[bt[a]]);
        i = a + 1; j = bm[a] + 1; k = bt[a] + 1;
    }
    chunk(base.blocks.slice(i), mine.blocks.slice(j), theirs.blocks.slice(k));

    return {
        html: conflicts ? null : parts.map((p) => (p.kind === 'clean' ? p.html : '')).join(''),
        parts: coalesce(parts),
        conflicts,
        fromOthers: [...new Set(fromOthers)],
        othersOutsideSections,
    };
}

/**
 * Neighbouring clean parts as one, so the editor gets as few pieces as the
 * conflicts allow.
 *
 * @param {MergePart[]} parts
 * @returns {MergePart[]}
 */
function coalesce(parts) {
    /** @type {MergePart[]} */
    const out = [];
    for (const p of parts) {
        const last = out[out.length - 1];
        if (p.kind === 'clean' && last?.kind === 'clean') out[out.length - 1] = { kind: 'clean', html: last.html + p.html };
        else out.push(p);
    }
    return out;
}

/**
 * Merge `mine` into `theirs` against their common `base`.
 *
 * @param {string} base
 * @param {string} mine
 * @param {string} theirs
 * @returns {MergeResult}
 */
function mergeBodies(base, mine, theirs) {
    if (mine === theirs) return { html: mine, parts: [{ kind: 'clean', html: mine }], conflicts: 0, fromOthers: [], othersOutsideSections: false };
    if (mine === base) return { html: theirs, parts: [{ kind: 'clean', html: theirs }], conflicts: 0, fromOthers: [], othersOutsideSections: true };
    if (theirs === base) return { html: mine, parts: [{ kind: 'clean', html: mine }], conflicts: 0, fromOthers: [], othersOutsideSections: false };
    return mergeLevel(base, mine, theirs, 0, '');
}

/**
 * The body a person chose in "compare and choose": the parts joined, each
 * conflict replaced by the side picked for it ('mine' when not picked).
 *
 * @param {MergePart[]} parts
 * @param {Record<string, 'mine'|'theirs'>} choices
 */
function resolveParts(parts, choices = {}) {
    return parts.map((p) => (p.kind === 'clean' ? p.html : (choices[p.key] === 'theirs' ? p.theirs : p.mine))).join('');
}

module.exports = { mergeBodies, resolveParts, _test: { parseBlocks, lcsMap } };
