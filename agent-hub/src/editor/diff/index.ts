/**
 * editor/diff — what changed between two versions of a document.
 *
 *   1. Both documents are flattened into their blocks (flatten.ts): every
 *      textblock and block atom, including list items, quotes and table
 *      cells, with the containers they sit in.
 *   2. The block lists are lined up by a shortest-edit diff on exact block
 *      keys (sequence.ts): identical blocks are `equal`.
 *   3. Inside each changed stretch, blocks of the same kind that still share
 *      enough of their words are paired as `modify`; the rest are `insert` /
 *      `delete`.
 *   4. A modified textblock gets a word-level diff (words.ts); when its words
 *      are unchanged it is `formatOnly` (marks, heading level, list or task
 *      state changed).
 *   5. Runs of unchanged, added or removed blocks from one top-level block are
 *      returned as one block: that top-level block cut down to them, so they
 *      render in their list or table.
 *
 * The work is bounded: above `maxBlocks` blocks on either side only the
 * statistics are computed (`truncated: true`, no blocks). Pure: no DOM (the
 * HTML entry point takes the DOMParser like htmlToAst), bundled for the
 * server, which uses the statistics for version records.
 */
import { markdownToAst } from '../serialization/mdToAst.js';
import { htmlToAst } from '../serialization/htmlToAst.js';
import { canonicalAttrs, isBlockAtomType, isTextblockType, type AstNode } from '../collab/ySchema';
import { diffHunks } from './sequence';
import { flatten, shellOf, unitBag, unitTokens, type Unit } from './flatten';
import { bagSimilarity, countWords, diffWords, type DiffWord } from './words';

export type { DiffWord, WordOp } from './words';

export interface DiffBlock {
    op: 'equal' | 'insert' | 'delete' | 'modify';
    /** The block(s) as they were (absent for an insert). */
    before?: AstNode;
    /** The block(s) as they are now (absent for a delete). */
    after?: AstNode;
    /** Modified textblocks: the text, word by word. */
    words?: DiffWord[];
    /** Modified blocks whose words did not change: formatting, type, attributes or context did. */
    formatOnly?: boolean;
}

export interface DiffStats {
    wordsAdded: number;
    wordsRemoved: number;
    blocksChanged: number;
}

export interface DocDiff {
    blocks: DiffBlock[];
    stats: DiffStats;
    /** True when the documents were too large to compare block by block (blocks is empty). */
    truncated?: boolean;
}

export interface DiffOptions {
    /** Most blocks per side compared in detail (default 2000). */
    maxBlocks?: number;
}

export const DEFAULT_MAX_BLOCKS = 2000;
/** Edit budget of the block alignment (see diffHunks). */
const BLOCK_COST = 1000;
/** Largest changed stretch (before × after blocks) paired by best similarity. */
const MAX_PAIRING_CELLS = 40_000;
/** Least word overlap for two textblocks to count as one block, changed. */
const MIN_SIMILARITY = 0.4;
/** Blocks this short pair by position rather than by word overlap. */
const SHORT_WORDS = 3;
/** Presentation-only attributes of atoms: changing only these is a formatting change. */
const PRESENTATION = new Set(['width', 'alignment', 'textWrap', 'title']);

type Raw =
    | { op: 'equal'; a: Unit; b: Unit }
    | { op: 'insert'; b: Unit }
    | { op: 'delete'; a: Unit }
    | { op: 'modify'; a: Unit; b: Unit };

const EMPTY: AstNode = { type: 'doc', content: [] };
const asDoc = (d: AstNode | null | undefined): AstNode => (d && typeof d === 'object' && Array.isArray(d.content) ? d : EMPTY);

/** Compare two documents (editor ASTs). */
export function diffDocs(before: AstNode | null | undefined, after: AstNode | null | undefined, opts: DiffOptions = {}): DocDiff {
    const a = asDoc(before);
    const b = asDoc(after);
    const limit = Math.max(1, opts.maxBlocks ?? DEFAULT_MAX_BLOCKS);
    const ua = flatten(a, limit);
    const ub = flatten(b, limit);
    if (!ua || !ub) return statsOnly(flatten(a, Infinity) || [], flatten(b, Infinity) || []);
    const raws = align(ua, ub);
    return { blocks: emit(raws, a, b), stats: statsOf(raws) };
}

