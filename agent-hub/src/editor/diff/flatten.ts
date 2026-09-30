/**
 * flatten.ts — a document as the list of blocks the version compare lines
 * up: every textblock and block atom, wherever it sits (top level, list
 * items, quotes, table cells), in reading order, each with the container
 * chain it sits in. Moving a paragraph into a list or ticking a task is then
 * a change of that block's context, which the compare reports as a
 * formatting change.
 *
 * Empty textblocks (blank lines) are left out: they carry no content, and
 * showing them as changes is noise. An empty table cell keeps its paragraph
 * so the cell still shows.
 */
import { attrsKey, canonicalAttrs, isBlockAtomType, isTextblockType, MAX_DEPTH, type AstNode } from '../collab/ySchema';
import { inlineSignature } from '../collab/yText';
import { blockTokens, tokenBag, type WordTok } from './words';

export interface Unit {
    /** The block itself (a textblock or a block atom). */
    node: AstNode;
    /** Index of the top-level block it belongs to. */
    top: number;
    /** Path from that top-level block down to it ([] when it is the top-level block). */
    rel: number[];
    /** Container chain, e.g. `bulletList>listItem`. */
    ctx: string;
    /** Equal keys = identical block in an identical context. */
    key: string;
    /** Same `kind` = may be paired as one block, changed. */
    kind: string;
    /** Word tokens and their bag, computed on demand. */
    toks?: WordTok[];
    bag?: Map<string, number>;
}

/** Container context: the type, plus the attributes whose change is a visible change of the block. */
function ctxPart(n: AstNode): string {
    if (n.type === 'taskItem') return n.attrs?.checked === true ? 'taskItem:x' : 'taskItem';
    if (n.type === 'tableCell') return n.attrs?.header === true ? 'tableCell:h' : 'tableCell';
    return n.type;
}

function leafKey(n: AstNode, ctx: string): string {
    const attrs = attrsKey(canonicalAttrs(n.type, n.attrs));
    const inline = isTextblockType(n.type) ? inlineSignature(n.content, n.type === 'codeBlock').join('\u0003') : '';
    return `${ctx}\u0004${n.type}\u0004${attrs}\u0004${inline}`;
}

const isEmptyTextblock = (n: AstNode): boolean => isTextblockType(n.type) && inlineSignature(n.content, n.type === 'codeBlock').length === 0;

/**
 * The blocks of a document in reading order, or null when there are more
 * than `limit` (the caller then falls back to statistics only).
 */
export function flatten(doc: AstNode | null | undefined, limit: number): Unit[] | null {
    const out: Unit[] = [];
    const tops = doc?.content || [];
    for (let i = 0; i < tops.length; i++) {
        if (!visit(out, limit, tops[i], { top: i, rel: [], ctx: [], parentType: 'doc', siblings: tops.length })) return null;
    }
    return out;
}

interface Where {
    top: number;
    rel: number[];
    ctx: string[];
    parentType: string;
    siblings: number;
}

/** Collect the blocks under `n`; false once there are more than `limit`. */
function visit(out: Unit[], limit: number, n: AstNode | undefined, at: Where): boolean {
    if (!n || typeof n.type !== 'string' || at.rel.length > MAX_DEPTH) return true;
    if (isTextblockType(n.type) || isBlockAtomType(n.type)) {
        if (isEmptyTextblock(n) && !(at.parentType === 'tableCell' && at.siblings === 1)) return true;
        if (out.length >= limit) return false;
        const c = at.ctx.join('>');
        out.push({ node: n, top: at.top, rel: at.rel, ctx: c, key: leafKey(n, c), kind: isTextblockType(n.type) ? 'text' : n.type });
        return true;
    }
    const kids = n.content || [];
    const ctx = [...at.ctx, ctxPart(n)];
    for (let i = 0; i < kids.length; i++) {
        if (!visit(out, limit, kids[i], { top: at.top, rel: [...at.rel, i], ctx, parentType: n.type, siblings: kids.length })) return false;
    }
    return true;
}

/** Word tokens of a unit (atoms have none). */
export function unitTokens(u: Unit): WordTok[] {
    if (!u.toks) u.toks = isTextblockType(u.node.type) ? blockTokens(u.node) : [];
    return u.toks;
}

export function unitBag(u: Unit): Map<string, number> {
    if (!u.bag) u.bag = tokenBag(unitTokens(u));
    return u.bag;
}

/**
 * A copy of top-level block `top` holding only the given blocks (and the
 * containers above them), so a run of blocks renders in its list, quote or
 * table rather than as bare paragraphs. An ordered list cut after its first
 * items keeps its numbering.
 */
export function shellOf(doc: AstNode, units: readonly Unit[]): AstNode | null {
    if (!units.length) return null;
    const top = (doc.content || [])[units[0].top];
    if (!top) return null;
    if (units[0].rel.length === 0) return top;
    const keep = new Set<string>();
    for (const u of units) for (let i = 1; i <= u.rel.length; i++) keep.add(u.rel.slice(0, i).join('/'));
    const prune = (n: AstNode, path: string): AstNode => {
        if (isTextblockType(n.type) || isBlockAtomType(n.type)) return n;
        const kids: AstNode[] = [];
        let first = -1;
        (n.content || []).forEach((k, i) => {
            const p = path ? `${path}/${i}` : String(i);
            if (!keep.has(p)) return;
            if (first < 0) first = i;
            kids.push(prune(k, p));
        });
        const out: AstNode = { ...n, content: kids };
        if (n.type === 'orderedList' && first > 0) {
            const start = typeof n.attrs?.start === 'number' ? n.attrs.start : 1;
            out.attrs = { ...(n.attrs || {}), start: start + first };
        }
        return out;
    };
    return prune(top, '');
}
