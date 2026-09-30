/**
 * anchors.ts — where a comment points, kept OUTSIDE the document.
 *
 * A comment anchor is the quoted text plus a little context on both sides and
 * the index of the top-level block it started in; while co-editing it also
 * carries two Yjs relative positions, which follow the text through
 * everyone's edits. Nothing is written into the document itself, so comments
 * never leak into exports, Markdown or AI context.
 *
 * Re-finding an anchor: the relative positions when they still enclose text,
 * otherwise the quote, preferring the occurrence whose surroundings match
 * the saved context and which is closest to the original block.
 */
import { isText, isCollapsed, selRange } from '../engine/selection.js';
import { buildTextIndex, offsetOfPos, offsetOfTopBlock, posAtOffset, type ModelPos, type TextIndex } from '../engine/textIndex';

export interface CommentAnchor {
    quote: string;
    prefix: string;
    suffix: string;
    blockIndex: number;
    relStart?: string;
    relEnd?: string;
}

/** Converts between model positions and encoded relative positions (co-editing only). */
export interface RelResolver {
    /** `assoc` < 0 sticks to the character before (the end of a range). */
    toRel(pos: ModelPos, assoc?: number): string | null;
    fromRel(b64: string): ModelPos | null;
}

export interface ModelRange { from: ModelPos; to: ModelPos }

interface AnyNode { type: string; content?: AnyNode[] }

export const QUOTE_MAX = 2000;
export const CONTEXT_CHARS = 32;

/** The anchor for a non-empty text selection, or null. */
export function anchorFromSelection(doc: AnyNode, selection: unknown, resolver?: RelResolver | null): CommentAnchor | null {
    if (!isText(selection) || isCollapsed(selection)) return null;
    const { from, to } = selRange(selection) as { from: ModelPos; to: ModelPos };
    const index = buildTextIndex(doc);
    const a = offsetOfPos(index, from);
    const b = offsetOfPos(index, to);
    if (a == null || b == null || b <= a) return null;
    const quote = index.text.slice(a, Math.min(b, a + QUOTE_MAX));
    if (!quote.trim()) return null;
    const end = a + quote.length;
    const anchor: CommentAnchor = {
        quote,
        prefix: index.text.slice(Math.max(0, a - CONTEXT_CHARS), a),
        suffix: index.text.slice(end, end + CONTEXT_CHARS),
        blockIndex: from.path[0] ?? 0,
    };
    if (resolver) {
        const endPos = end === b ? to : posAtOffset(index, end);
        const relStart = resolver.toRel(from);
        const relEnd = endPos ? resolver.toRel(endPos, -1) : null;
        if (relStart && relEnd) { anchor.relStart = relStart; anchor.relEnd = relEnd; }
    }
    return anchor;
}

/** Length of the common suffix of a and b. */
function commonSuffix(a: string, b: string): number {
    let n = 0;
    while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n += 1;
    return n;
}

/** Length of the common prefix of a and b. */
function commonPrefix(a: string, b: string): number {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
    return n;
}

function isValid(anchor: unknown): anchor is CommentAnchor {
    const a = anchor as CommentAnchor | null;
    return !!a && typeof a.quote === 'string' && a.quote.length > 0;
}

/** The anchor's relative positions, when they still enclose some text. */
function resolveByRelative(index: TextIndex, anchor: CommentAnchor, resolver: RelResolver): ModelRange | null {
    if (!anchor.relStart || !anchor.relEnd) return null;
    const from = resolver.fromRel(anchor.relStart);
    const to = resolver.fromRel(anchor.relEnd);
    if (!from || !to) return null;
    const a = offsetOfPos(index, from);
    const b = offsetOfPos(index, to);
    return a != null && b != null && b > a ? { from, to } : null;
}

/** How well the text around an occurrence matches the saved context (higher is better). */
function contextScore(index: TextIndex, at: number, anchor: CommentAnchor, hint: number): number {
    const before = index.text.slice(Math.max(0, at - CONTEXT_CHARS), at);
    const end = at + anchor.quote.length;
    const after = index.text.slice(end, end + CONTEXT_CHARS);
    const context = commonSuffix(before, anchor.prefix || '') + commonPrefix(after, anchor.suffix || '');
    // Context dominates; distance from the original block breaks ties.
    return context * 1000 - Math.min(999, Math.abs(at - hint) / 50);
}

/** The best occurrence of the quote, or null when it is nowhere. */
function resolveByQuote(index: TextIndex, anchor: CommentAnchor): ModelRange | null {
    const quote = anchor.quote;
    const hint = offsetOfTopBlock(index, Math.max(0, Number(anchor.blockIndex) || 0)) ?? 0;
    let best = -1;
    let bestScore = -Infinity;
    let at = index.text.indexOf(quote);
    for (let guard = 0; at !== -1 && guard < 10_000; guard += 1) {
        const score = contextScore(index, at, anchor, hint);
        if (score > bestScore) { bestScore = score; best = at; }
        at = index.text.indexOf(quote, at + 1);
    }
    if (best === -1) return null;
    const from = posAtOffset(index, best);
    const to = posAtOffset(index, best + quote.length);
    return from && to ? { from, to } : null;
}

/**
 * Where an anchor is in `doc` now, or null when its text is gone. Resolving
 * several anchors against one document: build `buildTextIndex(doc)` once and
 * pass it (it is O(document)).
 */
export function resolveAnchor(doc: AnyNode, anchor: CommentAnchor, resolver?: RelResolver | null, index?: TextIndex): ModelRange | null {
    if (!isValid(anchor)) return null;
    const idx = index || buildTextIndex(doc);
    return (resolver ? resolveByRelative(idx, anchor, resolver) : null) || resolveByQuote(idx, anchor);
}
