/**
 * editor/suggest — the suggestion engine for pages: the AI proposes a changed
 * document, a human accepts or rejects it hunk by hunk.
 *
 *   hunksFrom          current + proposed document → runs of top-level blocks
 *                      that differ (`before` → `after`), each with an anchor.
 *   anchorsForFragment adds Yjs relative positions to those anchors (live pages).
 *   applyHunks         applies the chosen hunks to the document as it is NOW:
 *                      a hunk applies only where its `before` blocks are still
 *                      found unchanged, otherwise it is stale.
 *   hunkWords          word diff of one hunk for the UI.
 *
 * The anchor is the comment anchor (editor/react/anchors.ts): quote, context,
 * block index and optional relative positions. Pure: no DOM, no React, bundled
 * for the server.
 */
import * as Y from 'yjs';
import { isTextblock } from '../model/schema.js';
import { buildTextIndex, type TextIndex } from '../engine/textIndex';
import { attrsKey, canonicalAttrs, type AstNode } from '../collab/ySchema';
import { fragmentToAst } from '../collab/yConvert';
import { relativeFromPos, encodeRelpos } from '../collab/relpos';
import { diffHunks } from '../diff/sequence';
import { diffWords, blockTokens, type DiffWord } from '../diff/words';
import { resolveAnchor, CONTEXT_CHARS, QUOTE_MAX, type CommentAnchor, type RelResolver } from '../react/anchors';

export type SuggestionAnchor = CommentAnchor;

export interface Hunk {
    /** blockIndex = first current top-level block of the run (the insert position when `before` is empty). */
    anchor: SuggestionAnchor;
    /** The current top-level blocks of the run ([] = pure insert). */
    before: AstNode[];
    /** The proposed blocks ([] = pure delete). */
    after: AstNode[];
    /** Short plain text, e.g. `Rewrote paragraph "Prijzen zijn…"`. */
    summary: string;
}

export interface ApplyResult {
    doc: AstNode;
    /** Indexes into the input list. */
    applied: number[];
    stale: number[];
}

export const DEFAULT_MAX_HUNKS = 200;
const SUMMARY_CHARS = 40;
/** Edit budget of the block alignment (see diffHunks). */
const BLOCK_COST = 1000;

const kids = (n: AstNode | null | undefined): AstNode[] => (n && Array.isArray(n.content) ? n.content : []);

/* ── block text and signatures ────────────────────────────────────────── */

/** Plain text of a textblock's inline content (an inline atom is one placeholder). */
function inlineText(n: AstNode): string {
    let s = '';
    for (const c of kids(n)) {
        if (c.type === 'text') s += typeof c.text === 'string' ? c.text : '';
        else if (c.type === 'hardBreak') s += '\n';
        else s += '￼';
    }
    return s;
}

/** Text of any block with a displayable form for atoms (summary, word diff). */
function plainText(n: AstNode): string {
    if (isTextblock(n.type)) {
        let s = '';
        for (const c of kids(n)) {
            if (c.type === 'text') s += typeof c.text === 'string' ? c.text : '';
            else if (c.type === 'hardBreak') s += '\n';
            else {
                const a = c.attrs || {};
                s += String(c.type === 'formula' ? a.src ?? '' : c.type === 'mathInline' ? a.latex ?? '' : c.type === 'image' ? a.alt ?? '' : '');
            }
        }
        return s;
    }
    const inner = kids(n).map(plainText).filter((t) => t !== '');
    return inner.join('\n');
}

/** Same node types, attributes and normalised text, recursively. */
function sigOf(n: AstNode): string {
    const head = `${n.type}${attrsKey(canonicalAttrs(n.type, n.attrs))}`;
    if (isTextblock(n.type)) return `${head}|${inlineText(n).replace(/\s+/g, ' ').trim()}`;
    return `${head}(${kids(n).map(sigOf).join(',')})`;
}

/** Exact identity of a block, for the alignment (marks included). */
const keyOf = (n: AstNode): string => JSON.stringify(n);

/* ── anchors ──────────────────────────────────────────────────────────── */

interface Spans {
    index: TextIndex;
    /** Per top-level block: the text range [a, b) its textblocks cover in `index.text`, or null (no text). */
    spans: Array<{ a: number; b: number; first: number[]; last: number[]; lastLen: number } | null>;
}

function spansOf(blocks: AstNode[]): Spans {
    const index = buildTextIndex({ type: 'doc', content: blocks });
    const spans: Spans['spans'] = blocks.map(() => null);
    for (const e of index.blocks) {
        const top = e.path[0];
        const cur = spans[top];
        if (!cur) spans[top] = { a: e.start, b: e.start + e.text.length, first: e.path, last: e.path, lastLen: e.text.length };
        else { cur.b = e.start + e.text.length; cur.last = e.path; cur.lastLen = e.text.length; }
    }
    return { index, spans };
}

