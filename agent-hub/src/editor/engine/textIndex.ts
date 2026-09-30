/**
 * textIndex.ts — the document's text as one string, with a way back to model
 * positions.
 *
 * Every textblock contributes its tokens one-for-one (a character is a UTF-16
 * code unit, an inline atom is one placeholder character) and blocks are
 * separated by '\n', so a global offset maps to exactly one (path, offset)
 * and back. Find-in-document and comment anchors both search this string.
 */
import { isTextblock } from '../model/schema.js';
import { inlineToTokens } from './inline.js';

export interface ModelPos { path: number[]; offset: number }

export interface TextBlockEntry {
    path: number[];
    /** Global offset of the block's first token. */
    start: number;
    text: string;
}

export interface TextIndex {
    text: string;
    blocks: TextBlockEntry[];
    /** Block by its path (`path.join(',')`), for position → offset lookups. */
    byPath: Map<string, TextBlockEntry>;
}

interface AnyNode { type: string; content?: AnyNode[]; text?: string }

/** Placeholder for an inline atom other than a line break. */
export const ATOM_CHAR = '￼';

function blockText(block: AnyNode): string {
    let s = '';
    for (const t of inlineToTokens(block.content || []) as Array<{ ch?: string; node?: AnyNode }>) {
        if (t.node) s += t.node.type === 'hardBreak' ? '\n' : ATOM_CHAR;
        else s += t.ch;
    }
    return s;
}

export function buildTextIndex(doc: AnyNode): TextIndex {
    const blocks: TextBlockEntry[] = [];
    const byPath = new Map<string, TextBlockEntry>();
    const parts: string[] = [];
    let offset = 0;
    const walk = (n: AnyNode, p: number[]) => {
        if (isTextblock(n.type)) {
            const text = blockText(n);
            if (blocks.length) { parts.push('\n'); offset += 1; }
            const entry = { path: p, start: offset, text };
            blocks.push(entry);
            byPath.set(p.join(','), entry);
            parts.push(text);
            offset += text.length;
            return;
        }
        (n.content || []).forEach((c, i) => walk(c, [...p, i]));
    };
    (doc.content || []).forEach((c, i) => walk(c, [i]));
    return { text: parts.join(''), blocks, byPath };
}

/** Index of the block containing global offset `at` (binary search). */
function blockAt(index: TextIndex, at: number): number {
    let lo = 0;
    let hi = index.blocks.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (index.blocks[mid].start <= at) lo = mid; else hi = mid - 1;
    }
    return lo;
}

/** Global offset → model position (clamped into its block), or null for an empty doc. */
export function posAtOffset(index: TextIndex, at: number): ModelPos | null {
    if (!index.blocks.length) return null;
    const b = index.blocks[blockAt(index, Math.max(0, at))];
    return { path: b.path, offset: Math.max(0, Math.min(at - b.start, b.text.length)) };
}

/** Model position → global offset, or null when the path is not a textblock. */
export function offsetOfPos(index: TextIndex, pos: ModelPos): number | null {
    const b = Array.isArray(pos?.path) ? index.byPath.get(pos.path.join(',')) : undefined;
    if (!b) return null;
    return b.start + Math.max(0, Math.min(pos.offset, b.text.length));
}

/** Global offset of the first textblock inside top-level block `top`, or null. */
export function offsetOfTopBlock(index: TextIndex, top: number): number | null {
    const b = index.blocks.find((x) => x.path[0] >= top);
    return b ? b.start : null;
}

/**
 * Case-folded copy of `text` with the SAME length, so offsets in the folded
 * string are offsets in the original. A character whose lower-case form has a
 * different length (rare, e.g. dotted capital I) is kept as it is.
 */
export function foldCase(text: string): string {
    let out = '';
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        const lower = ch.toLowerCase();
        out += lower.length === 1 ? lower : ch;
    }
    return out;
}
