/**
 * relpos.ts — editor positions ({path, offset}) ↔ Yjs relative positions.
 *
 * A relative position is anchored to a character (or a child slot), not to an
 * index, so it stays on the same spot while others type before it: the right
 * carrier for remote cursors, comment anchors and anything else that has to
 * outlive concurrent edits. Paths and offsets are in the terms of the
 * document `fragmentToAst` returns: elements it skips and embeds it drops do
 * not count, so a position always lands where the editor shows it.
 *
 * Encoded positions (base64) are what goes over the wire and into storage;
 * decoding is defensive because they come from other clients.
 */
import * as Y from 'yjs';
import { fromBase64, toBase64 } from 'lib0/buffer';
import { isTextblockType, TEXTBLOCK, astTypeOfElement, allowedChild } from './ySchema';
import { type YParent, textOf, visibleChildren } from './yConvert';
import { isVisibleEmbed } from './yText';

export interface EditorPos {
    /** Child indices from the document root to a block (a textblock for text positions). */
    path: number[];
    /** Token offset inside the textblock (0 for a position between blocks). */
    offset: number;
}

/** Largest encoded position accepted from elsewhere. */
export const MAX_ENCODED_RELPOS = 512;

/** Y index of the `offset`-th visible token boundary of a shared text. */
function visibleToYIndex(ytext: Y.XmlText, inCode: boolean, offset: number): number {
    let vis = 0;
    let yi = 0;
    for (const op of ytext.toDelta() as Array<{ insert: unknown }>) {
        if (typeof op.insert === 'string') {
            const n = op.insert.length;
            if (offset <= vis + n) return yi + Math.max(0, offset - vis);
            vis += n;
            yi += n;
            continue;
        }
        if (isVisibleEmbed(op.insert, inCode)) {
            if (offset <= vis) return yi;
            vis += 1;
        }
        yi += 1;
    }
    return yi;
}

/** Number of visible tokens before Y index `index` of a shared text. */
function yIndexToVisible(ytext: Y.XmlText, inCode: boolean, index: number): number {
    let vis = 0;
    let yi = 0;
    for (const op of ytext.toDelta() as Array<{ insert: unknown }>) {
        if (yi >= index) break;
        if (typeof op.insert === 'string') {
            const take = Math.min(op.insert.length, index - yi);
            vis += take;
            yi += op.insert.length;
            continue;
        }
        if (isVisibleEmbed(op.insert, inCode)) vis += 1;
        yi += 1;
    }
    return vis;
}

/** Raw child index of `child` in `parent`, or -1. */
function rawIndex(parent: YParent, child: Y.XmlElement): number {
    let i = 0;
    for (const c of parent.toArray()) {
        if (c === child) return i;
        i++;
    }
    return -1;
}

/**
 * A relative position for an editor position. A path to a textblock gives a
 * text position at `offset`; a path to any other block gives the slot of that
 * block in its parent. `assoc` < 0 sticks to the character before (use it for
 * the end of a range), ≥ 0 to the one after. Null when the path does not exist.
 */
export function relativeFromPos(fragment: Y.XmlFragment, path: number[], offset: number, assoc = 0): Y.RelativePosition | null {
    if (!Array.isArray(path) || path.length === 0) return null;
    let parent: YParent = fragment;
    let parentType = 'doc';
    for (let depth = 0; depth < path.length; depth++) {
        const idx = path[depth];
        const kids = visibleChildren(parent, parentType, depth + 1);
        if (!Number.isInteger(idx) || idx < 0 || idx >= kids.length) return null;
        const { y, type } = kids[idx];
        if (depth < path.length - 1) { parent = y; parentType = type; continue; }
        if (!isTextblockType(type)) return Y.createRelativePositionFromTypeIndex(parent, rawIndex(parent, y), assoc);
        const text = textOf(y);
        if (!text) return Y.createRelativePositionFromTypeIndex(y, 0, assoc);
        const off = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
        return Y.createRelativePositionFromTypeIndex(text, visibleToYIndex(text, type === 'codeBlock', off), assoc);
    }
    return null;
}