/** The anchor quote of top-level blocks [s, e): their text, or '' when there is none worth anchoring on. */
function quoteOf(sp: Spans, s: number, e: number): string {
    let a = -1;
    let b = -1;
    for (let i = s; i < e && i < sp.spans.length; i++) {
        const x = sp.spans[i];
        if (!x) continue;
        if (a < 0) a = x.a;
        b = x.b;
    }
    if (a < 0) return '';
    const q = sp.index.text.slice(a, Math.min(b, a + QUOTE_MAX));
    return q.trim() ? q : '';
}

function anchorFor(sp: Spans, s: number, e: number, total: number): SuggestionAnchor {
    if (e > s) {
        const quote = quoteOf(sp, s, e);
        const a: SuggestionAnchor = { quote, prefix: '', suffix: '', blockIndex: s };
        if (quote) {
            let start = -1;
            for (let i = s; i < e; i++) if (sp.spans[i]) { start = sp.spans[i]!.a; break; }
            a.prefix = sp.index.text.slice(Math.max(0, start - CONTEXT_CHARS), start);
            a.suffix = sp.index.text.slice(start + quote.length, start + quote.length + CONTEXT_CHARS);
        }
        return a;
    }
    // Pure insert: anchored on the neighbour — the block before the position,
    // or (at the very start) the block after it.
    const n = s > 0 ? s - 1 : 0;
    const has = total > 0;
    return { quote: has ? quoteOf(sp, n, n + 1) : '', prefix: '', suffix: '', blockIndex: s };
}

function summaryOf(before: AstNode[], after: AstNode[]): string {
    const label = (n: AstNode): string => (n.type === 'bulletList' || n.type === 'orderedList' || n.type === 'taskList' ? 'list' : n.type === 'codeBlock' ? 'code block' : n.type === 'blockquote' ? 'quote' : n.type);
    const snippet = (ns: AstNode[]): string => {
        const t = ns.map(plainText).join(' ').replace(/\s+/g, ' ').trim();
        return t ? ` "${t.length > SUMMARY_CHARS ? `${t.slice(0, SUMMARY_CHARS).trimEnd()}…` : t}"` : '';
    };
    const describe = (ns: AstNode[]): string => (ns.length === 1 ? label(ns[0]) : `${ns.length} blocks`);
    if (!before.length) return `Added ${describe(after)}${snippet(after)}`;
    if (!after.length) return `Removed ${describe(before)}${snippet(before)}`;
    const same = before.map(plainText).join('\n') === after.map(plainText).join('\n');
    return `${same ? 'Changed formatting of' : 'Rewrote'} ${describe(before)}${snippet(before)}`;
}

/* ── hunksFrom ────────────────────────────────────────────────────────── */

export function hunksFrom(current: AstNode, proposed: AstNode, opts: { maxHunks?: number } = {}): { hunks: Hunk[]; replaceAll: boolean } {
    const cur = kids(current);
    const prop = kids(proposed);
    const ka = cur.map(keyOf);
    const kb = prop.map(keyOf);
    const raw = diffHunks(ka, kb, (x, y) => x === y, BLOCK_COST);
    if (!raw.length) return { hunks: [], replaceAll: false };
    const sp = spansOf(cur);
    const max = Math.max(1, opts.maxHunks ?? DEFAULT_MAX_HUNKS);
    const make = (a0: number, a1: number, b0: number, b1: number): Hunk => {
        const before = cur.slice(a0, a1);
        const after = prop.slice(b0, b1);
        return { anchor: anchorFor(sp, a0, a1, cur.length), before, after, summary: summaryOf(before, after) };
    };
    if (raw.length > max) return { hunks: [make(0, cur.length, 0, prop.length)], replaceAll: true };
    return { hunks: raw.map((h) => make(h.a0, h.a1, h.b0, h.b1)), replaceAll: false };
}

/* ── locating a hunk ──────────────────────────────────────────────────── */

interface Ctx {
    blocks: AstNode[];
    sp: Spans;
    sigs: Array<string | undefined>;
    resolver: RelResolver | null;
    doc: AstNode;
}

const sigAt = (c: Ctx, i: number): string => (c.sigs[i] ??= sigOf(c.blocks[i]));

function matchesAt(c: Ctx, bs: string[], i: number): boolean {
    if (i < 0 || i + bs.length > c.blocks.length) return false;
    for (let j = 0; j < bs.length; j++) if (sigAt(c, i + j) !== bs[j]) return false;
    return true;
}

/** Candidate positions nearest to `hint` first. */
function* nearest(n: number, hint: number): Generator<number> {
    const h = Math.min(Math.max(0, hint), Math.max(0, n - 1));
    for (let d = 0; d < n; d++) {
        if (h - d >= 0) yield h - d;
        if (d > 0 && h + d < n) yield h + d;
    }
}

