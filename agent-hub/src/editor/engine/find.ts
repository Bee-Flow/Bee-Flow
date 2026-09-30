/**
 * find.ts — find (and replace) in the document model.
 *
 * Searching the model rather than the DOM means a match is a model range the
 * caret, the highlight layer and replace can all use, and that replace is an
 * ordinary transform: one undo step, and synced to co-editors like typing.
 */
import { isCode } from '../model/schema.js';
import { getNode, updateAt } from './doc.js';
import { inlineToTokens, textTokens, tokensToInline } from './inline.js';
import { buildTextIndex, foldCase, posAtOffset, type ModelPos } from './textIndex';

export interface FindMatch { from: ModelPos; to: ModelPos }

export interface FindOptions { caseSensitive?: boolean; limit?: number }

interface AnyNode { type: string; content?: AnyNode[]; attrs?: Record<string, unknown> }
interface AnyState { doc: AnyNode; selection: unknown; storedMarks?: unknown }

const DEFAULT_LIMIT = 1000;

/** The query as it can occur inside one block: no line breaks, no atom placeholders. */
export function cleanQuery(query: string): string {
    return String(query || '').replace(/[\n\r￼]/g, '');
}

/** Every occurrence of `query`, in document order, within single blocks. */
export function findMatches(doc: AnyNode, query: string, { caseSensitive = false, limit = DEFAULT_LIMIT }: FindOptions = {}): FindMatch[] {
    const q = cleanQuery(query);
    if (!q) return [];
    const index = buildTextIndex(doc);
    const hay = caseSensitive ? index.text : foldCase(index.text);
    const needle = caseSensitive ? q : foldCase(q);
    const out: FindMatch[] = [];
    let at = hay.indexOf(needle);
    while (at !== -1 && out.length < limit) {
        const from = posAtOffset(index, at);
        const to = posAtOffset(index, at + needle.length);
        if (from && to) out.push({ from, to });
        at = hay.indexOf(needle, at + Math.max(1, needle.length));
    }
    return out;
}

/** Index of the first match at or after `pos` (wrapping to 0). */
export function matchIndexFrom(matches: FindMatch[], pos: ModelPos | null): number {
    if (!matches.length || !pos) return 0;
    const cmp = (a: ModelPos, b: ModelPos) => {
        const n = Math.min(a.path.length, b.path.length);
        for (let i = 0; i < n; i += 1) if (a.path[i] !== b.path[i]) return a.path[i] - b.path[i];
        if (a.path.length !== b.path.length) return a.path.length - b.path.length;
        return a.offset - b.offset;
    };
    const i = matches.findIndex((m) => cmp(m.from, pos) >= 0);
    return i === -1 ? 0 : i;
}

/**
 * Replace the given matches with `replacement` (a transform). The new text
 * takes the formatting of the first replaced character. Matches are applied
 * from last to first, so earlier positions stay valid.
 */
export function replaceMatches<S extends AnyState>(state: S, matches: FindMatch[], replacement: string): S {
    if (!matches.length) return state;
    const text = String(replacement ?? '').replace(/[\n\r]/g, ' ');
    let doc = state.doc;
    const ordered = matches.slice().reverse();
    for (const m of ordered) {
        const block = getNode(doc, m.from.path) as AnyNode | undefined;
        if (!block || m.to.path.join() !== m.from.path.join()) continue;
        const toks = inlineToTokens(block.content || []) as Array<{ ch?: string; marks?: unknown[]; node?: unknown }>;
        if (m.to.offset > toks.length || m.from.offset >= m.to.offset) continue;
        const first = toks[m.from.offset];
        const marks = isCode(block.type) || !first || first.node ? [] : (first.marks || []);
        const next = [...toks.slice(0, m.from.offset), ...textTokens(text, marks), ...toks.slice(m.to.offset)];
        doc = updateAt(doc, m.from.path, (b: AnyNode) => ({ ...b, content: tokensToInline(next) }));
    }
    return doc === state.doc ? state : { ...state, doc };
}