/**
 * The editor path of a shared element, or null when it is not (any longer)
 * part of the visible document.
 */
export function pathOfElement(fragment: Y.XmlFragment, el: Y.XmlElement): { path: number[]; type: string } | null {
    const chain: Y.XmlElement[] = [];
    let t: Y.AbstractType<unknown> | null = el as Y.AbstractType<unknown>;
    while (t && t !== (fragment as Y.AbstractType<unknown>)) {
        if (!(t instanceof Y.XmlElement) || !t._item || t._item.deleted) return null;
        chain.unshift(t);
        t = t.parent as Y.AbstractType<unknown> | null;
    }
    if (t !== (fragment as Y.AbstractType<unknown>)) return null;
    const path: number[] = [];
    let parent: YParent = fragment;
    let parentType = 'doc';
    for (let depth = 0; depth < chain.length; depth++) {
        const kids = visibleChildren(parent, parentType, depth + 1);
        const idx = kids.findIndex((k) => k.y === chain[depth]);
        if (idx < 0) return null;
        path.push(idx);
        parent = kids[idx].y;
        parentType = kids[idx].type;
    }
    return { path, type: parentType };
}

/**
 * The editor position a relative position points at now, or null when its
 * anchor is gone or not in this fragment's visible document.
 */
export function posFromRelative(fragment: Y.XmlFragment, ydoc: Y.Doc, rpos: Y.RelativePosition | null): EditorPos | null {
    if (!rpos) return null;
    let abs: Y.AbsolutePosition | null;
    try { abs = Y.createAbsolutePositionFromRelativePosition(rpos, ydoc); } catch { return null; }
    if (!abs) return null;
    if (abs.type instanceof Y.XmlText) return textPos(fragment, abs.type, abs.index);
    return slotPos(fragment, abs.type, abs.index);
}

/** A position inside a textblock's text. */
function textPos(fragment: Y.XmlFragment, text: Y.XmlText, index: number): EditorPos | null {
    const el = text.parent;
    if (!(el instanceof Y.XmlElement) || el.nodeName !== TEXTBLOCK || textOf(el) !== text) return null;
    const found = pathOfElement(fragment, el);
    if (!found) return null;
    return { path: found.path, offset: yIndexToVisible(text, found.type === 'codeBlock', index) };
}

/** A position between the children of a container (a block slot). */
function slotPos(fragment: Y.XmlFragment, type: Y.AbstractType<unknown>, index: number): EditorPos | null {
    let parentPath: number[] = [];
    let parentType = 'doc';
    if (type !== (fragment as Y.AbstractType<unknown>)) {
        if (!(type instanceof Y.XmlElement)) return null;
        const found = pathOfElement(fragment, type);
        if (!found) return null;
        if (isTextblockType(found.type)) return { path: found.path, offset: 0 };
        parentPath = found.path;
        parentType = found.type;
    }
    let visible = 0;
    let i = 0;
    for (const c of (type as YParent).toArray()) {
        if (i++ >= index) break;
        if (c instanceof Y.XmlElement && childVisible(parentType, c)) visible++;
    }
    return { path: [...parentPath, visible], offset: 0 };
}

function childVisible(parentType: string, c: Y.XmlElement): boolean {
    const t = astTypeOfElement(c.nodeName, c.nodeName === TEXTBLOCK ? c.getAttribute('type') : undefined);
    return !!t && allowedChild(parentType, t);
}

/** A relative position as base64 (for awareness, comment anchors, storage). */
export function encodeRelpos(rpos: Y.RelativePosition): string {
    return toBase64(Y.encodeRelativePosition(rpos));
}

/** Decode a base64 relative position from elsewhere; null when it is not one. */
export function decodeRelpos(b64: unknown): Y.RelativePosition | null {
    if (typeof b64 !== 'string' || !b64 || b64.length > MAX_ENCODED_RELPOS || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
    try {
        const rpos = Y.decodeRelativePosition(fromBase64(b64));
        return rpos && (rpos.type || rpos.tname || rpos.item) ? rpos : null;
    } catch {
        return null;
    }
}
