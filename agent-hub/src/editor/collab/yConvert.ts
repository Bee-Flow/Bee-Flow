/**
 * yConvert.ts — BeeEditor AST ↔ Yjs XmlFragment (layout in ySchema.ts).
 *
 * Reading (`fragmentToAst`) is the trust boundary for shared documents: only
 * whitelisted elements in an allowed position are read, attributes and
 * formats go through the schema's sanitisers, and structure that concurrent
 * edits can leave behind (an empty list item, a list without items) is
 * repaired on the way out — never written back. Elements that are not part of
 * the schema are skipped everywhere (read, write, positions), consistently.
 *
 * Writing a whole document (`astToFragment`) is for seeding an empty
 * fragment; changing a live document is ySync.ts's minimal diff-apply.
 *
 * The inline side (tokens, text read/write) lives in yText.ts.
 *
 * Pure: no DOM, bundled for the server (serverEntry.ts).
 */
import * as Y from 'yjs';
import {
    type AstNode, type Attrs, MAX_DEPTH, TEXTBLOCK, allowedChild, astTypeOfElement, attrsKey,
    canonicalAttrs, elementAttrsFor, elementNameFor, isBlockAtomType, isTextblockType,
} from './ySchema';
import { fillText, inlineSignature, tokensToInline, yTokens } from './yText';

export type YParent = Y.XmlFragment | Y.XmlElement;

/**
 * Per-document state shared by reading and syncing. Create one per
 * fragment with `createYCache()` and pass it to BOTH fragmentToAst and
 * syncDocToFragment: the document the local editor shows must always be one
 * that came from `fragmentToAst(fragment, cache)` or that was handed to
 * `syncDocToFragment(fragment, doc, cache)`. That is what lets a sync tell
 * "the local user changed this" from "someone else changed this and the
 * local editor has not caught up yet".
 */
export interface YCache {
    /** Read results per element; dropped as soon as the element or anything below it changes. */
    read: WeakMap<object, AstNode>;
    /** AST node → the element it was read from or written to. */
    ast: WeakMap<object, Y.XmlElement>;
    /** The last whole document the local side took from, or gave to, the fragment. */
    base: AstNode | null;
    /** The fragment this cache follows (set on first use). */
    fragment: Y.XmlFragment | null;
    /** Stop following the document. */
    destroy(): void;
    /** @internal */ _detach: (() => void) | null;
}

export function createYCache(): YCache {
    const cache: YCache = {
        read: new WeakMap(), ast: new WeakMap(), base: null, fragment: null, _detach: null,
        destroy() {
            if (cache._detach) cache._detach();
            cache._detach = null;
            cache.fragment = null;
            cache.base = null;
            cache.read = new WeakMap();
            cache.ast = new WeakMap();
        },
    };
    return cache;
}

/** Bind a cache to a fragment: invalidate read results before any observer sees a change. */
export function attachCache(cache: YCache, fragment: Y.XmlFragment): void {
    if (cache.fragment === fragment && cache._detach) return;
    cache.destroy();
    const ydoc = fragment.doc;
    if (!ydoc) throw new Error('The fragment is not part of a Y.Doc.');
    // beforeObserverCalls runs before every observer of the transaction, so a
    // binding that re-reads from its own observer never sees a stale entry.
    const onChange = (tr: Y.Transaction) => {
        tr.changed.forEach((_keys, type) => {
            let t: Y.AbstractType<unknown> | null = type as Y.AbstractType<unknown>;
            while (t) {
                cache.read.delete(t);
                const item: Y.Item | null = t._item;
                t = item ? (item.parent as Y.AbstractType<unknown>) : null;
            }
        });
    };
    ydoc.on('beforeObserverCalls', onChange);
    cache.fragment = fragment;
    cache._detach = () => ydoc.off('beforeObserverCalls', onChange);
}

/* ── visibility ───────────────────────────────────────────────────────── */

export interface VisibleChild {
    y: Y.XmlElement;
    type: string;
}

/**
 * The children of a shared container that are part of the document, with
 * their AST types. `depth` is the depth of the children (fragment = 0).
 */
export function visibleChildren(parent: YParent, parentType: string, depth: number): VisibleChild[] {
    const out: VisibleChild[] = [];
    if (depth > MAX_DEPTH) return out;
    for (const child of parent.toArray()) {
        if (!(child instanceof Y.XmlElement)) continue;
        const type = astTypeOfElement(child.nodeName, child.nodeName === TEXTBLOCK ? child.getAttribute('type') : undefined);
        if (type && allowedChild(parentType, type)) out.push({ y: child, type });
    }
    return out;
}