/** Compare two HTML bodies (as stored for notebooks and pages). */
export function diffHtml(beforeHtml: string, afterHtml: string, DOMParserImpl?: unknown, opts?: DiffOptions): DocDiff {
    return diffDocs(htmlToAst(beforeHtml || '', DOMParserImpl) as AstNode, htmlToAst(afterHtml || '', DOMParserImpl) as AstNode, opts);
}

/** Compare two Markdown sources. */
export function diffMarkdown(beforeMd: string, afterMd: string, opts?: DiffOptions): DocDiff {
    return diffDocs(markdownToAst(beforeMd || '') as AstNode, markdownToAst(afterMd || '') as AstNode, opts);
}

/* ── alignment ────────────────────────────────────────────────────────── */

function align(ua: Unit[], ub: Unit[]): Raw[] {
    const raws: Raw[] = [];
    let i = 0;
    let j = 0;
    for (const h of diffHunks(ua, ub, (x, y) => x.key === y.key, BLOCK_COST)) {
        while (i < h.a0) raws.push({ op: 'equal', a: ua[i++], b: ub[j++] });
        const as = ua.slice(h.a0, h.a1);
        const bs = ub.slice(h.b0, h.b1);
        let x = 0;
        let y = 0;
        for (const [pi, pj] of pairs(as, bs)) {
            while (x < pi) raws.push({ op: 'delete', a: as[x++] });
            while (y < pj) raws.push({ op: 'insert', b: bs[y++] });
            raws.push({ op: 'modify', a: as[x++], b: bs[y++] });
        }
        while (x < as.length) raws.push({ op: 'delete', a: as[x++] });
        while (y < bs.length) raws.push({ op: 'insert', b: bs[y++] });
        i = h.a1;
        j = h.b1;
    }
    while (i < ua.length) raws.push({ op: 'equal', a: ua[i++], b: ub[j++] });
    return raws;
}

/** How alike two blocks are (0 = not pairable). */
function similarity(a: Unit, b: Unit): number {
    if (a.kind !== b.kind) return 0;
    if (a.kind !== 'text') return a.ctx === b.ctx ? 1 : 0.8;
    const s = bagSimilarity(unitBag(a), unitBag(b));
    if (s >= MIN_SIMILARITY) return s + (a.ctx === b.ctx ? 0.05 : 0) + (a.node.type === b.node.type ? 0.05 : 0);
    // A table cell is its position, and a label of a word or three is too short
    // for word overlap to mean anything: in the same place, it is the same block.
    if (a.ctx !== b.ctx) return 0;
    if (a.ctx.includes('tableCell')) return 0.3;
    return a.node.type === b.node.type && countWords(unitTokens(a)) <= SHORT_WORDS && countWords(unitTokens(b)) <= SHORT_WORDS ? 0.2 : 0;
}

/** Pairs [i, j] (increasing in both) of blocks to report as modified. */
function pairs(as: Unit[], bs: Unit[]): Array<[number, number]> {
    if (!as.length || !bs.length) return [];
    if (as.length * bs.length > MAX_PAIRING_CELLS) {
        const out: Array<[number, number]> = [];
        for (let k = 0; k < Math.min(as.length, bs.length); k++) if (similarity(as[k], bs[k]) > 0) out.push([k, k]);
        return out;
    }
    const m = as.length;
    const n = bs.length;
    const score: Float64Array[] = Array.from({ length: m + 1 }, () => new Float64Array(n + 1));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const s = similarity(as[i - 1], bs[j - 1]);
            score[i][j] = Math.max(score[i - 1][j], score[i][j - 1], s > 0 ? score[i - 1][j - 1] + s : 0);
        }
    }
    const out: Array<[number, number]> = [];
    let i = m;
    let j = n;
    while (i > 0 && j > 0) {
        if (score[i][j] === score[i - 1][j]) i--;
        else if (score[i][j] === score[i][j - 1]) j--;
        else { out.push([i - 1, j - 1]); i--; j--; }
    }
    return out.reverse();
}

/* ── output ───────────────────────────────────────────────────────────── */

function modifyBlock(r: { a: Unit; b: Unit }, a: AstNode, b: AstNode): DiffBlock {
    const block: DiffBlock = { op: 'modify', before: shellOf(a, [r.a]) || r.a.node, after: shellOf(b, [r.b]) || r.b.node };
    if (isTextblockType(r.a.node.type) && isTextblockType(r.b.node.type)) {
        const wd = diffWords(unitTokens(r.a), unitTokens(r.b));
        block.words = wd.words;
        block.formatOnly = wd.sameText;
    } else if (isBlockAtomType(r.a.node.type)) {
        // Same atom with only its size, placement or context changed.
        block.formatOnly = onlyPresentation(r.a.node, r.b.node);
    }
    return block;
}