/** First top-level index where the hunk's `before` blocks are still found unchanged, or null. */
function locate(c: Ctx, h: Hunk): number | null {
    const anchor = h.anchor;
    const hint = Number.isInteger(anchor?.blockIndex) ? anchor.blockIndex : 0;
    if (!h.before.length) return locateInsert(c, anchor, hint);
    const bs = h.before.map(sigOf);
    if (c.resolver && anchor.relStart && anchor.relEnd && anchor.quote) {
        let r = null;
        try { r = resolveAnchor(c.doc, anchor, c.resolver, c.sp.index); } catch { r = null; }
        const top = r?.from.path[0];
        if (typeof top === 'number' && matchesAt(c, bs, top)) return top;
    }
    if (matchesAt(c, bs, hint)) return hint;
    for (const i of nearest(c.blocks.length, hint)) if (matchesAt(c, bs, i)) return i;
    return null;
}

function locateInsert(c: Ctx, anchor: SuggestionAnchor, hint: number): number | null {
    const n = c.blocks.length;
    const at = Math.min(Math.max(0, hint), n);
    if (!anchor.quote) return at;
    // Anchored on the block before the position, or at the start on the block after it.
    const neighbour = at > 0 ? at - 1 : 0;
    const shift = at > 0 ? 1 : 0;
    if (neighbour < n && quoteOf(c.sp, neighbour, neighbour + 1) === anchor.quote) return neighbour + shift;
    for (const i of nearest(n, neighbour)) if (quoteOf(c.sp, i, i + 1) === anchor.quote) return i + shift;
    return null;
}

const newCtx = (doc: AstNode, resolver: RelResolver | null): Ctx => {
    const blocks = kids(doc);
    return { blocks, sp: spansOf(blocks), sigs: new Array(blocks.length), resolver, doc };
};

/* ── anchorsForFragment ───────────────────────────────────────────────── */

/** Fill `relStart`/`relEnd` at the run's text boundaries from the live shared document. */
export function anchorsForFragment(fragment: unknown, hunks: Hunk[]): Hunk[] {
    const frag = fragment as Y.XmlFragment;
    const c = newCtx(fragmentToAst(frag) as AstNode, null);
    return hunks.map((h) => {
        if (!h.before.length || !h.anchor.quote) return h;
        const s = locate(c, h);
        if (s == null) return h;
        let first: number[] | null = null;
        let last: number[] | null = null;
        let lastLen = 0;
        for (let i = s; i < s + h.before.length; i++) {
            const x = c.sp.spans[i];
            if (!x) continue;
            if (!first) first = x.first;
            last = x.last;
            lastLen = x.lastLen;
        }
        if (!first || !last) return h;
        const a = relativeFromPos(frag, first, 0, 0);
        const b = relativeFromPos(frag, last, lastLen, -1);
        return a && b ? { ...h, anchor: { ...h.anchor, relStart: encodeRelpos(a), relEnd: encodeRelpos(b) } } : h;
    });
}

/* ── applyHunks ───────────────────────────────────────────────────────── */

export function applyHunks(current: AstNode, hunks: Hunk[], resolver?: unknown): ApplyResult {
    const c = newCtx(current, (resolver as RelResolver | null) || null);
    const taken: Array<[number, number]> = [];
    const plan: Array<{ idx: number; s: number; e: number; h: Hunk }> = [];
    const stale: number[] = [];
    hunks.forEach((h, idx) => {
        const s = locate(c, h);
        if (s == null) { stale.push(idx); return; }
        const e = s + h.before.length;
        // Overlap with an earlier hunk: the first wins. A pure insert only clashes inside a replaced run.
        const clash = taken.some(([ts, te]) => (e > s ? s < te && ts < e : s > ts && s < te));
        if (clash) { stale.push(idx); return; }
        if (e > s) taken.push([s, e]);
        plan.push({ idx, s, e, h });
    });
    // Bottom-up so earlier indices stay valid; at one position the replacement goes first,
    // then inserts from the last to the first so they land in input order.
    const order = [...plan].sort((x, y) => (y.s - x.s) || ((y.e > y.s ? 1 : 0) - (x.e > x.s ? 1 : 0)) || (y.idx - x.idx));
    const blocks = c.blocks.slice();
    for (const p of order) blocks.splice(p.s, p.e - p.s, ...p.h.after);
    return {
        doc: plan.length ? { ...current, content: blocks } : current,
        applied: plan.map((p) => p.idx).sort((a, b) => a - b),
        stale: stale.sort((a, b) => a - b),
    };
}

/* ── hunkWords ────────────────────────────────────────────────────────── */

const asText = (ns: AstNode[]): AstNode => ({ type: 'paragraph', content: [{ type: 'text', text: ns.map(plainText).join('\n') }] });

/** The text of both sides and their word diff, for the suggestion card. */
export function hunkWords(h: Hunk): { beforeText: string; afterText: string; words: DiffWord[] } {
    const b = asText(h.before);
    const a = asText(h.after);
    const beforeText = h.before.map(plainText).join('\n');
    const afterText = h.after.map(plainText).join('\n');
    return { beforeText, afterText, words: diffWords(blockTokens(b), blockTokens(a)).words };
}
