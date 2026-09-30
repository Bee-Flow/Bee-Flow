/**
 * useEditorAnchors — comment highlights follow the document, at a cost that
 * does not grow with every caret move: a render that did not change the
 * document recomputes nothing, and one that did reads the document once for
 * all anchors (not once per anchor).
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { markdownToAst } from '../serialization/mdToAst.js';
import useEditorAnchors, { type AnchorSpec } from './useEditorAnchors';

/** A document whose block list counts how often it is read (each full index reads it once). */
function countingDoc(md: string) {
    const blocks = (markdownToAst(md) as unknown as { content: unknown[] }).content;
    const doc = { type: 'doc', reads: 0 } as { type: string; reads: number; content?: unknown[] };
    Object.defineProperty(doc, 'content', { get() { doc.reads += 1; return blocks; } });
    return doc;
}

function fakeView(doc: unknown) {
    const view = { state: { doc }, ranges: 0, rangeFor: () => { view.ranges += 1; return document.createRange(); } };
    return view;
}

const anchors: AnchorSpec[] = Array.from({ length: 20 }, (_, i) => ({
    id: `c${i}`, anchor: { quote: `word${i}`, prefix: '', suffix: '', blockIndex: i },
}));

describe('useEditorAnchors highlights', () => {
    it('index the document once per change, and not at all for a render that only moved the caret', () => {
        const doc = countingDoc(anchors.map((_, i) => `Paragraph with word${i} in it.`).join('\n\n'));
        const view = fakeView(doc);
        const viewRef = { current: view };
        const { result, rerender } = renderHook(() => useEditorAnchors(viewRef, null));
        act(() => { result.current.highlightAnchors(anchors, 'c3'); });
        expect(doc.reads).toBe(1);
        expect(view.ranges).toBe(20);
        expect(result.current.layers[0].ranges).toHaveLength(19);
        expect(result.current.layers[1].ranges).toHaveLength(1);

        // Caret moves and other re-renders: same document object.
        rerender();
        rerender();
        expect(doc.reads).toBe(1);
        expect(view.ranges).toBe(20);

        // The document changed: one more read for all twenty anchors.
        const edited = countingDoc(anchors.map((_, i) => `Paragraph with word${i} in it!`).join('\n\n'));
        view.state = { doc: edited };
        rerender();
        expect(edited.reads).toBe(1);
        expect(view.ranges).toBe(40);
    });
});