/** The text of a textblock element: its first XmlText child. */
export function textOf(el: Y.XmlElement): Y.XmlText | null {
    for (const child of el.toArray()) if (child instanceof Y.XmlText) return child;
    return null;
}

/* ── reading ──────────────────────────────────────────────────────────── */

const emptyParagraph = (): AstNode => ({ type: 'paragraph', content: [] });

/** Children a container must have to be usable; a repair is read-only, never written. */
function repairEmpty(type: string): AstNode[] {
    switch (type) {
        case 'bulletList': case 'orderedList': return [{ type: 'listItem', content: [emptyParagraph()] }];
        case 'taskList': return [{ type: 'taskItem', content: [emptyParagraph()] }];
        case 'table': return [{ type: 'tableRow', content: [{ type: 'tableCell', content: [emptyParagraph()] }] }];
        case 'tableRow': return [{ type: 'tableCell', content: [emptyParagraph()] }];
        default: return [emptyParagraph()];
    }
}

const withAttrs = (node: AstNode, attrs: Attrs): AstNode => (Object.keys(attrs).length ? { ...node, attrs } : node);

/** Read one visible element (and everything below it). */
export function readElement(y: Y.XmlElement, type: string, depth: number, cache: YCache | null): AstNode {
    const hit = cache?.read.get(y);
    if (hit && hit.type === type) return hit;
    const attrs = canonicalAttrs(type, y.getAttributes());
    let node: AstNode;
    if (isTextblockType(type)) {
        const text = textOf(y);
        const content = text ? tokensToInline(yTokens(text, type === 'codeBlock').toks) : [];
        node = withAttrs({ type, content }, attrs);
    } else if (isBlockAtomType(type)) {
        node = withAttrs({ type }, attrs);
    } else {
        const kids = visibleChildren(y, type, depth + 1).map((c) => readElement(c.y, c.type, depth + 1, cache));
        node = withAttrs({ type, content: kids.length ? kids : repairEmpty(type) }, attrs);
    }
    if (cache) {
        cache.read.set(y, node);
        cache.ast.set(node, y);
    }
    return node;
}

/**
 * The document held by a shared fragment, sanitised. With a cache, unchanged
 * subtrees come back as the same objects as last time, and the result
 * becomes the local side's base (see YCache).
 */
export function fragmentToAst(fragment: Y.XmlFragment, cache?: YCache | null): AstNode {
    const c = cache || null;
    if (c) attachCache(c, fragment);
    const content = visibleChildren(fragment, 'doc', 1).map((k) => readElement(k.y, k.type, 1, c));
    const doc: AstNode = { type: 'doc', content };
    if (c) c.base = doc;
    return doc;
}

/* ── equivalence: equal once stored? ──────────────────────────────────── */

/**
 * Would `a` and `b` be stored identically? Compares what the shared document
 * keeps: types, canonical attributes, text with canonical formats, and the
 * children allowed in each container — not transient or normalisation-only
 * details (formula results, how text runs happen to be split).
 */
export function sameInY(a: AstNode, b: AstNode, depth = 1): boolean {
    if (a === b) return true;
    if (!a || !b || a.type !== b.type) return false;
    // The editor copies every node on each change (normalisation), so identity
    // rarely holds; plain structural equality is far cheaper than comparing
    // stored forms and settles almost every unchanged block.
    if (plainEqual(a, b)) return true;
    if (attrsKey(canonicalAttrs(a.type, a.attrs)) !== attrsKey(canonicalAttrs(b.type, b.attrs))) return false;
    if (isTextblockType(a.type)) {
        const inCode = a.type === 'codeBlock';
        const sa = inlineSignature(a.content, inCode);
        const sb = inlineSignature(b.content, inCode);
        return sa.length === sb.length && sa.every((s, i) => s === sb[i]);
    }
    if (isBlockAtomType(a.type)) return true;
    const ka = allowedKids(a, depth + 1);
    const kb = allowedKids(b, depth + 1);
    if (ka.length !== kb.length) return false;
    for (let i = 0; i < ka.length; i++) if (!sameInY(ka[i], kb[i], depth + 1)) return false;
    return true;
}

