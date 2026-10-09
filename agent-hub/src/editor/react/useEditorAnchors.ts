/**
 * useEditorAnchors — the editor's side of comments and the outline:
 * capture an anchor from the selection, keep a set of anchors highlighted
 * while the document changes, and scroll to an anchor or a heading.
 *
 * Highlights are recomputed from the anchors whenever the document changes,
 * so they follow the text through typing, co-editors' edits and undo, and an
 * anchor whose text is gone simply stops being painted. A render that only
 * moved the caret recomputes nothing, and one recompute indexes the document
 * once for all anchors.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { buildTextIndex } from '../engine/textIndex';
import { anchorFromSelection, resolveAnchor, type CommentAnchor, type RelResolver } from './anchors';
import { collectHeadings } from './toc';
import type { RangeLayer } from './RangeOverlay';

interface PositionSource {
    posToRel(p: { path: number[]; offset: number }, assoc?: number): string | null;
    relToPos(b64: string): { path: number[]; offset: number } | null;
}

export interface AnchorSpec { id: string; anchor: CommentAnchor }

function cleanSpecs(list: AnchorSpec[] | null | undefined): AnchorSpec[] {
    return Array.isArray(list) ? list.filter((x) => x && typeof x.id === 'string' && x.anchor) : [];
}

function scrollElementFor(range: Range | null): Element | null {
    if (!range) return null;
    const n = range.startContainer;
    return (n.nodeType === 1 ? n : n.parentElement) as Element | null;
}

function scrollIntoViewSafe(el: Element | null, block: ScrollLogicalPosition) {
    try { el?.scrollIntoView?.({ block, behavior: 'smooth' }); } catch { /* old engines */ }
}

export default function useEditorAnchors(viewRef: { current: any }, binding: PositionSource | null) {
    // Read on every render of the editor. A document is never changed in
    // place, so the object itself says whether the content changed.
    const doc = viewRef.current?.state?.doc ?? null;
    const [spec, setSpec] = useState<{ list: AnchorSpec[]; activeId: string | null }>({ list: [], activeId: null });
    // Pending AI suggestions: painted under their own highlight name, same recompute path.
    const [suggestSpec, setSuggestSpec] = useState<{ list: AnchorSpec[]; activeId: string | null }>({ list: [], activeId: null });
    const painted = useRef<Array<{ id: string; ranges: Range[] }>>([]);
    const bindingRef = useRef(binding);
    bindingRef.current = binding;

    const resolver = useCallback((): RelResolver | null => {
        const b = bindingRef.current;
        return b ? { toRel: (p, assoc) => b.posToRel(p, assoc), fromRel: (x) => b.relToPos(x) } : null;
    }, []);

    const getSelectionAnchor = useCallback((): CommentAnchor | null => {
        const view = viewRef.current;
        if (!view) return null;
        return anchorFromSelection(view.state.doc, view.state.selection, resolver());
    }, [viewRef, resolver]);

    const highlightAnchors = useCallback((list: AnchorSpec[] | null | undefined, activeId?: string | null) => {
        setSpec({ list: cleanSpecs(list), activeId: activeId ?? null });
    }, []);

    /** Paint the passages the AI proposes to change (the focused one stronger); an empty list clears them. */
    const highlightSuggestions = useCallback((list: AnchorSpec[] | null | undefined, activeId?: string | null) => {
        setSuggestSpec({ list: cleanSpecs(list), activeId: activeId ?? null });
    }, []);

    /** The id of the suggestion painted at a client point (a click on its highlight), or null. */
    const suggestionAtPoint = useCallback((x: number, y: number): string | null => {
        for (const item of painted.current) {
            for (const range of item.ranges) {
                let rects: DOMRect[] = [];
                try { rects = Array.from(range.getClientRects ? range.getClientRects() : []); } catch { rects = []; }
                if (rects.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) return item.id;
            }
        }
        return null;
    }, []);

    const scrollToAnchor = useCallback((anchor: CommentAnchor): boolean => {
        const view = viewRef.current;
        if (!view || !anchor) return false;
        const found = resolveAnchor(view.state.doc, anchor, resolver());
        if (!found) return false;
        scrollIntoViewSafe(scrollElementFor(view.rangeFor(found.from, found.to)), 'center');
        return true;
    }, [viewRef, resolver]);

    const scrollToHeading = useCallback((index: number) => {
        const view = viewRef.current;
        if (!view) return;
        const heading = collectHeadings(view.state.doc)[Number(index)];
        if (!heading) return;
        scrollIntoViewSafe(view.domForNode.get(heading.node) || null, 'start');
    }, [viewRef]);

    const layers: RangeLayer[] = useMemo(() => {
        const view = viewRef.current;
        const out: RangeLayer[] = [];
        if (!view || !doc) { painted.current = []; return out; }
        const r = resolver();
        // One index of the document, built on first use, shared by comments and suggestions.
        let index: ReturnType<typeof buildTextIndex> | null = null;
        const rangesOf = (list: AnchorSpec[], activeId: string | null) => {
            const rest: Range[] = [];
            const active: Range[] = [];
            const found: Array<{ id: string; ranges: Range[] }> = [];
            for (const item of list) {
                const at = resolveAnchor(doc, item.anchor, r, (index ||= buildTextIndex(doc)));
                const range: Range | null = at ? view.rangeFor(at.from, at.to) : null;
                if (!range) continue;
                found.push({ id: item.id, ranges: [range] });
                (item.id === activeId ? active : rest).push(range);
            }
            return { rest, active, found };
        };
        if (spec.list.length) {
            const { rest, active } = rangesOf(spec.list, spec.activeId);
            out.push({ name: 'bf-comment', ranges: rest, className: 'bf-comment-rect' },
                { name: 'bf-comment-active', ranges: active, className: 'bf-comment-active-rect' });
        }
        if (suggestSpec.list.length) {
            const { rest, active, found } = rangesOf(suggestSpec.list, suggestSpec.activeId);
            painted.current = found;
            out.push({ name: 'bee-suggest', ranges: rest, className: 'bee-suggest-rect' },
                { name: 'bee-suggest-active', ranges: active, className: 'bee-suggest-active-rect' });
        } else painted.current = [];
        return out;
    }, [spec, suggestSpec, doc, binding, viewRef, resolver]);

    return { getSelectionAnchor, highlightAnchors, highlightSuggestions, suggestionAtPoint, scrollToAnchor, scrollToHeading, layers };
}
