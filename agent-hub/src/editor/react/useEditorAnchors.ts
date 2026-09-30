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
        const clean = Array.isArray(list) ? list.filter((x) => x && typeof x.id === 'string' && x.anchor) : [];
        setSpec({ list: clean, activeId: activeId ?? null });
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
        if (!view || !doc || !spec.list.length) return [];
        const rest: Range[] = [];
        const active: Range[] = [];
        const r = resolver();
        const index = buildTextIndex(doc);
        for (const item of spec.list) {
            const found = resolveAnchor(doc, item.anchor, r, index);
            const range: Range | null = found ? view.rangeFor(found.from, found.to) : null;
            if (!range) continue;
            (item.id === spec.activeId ? active : rest).push(range);
        }
        return [
            { name: 'bf-comment', ranges: rest, className: 'bf-comment-rect' },
            { name: 'bf-comment-active', ranges: active, className: 'bf-comment-active-rect' },
        ];
    }, [spec, doc, binding, viewRef, resolver]);

    return { getSelectionAnchor, highlightAnchors, scrollToAnchor, scrollToHeading, layers };
}