function plainAttrsEqual(x: Attrs | undefined, y: Attrs | undefined): boolean {
    if (x === y) return true;
    const xk = x ? Object.keys(x) : [];
    const yk = y ? Object.keys(y) : [];
    if (xk.length !== yk.length) return false;
    for (const k of xk) {
        const xv = (x as Attrs)[k];
        const yv = (y as Attrs)[k];
        if (xv !== yv && (typeof xv !== 'object' || JSON.stringify(xv) !== JSON.stringify(yv))) return false;
    }
    return true;
}

function plainMarksEqual(x: AstNode['marks'], y: AstNode['marks']): boolean {
    if (x === y) return true;
    const xl = x || [];
    const yl = y || [];
    if (xl.length !== yl.length) return false;
    for (let i = 0; i < xl.length; i++) {
        if (xl[i].type !== yl[i].type || !plainAttrsEqual(xl[i].attrs, yl[i].attrs)) return false;
    }
    return true;
}

/** Exact structural equality (a sufficient, not a necessary, condition for sameInY). */
function plainEqual(a: AstNode, b: AstNode): boolean {
    if (a === b) return true;
    if (a.type !== b.type || a.text !== b.text || !plainAttrsEqual(a.attrs, b.attrs) || !plainMarksEqual(a.marks, b.marks)) return false;
    const ac = a.content || [];
    const bc = b.content || [];
    if (ac.length !== bc.length) return false;
    for (let i = 0; i < ac.length; i++) {
        if (!ac[i] || !bc[i] || !plainEqual(ac[i], bc[i])) return false;
    }
    return true;
}

/** The children of an AST node that can be stored under it. */
export function allowedKids(node: AstNode, depth: number): AstNode[] {
    if (depth > MAX_DEPTH) return [];
    return (node.content || []).filter((c) => c && typeof c.type === 'string' && allowedChild(node.type, c.type));
}

/* ── writing new content ──────────────────────────────────────────────── */

/**
 * A new (not yet inserted) element for a block and everything below it, or
 * null when the block cannot be stored at this depth. Records the mapping
 * node → element in the cache.
 */
export function newBlockElement(node: AstNode, depth: number, cache: YCache | null): Y.XmlElement | null {
    if (depth > MAX_DEPTH || !node || typeof node.type !== 'string') return null;
    const el = new Y.XmlElement(elementNameFor(node.type));
    const attrs = elementAttrsFor(node);
    for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k] as string);
    if (isTextblockType(node.type)) {
        const text = new Y.XmlText();
        fillText(text, node.content, node.type === 'codeBlock');
        el.insert(0, [text]);
    } else if (!isBlockAtomType(node.type)) {
        const kids = allowedKids(node, depth + 1)
            .map((k) => newBlockElement(k, depth + 1, cache))
            .filter((k): k is Y.XmlElement => k !== null);
        if (kids.length) el.insert(0, kids);
    }
    if (cache) cache.ast.set(node, el);
    return el;
}

/** Is this the empty paragraph normalizeLight adds (never stored)? */
export function isNormalisationParagraph(node: AstNode | undefined, prev: AstNode | undefined, isOnly: boolean): boolean {
    if (!node || node.type !== 'paragraph' || (node.content && node.content.length)) return false;
    if (Object.keys(canonicalAttrs('paragraph', node.attrs)).length) return false;
    return isOnly || (!!prev && isBlockAtomType(prev.type));
}

/**
 * Seed a shared fragment with a whole document (the one-time import of a
 * legacy document). Anything already in the fragment is replaced; to change
 * a live document use syncDocToFragment, which keeps concurrent work.
 */
export function astToFragment(ast: AstNode, fragment: Y.XmlFragment, cache?: YCache | null): void {
    const ydoc = fragment.doc;
    if (!ydoc) throw new Error('The fragment is not part of a Y.Doc.');
    const c = cache || null;
    if (c) attachCache(c, fragment);
    const blocks = allowedKids(ast && ast.type === 'doc' ? ast : { type: 'doc', content: [] }, 1);
    const last = blocks.length - 1;
    const stored = isNormalisationParagraph(blocks[last], blocks[last - 1], blocks.length === 1) ? blocks.slice(0, last) : blocks;
    ydoc.transact(() => {
        if (fragment.length) fragment.delete(0, fragment.length);
        const els = stored.map((b) => newBlockElement(b, 1, c)).filter((e): e is Y.XmlElement => e !== null);
        if (els.length) fragment.insert(0, els);
    });
    if (c) c.base = ast;
}
