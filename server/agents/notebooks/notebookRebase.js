// @typecheck
/**
 * Carry an edit made against an older copy of a notebook onto its current,
 * co-edited state, block by block.
 *
 * A server-side writer (the notebook chat's AI, the chat workspace tools)
 * turns the text it READ (`base`) into the text it wants (`next`). While it
 * worked, colleagues may have typed into the live document (`current`).
 * Writing `next` as the whole document would silently take their typing out
 * of every editor, so only the change base → next is carried over (diff3):
 *
 *   - the blocks are the document's top-level nodes (paragraph, heading,
 *     list, table, …), compared by their Markdown: the dialect these writers
 *     read and write, so a block the writer left alone matches even though
 *     its HTML went through another serializer on the way;
 *   - a block only the writer changed (or removed, or added) takes the
 *     writer's version, a block only others changed keeps theirs, a change
 *     both made identically is made once, and changes to the SAME blocks
 *     that differ are a CONFLICT: nothing is merged, and the caller keeps the
 *     writer's text as a proposal instead. Edits to neighbouring blocks both
 *     apply (a colleague typing in the next paragraph is not a conflict).
 *
 * Every block the writer did not change is the CURRENT live node, untouched,
 * so what Markdown does not carry (an alignment, a colour) survives too.
 * Nothing here logs content.
 */

'use strict';

const md = require('../../core/markdown');

// Past this many differing blocks between two copies the alignment is not
// computed (the table grows with the square): only a document nobody else
// changed takes the edit then.
const MAX_ALIGN = 2000;

/**
 * @typedef {{ type: string, content?: any[], attrs?: Record<string, any> }} AstNode
 * @typedef {{ key: string, node: AstNode }} Block
 * @typedef {{ b0: number, b1: number, s0: number, s1: number }} Hunk
 * @typedef {{ html?: string|null, markdown?: string|null }} Content
 */

/** @param {Content} input @returns {AstNode} */
function toAst(input) {
    if (typeof input.html === 'string' && input.html.trim()) {
        return md.looksLikeHtml(input.html) ? md.htmlToAst(input.html) : md.markdownToAst(input.html);
    }
    return md.markdownToAst(typeof input.markdown === 'string' ? input.markdown : '');
}

/** @param {AstNode} node */
const keyOf = (node) => md.astToMarkdown({ type: 'doc', content: [node] }).replace(/\s+/g, ' ').trim();

/** @param {AstNode} ast @returns {Block[]} */
const blocksOf = (ast) => (Array.isArray(ast.content) ? ast.content : []).map((node) => ({ key: keyOf(node), node }));

/** @param {Block[]} x @param {Block[]} y */
const sameKeys = (x, y) => x.length === y.length && x.every((b, i) => b.key === y[i].key);

/**
 * Longest common subsequence of the keys, as a map from an `a` index to the
 * `b` index it lines up with (-1 when none). The common head and tail are
 * matched directly; null when the rest is too long to align.
 *
 * @param {Block[]} a @param {Block[]} b
 * @returns {Int32Array|null}
 */
function align(a, b) {
    const map = new Int32Array(a.length).fill(-1);
    let head = 0;
    while (head < a.length && head < b.length && a[head].key === b[head].key) { map[head] = head; head++; }
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail].key === b[b.length - 1 - tail].key) {
        map[a.length - 1 - tail] = b.length - 1 - tail;
        tail++;
    }
    const n = a.length - head - tail;
    const m = b.length - head - tail;
    if (n === 0 || m === 0) return map;
    if (n > MAX_ALIGN || m > MAX_ALIGN) return null;
    const dp = new Uint16Array((n + 1) * (m + 1));
    const at = (/** @type {number} */ i, /** @type {number} */ j) => i * (m + 1) + j;
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[at(i, j)] = a[head + i].key === b[head + j].key
                ? dp[at(i + 1, j + 1)] + 1
                : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
        }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[head + i].key === b[head + j].key) { map[head + i] = head + j; i++; j++; }
        else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) i++;
        else j++;
    }
    return map;
}

/**
 * The changes one side made to `base`, from an alignment: each hunk replaces
 * base[b0, b1) by side[s0, s1) (an insertion when b0 === b1).
 *
 * @param {Int32Array} map @param {number} n @param {number} m
 * @returns {Hunk[]}
 */
