/**
 * links.ts — add, change and remove a link as model transforms.
 *
 * The mark transforms work on a selected range only, so with the caret merely
 * INSIDE a link "edit" and "remove" used to do nothing at all. These helpers
 * find the whole link around the caret first, and insert the address as
 * linked text when there is nothing to put a link on.
 */
import { safeUrl } from '../serialization/util.js';
import { isCode, isTextblock } from '../model/schema.js';
import { getNode, updateAt } from './doc.js';
import { inlineToTokens, textTokens, tokensToInline, toggleMarkTokens } from './inline.js';
import { isText, isCollapsed, selRange, textSelection, pos } from './selection.js';
import * as T from './transforms.js';

interface Mark { type: string; attrs?: Record<string, unknown> }
interface Tok { ch?: string; marks?: Mark[]; node?: unknown }
interface AnyNode { type: string; content?: AnyNode[] }
interface ModelPos { path: number[]; offset: number }
interface AnyState { doc: AnyNode; selection: any; storedMarks?: Mark[] | null }

const hrefOf = (t: Tok | undefined): string | null => {
    const m = t && !t.node ? (t.marks || []).find((x) => x.type === 'link') : null;
    return m ? String(m.attrs?.href || '') : null;
};

/**
 * Turn what someone typed into a safe link target, or null. A bare domain
 * gets https://; script and file URLs are refused (the serializers would drop
 * them anyway, so accepting them would only lose the user's input later).
 */
export function normalizeHref(input: string): string | null {
    const raw = String(input || '').trim();
    if (!raw || /\s/.test(raw)) return null;
    let href = raw;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('/') && !href.startsWith('#')) {
        href = /^[^@/]+@[^@/]+\.[^@/]+$/.test(href) ? `mailto:${href}` : `https://${href}`;
    }
    const safe = safeUrl(href);
    if (!safe || /^data:/i.test(safe)) return null;
    return safe;
}

/** The link the caret sits in (or the selection starts in): its range and target. */
export function linkRangeAt(state: AnyState): { from: ModelPos; to: ModelPos; href: string } | null {
    const sel = state.selection;
    if (!isText(sel)) return null;
    const { from } = selRange(sel) as { from: ModelPos };
    const block = getNode(state.doc, from.path) as AnyNode | undefined;
    if (!block) return null;
    const toks = inlineToTokens(block.content || []) as Tok[];
    // Inside a link, or right after its last character.
    let at = from.offset;
    let href = hrefOf(toks[at]);
    if (href == null && at > 0) { at -= 1; href = hrefOf(toks[at]); }
    if (href == null) return null;
    let lo = at;
    let hi = at + 1;
    while (lo > 0 && hrefOf(toks[lo - 1]) === href) lo -= 1;
    while (hi < toks.length && hrefOf(toks[hi]) === href) hi += 1;
    return { from: pos(from.path, lo), to: pos(from.path, hi), href };
}

/**
 * Link the selection to `href`; with only a caret, update the link it sits
 * in, or insert `label` (default: the address) as linked text.
 */
export function applyLink<S extends AnyState>(state: S, href: string, label?: string): S {
    const sel = state.selection;
    if (!isText(sel)) return state;
    if (!isCollapsed(sel)) return T.setMark(state, 'link', { href }) as S;
    const existing = linkRangeAt(state);
    if (existing) {
        const block = getNode(state.doc, existing.from.path) as AnyNode;
        const toks = inlineToTokens(block.content || []);
        const next = toggleMarkTokens(toks, existing.from.offset, existing.to.offset, 'link', { href }, true);
        const doc = updateAt(state.doc, existing.from.path, (b: AnyNode) => ({ ...b, content: tokensToInline(next) }));
        return { ...state, doc };
    }
    const text = String(label || href);
    const { path, offset } = sel.anchor as ModelPos;
    const block = getNode(state.doc, path) as AnyNode | undefined;
    if (!block || !isTextblock(block.type) || isCode(block.type)) return state;
    const toks = inlineToTokens(block.content || []) as Tok[];
    const base = (state.storedMarks || (toks[offset - 1] && !toks[offset - 1].node ? toks[offset - 1].marks : []) || [])
        .filter((m) => m.type !== 'link' && m.type !== 'code');
    const ins = textTokens(text, [...base, { type: 'link', attrs: { href } }]);
    const next = [...toks.slice(0, offset), ...ins, ...toks.slice(offset)];
    const doc = updateAt(state.doc, path, (b: AnyNode) => ({ ...b, content: tokensToInline(next) }));
    return { ...state, doc, selection: textSelection(pos(path, offset + text.length)), storedMarks: null };
}

/** Remove the link from the selection, or the whole link around the caret. */
export function removeLink<S extends AnyState>(state: S): S {
    const sel = state.selection;
    if (!isText(sel)) return state;
    if (!isCollapsed(sel)) return T.unsetMark(state, 'link') as S;
    const existing = linkRangeAt(state);
    if (!existing) return state;
    const block = getNode(state.doc, existing.from.path) as AnyNode;
    const toks = inlineToTokens(block.content || []);
    const next = toggleMarkTokens(toks, existing.from.offset, existing.to.offset, 'link', undefined, false);
    const doc = updateAt(state.doc, existing.from.path, (b: AnyNode) => ({ ...b, content: tokensToInline(next) }));
    return { ...state, doc };
}