function attrDiffKeys(x: AstNode, y: AstNode): string[] {
    const xa = canonicalAttrs(x.type, x.attrs);
    const ya = canonicalAttrs(y.type, y.attrs);
    return [...new Set([...Object.keys(xa), ...Object.keys(ya)])].filter((k) => JSON.stringify(xa[k]) !== JSON.stringify(ya[k]));
}

const onlyPresentation = (x: AstNode, y: AstNode): boolean => attrDiffKeys(x, y).every((k) => PRESENTATION.has(k));

interface Group {
    op: 'equal' | 'insert' | 'delete';
    as: Unit[];
    bs: Unit[];
}

function groupBlock(g: Group, a: AstNode, b: AstNode): DiffBlock {
    const block: DiffBlock = { op: g.op };
    const before = shellOf(a, g.as);
    const after = shellOf(b, g.bs);
    if (before) block.before = before;
    if (after) block.after = after;
    return block;
}

/** May this block join the run: same op, and from the same top-level block on each side it has. */
const joins = (g: Group, op: string, ua: Unit | null, ub: Unit | null): boolean =>
    g.op === op
    && (!ua || (g.as.length > 0 && g.as[0].top === ua.top))
    && (!ub || (g.bs.length > 0 && g.bs[0].top === ub.top));

/** One block per run of same-op blocks from the same top-level block(s). */
function emit(raws: Raw[], a: AstNode, b: AstNode): DiffBlock[] {
    const out: DiffBlock[] = [];
    let group: Group | null = null;
    for (const r of raws) {
        if (r.op === 'modify') {
            if (group) out.push(groupBlock(group, a, b));
            group = null;
            out.push(modifyBlock(r, a, b));
            continue;
        }
        const ua = r.op === 'insert' ? null : r.a;
        const ub = r.op === 'delete' ? null : r.b;
        if (!group || !joins(group, r.op, ua, ub)) {
            if (group) out.push(groupBlock(group, a, b));
            group = { op: r.op, as: [], bs: [] };
        }
        if (ua) group.as.push(ua);
        if (ub) group.bs.push(ub);
    }
    if (group) out.push(groupBlock(group, a, b));
    return out;
}

function statsOf(raws: Raw[]): DiffStats {
    let wordsAdded = 0;
    let wordsRemoved = 0;
    let blocksChanged = 0;
    for (const r of raws) {
        if (r.op === 'equal') continue;
        blocksChanged++;
        if (r.op === 'insert') wordsAdded += countWords(unitTokens(r.b));
        else if (r.op === 'delete') wordsRemoved += countWords(unitTokens(r.a));
        else if (isTextblockType(r.a.node.type) && isTextblockType(r.b.node.type)) {
            const wd = diffWords(unitTokens(r.a), unitTokens(r.b));
            wordsAdded += wd.added;
            wordsRemoved += wd.removed;
        }
    }
    return { wordsAdded, wordsRemoved, blocksChanged };
}

/** Statistics without alignment: word and block multisets compared (linear time). */
function statsOnly(ua: Unit[], ub: Unit[]): DocDiff {
    const words = new Map<string, number>();
    const keys = new Map<string, number>();
    for (const u of ua) {
        for (const t of unitTokens(u)) if (t.w) words.set(t.k, (words.get(t.k) || 0) + 1);
        keys.set(u.key, (keys.get(u.key) || 0) + 1);
    }
    let wordsAdded = 0;
    let addedBlocks = 0;
    for (const u of ub) {
        for (const t of unitTokens(u)) {
            if (!t.w) continue;
            const n = words.get(t.k) || 0;
            if (n > 0) words.set(t.k, n - 1); else wordsAdded++;
        }
        const n = keys.get(u.key) || 0;
        if (n > 0) keys.set(u.key, n - 1); else addedBlocks++;
    }
    let wordsRemoved = 0;
    words.forEach((n) => { wordsRemoved += n; });
    let removedBlocks = 0;
    keys.forEach((n) => { removedBlocks += n; });
    return { blocks: [], stats: { wordsAdded, wordsRemoved, blocksChanged: Math.max(addedBlocks, removedBlocks) }, truncated: true };
}