function hunksOf(map, n, m) {
    /** @type {Hunk[]} */
    const out = [];
    let pb = 0;
    let ps = 0;
    for (let a = 0; a < n; a++) {
        const s = map[a];
        if (s < 0) continue;
        if (a > pb || s > ps) out.push({ b0: pb, b1: a, s0: ps, s1: s });
        pb = a + 1;
        ps = s + 1;
    }
    if (n > pb || m > ps) out.push({ b0: pb, b1: n, s0: ps, s1: m });
    return out;
}

/** Do two changes touch the same base blocks (an insertion inside the other's range counts)? @param {Hunk} x @param {Hunk} y */
function overlaps(x, y) {
    const xIns = x.b0 === x.b1;
    const yIns = y.b0 === y.b1;
    if (xIns && yIns) return false;
    if (xIns) return y.b0 < x.b0 && x.b0 < y.b1;
    if (yIns) return x.b0 < y.b0 && y.b0 < x.b1;
    return Math.max(x.b0, y.b0) < Math.min(x.b1, y.b1);
}

/**
 * diff3 over blocks: the merged blocks, or null on a conflict. Changes that
 * only border each other both apply; at one spot, the others' insertion
 * comes before the writer's.
 *
 * @param {Block[]} base @param {Block[]} next @param {Block[]} cur
 * @returns {Block[]|null}
 */
function merge3(base, next, cur) {
    const bn = align(base, next);
    const bc = align(base, cur);
    if (!bn || !bc) {
        if (sameKeys(base, cur)) return next;
        return sameKeys(base, next) ? cur : null;
    }
    const theirs = hunksOf(bc, base.length, cur.length);
    /** @param {Hunk} l @param {Hunk} r */
    const sameChange = (l, r) => l.b0 === r.b0 && l.b1 === r.b1 && sameKeys(next.slice(l.s0, l.s1), cur.slice(r.s0, r.s1));
    /** @type {Hunk[]} */
    const mine = [];
    for (const l of hunksOf(bn, base.length, next.length)) {
        if (theirs.some((r) => sameChange(l, r))) continue;          // made on both sides already
        if (theirs.some((r) => overlaps(l, r))) return null;
        mine.push(l);
    }
    /** @type {Block[]} */
    const out = [];
    const inserted = (/** @type {Hunk[]} */ list, /** @type {Block[]} */ side, /** @type {number} */ at) => {
        for (const h of list) if (h.b0 === at && h.b1 === at) out.push(...side.slice(h.s0, h.s1));
    };
    const startingAt = (/** @type {Hunk[]} */ list, /** @type {number} */ at) => list.find((h) => h.b0 === at && h.b1 > at);
    let i = 0;
    for (;;) {
        inserted(theirs, cur, i);
        inserted(mine, next, i);
        if (i >= base.length) break;
        const r = startingAt(theirs, i);
        const l = r ? null : startingAt(mine, i);
        if (r) { out.push(...cur.slice(r.s0, r.s1)); i = r.b1; }
        else if (l) { out.push(...next.slice(l.s0, l.s1)); i = l.b1; }
        else { out.push(cur[bc[i]]); i++; }
    }
    return out;
}

/**
 * The current document with the change base → next applied to it.
 *
 * @param {Content} base      what the writer read
 * @param {Content} next      what the writer wants now
 * @param {string} currentHtml the live document now
 * @returns {{ conflict: boolean, changed: boolean, html: string|null }} `conflict`:
 *   the change collides with someone else's (no `html`); otherwise `html` is
 *   the document to write, and `changed` says whether it differs from now
 */
function rebaseEdit(base, next, currentHtml) {
    const curAst = toAst({ html: currentHtml });
    const cur = blocksOf(curAst);
    const merged = merge3(blocksOf(toAst(base)), blocksOf(toAst(next)), cur);
    if (!merged) return { conflict: true, changed: false, html: null };
    const changed = merged.length !== cur.length || merged.some((b, i) => b !== cur[i]);
    if (!changed) return { conflict: false, changed: false, html: currentHtml };
    return { conflict: false, changed: true, html: md.astToHtml({ ...curAst, type: 'doc', content: merged.map((b) => b.node) }) };
}

module.exports = { rebaseEdit, _test: { merge3, align, blocksOf, hunksOf } };
