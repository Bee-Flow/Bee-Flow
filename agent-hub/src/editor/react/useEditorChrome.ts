/**
 * useEditorChrome — everything BeeEditor derives from the document for the
 * surrounding UI (the HTML handed to onChange, the word count, the outline,
 * the toolbar's state), computed at most once per animation frame.
 *
 * Each of those is O(document). Doing them on every keystroke — and on every
 * co-editor's keystroke — made typing in a long notebook visibly lag; one
 * frame of delay is invisible. The outline and the word count are only sent
 * when they actually changed, so the page around the editor does not
 * re-render per keystroke either. The outline also tracks which heading is
 * being read (scroll spy).
 */
import { useCallback, useEffect, useRef } from 'react';
import { activeHeadingIndex, collectHeadings, tocItems, tocSignature, type TocItem } from './toc';

export interface ChromeCallbacks {
    viewRef: { current: any };
    /** Called with the document's HTML after changes (throttled). */
    onChange?: (html: string, meta?: { remote?: boolean }) => void;
    onToc?: (items: TocItem[]) => void;
    onWordCount?: (n: number) => void;
    /** Re-render the editor chrome (toolbar state). */
    onRender: () => void;
    /** Receives the HTML of every flushed change (the editor compares content props with it). */
    lastHtmlRef: { current: string | null };
}

export function countWords(text: string): number {
    const s = String(text || '').trim();
    return s ? s.split(/\s+/).length : 0;
}

function scheduleFrame(fn: () => void): () => void {
    if (typeof requestAnimationFrame === 'function') {
        const id = requestAnimationFrame(() => fn());
        return () => cancelAnimationFrame(id);
    }
    const t = setTimeout(fn, 16);
    return () => clearTimeout(t);
}

export default function useEditorChrome(cb: ChromeCallbacks) {
    const cbRef = useRef(cb);
    cbRef.current = cb;
    const cancelRef = useRef<(() => void) | null>(null);
    const metaRef = useRef<{ remote: boolean; doc: boolean; emit: boolean }>({ remote: true, doc: false, emit: false });
    const lastToc = useRef('');
    const lastWords = useRef(-1);
    const activeRef = useRef(-1);
    const cancelSpyRef = useRef<(() => void) | null>(null);

    const sendToc = useCallback((force = false) => {
        const { viewRef, onToc } = cbRef.current;
        const view = viewRef.current;
        if (!view || !onToc) return;
        const items = tocItems(view.state.doc, activeRef.current);
        const sig = tocSignature(items);
        if (!force && sig === lastToc.current) return;
        lastToc.current = sig;
        onToc(items);
    }, []);

    /** Do the frame's work now (also used by flush and on external swaps). */
    const flush = useCallback(() => {
        if (cancelRef.current) { cancelRef.current(); cancelRef.current = null; }
        const { viewRef, onChange, onWordCount, onRender, lastHtmlRef } = cbRef.current;
        const view = viewRef.current;
        if (!view) return;
        const meta = metaRef.current;
        metaRef.current = { remote: true, doc: false, emit: false };
        if (meta.doc) {
            try {
                const html = view.getHTML();
                lastHtmlRef.current = html;
                if (meta.emit) onChange?.(html, { remote: meta.remote });
                const words = countWords(view.getText());
                if (words !== lastWords.current) { lastWords.current = words; onWordCount?.(words); }
                sendToc();
            } catch (e) {
                // The editor keeps working; the host's save path reports its own failure.
                console.error('[BeeEditor] could not refresh the document summary', (e as Error)?.name || 'Error');
            }
        }
        onRender();
    }, [sendToc]);

    /**
     * Note a change; the work runs on the next frame. `doc`: the document
     * changed (recompute HTML, words, outline); `emit`: tell onChange;
     * `remote`: it came from someone else (onChange's meta).
     */
    const schedule = useCallback((meta: { doc?: boolean; emit?: boolean; remote?: boolean } = {}) => {
        const m = metaRef.current;
        if (meta.doc) m.doc = true;
        if (meta.emit) { m.emit = true; if (!meta.remote) m.remote = false; }
        if (!cancelRef.current) cancelRef.current = scheduleFrame(() => { cancelRef.current = null; flush(); });
    }, [flush]);

    useEffect(() => () => {
        if (cancelRef.current) cancelRef.current();
        if (cancelSpyRef.current) cancelSpyRef.current();
    }, []);

    /** Scroll spy: re-send the outline when the heading being read changes. */
    const spy = useCallback(() => {
        cancelSpyRef.current = null;
        const view = cbRef.current.viewRef.current;
        if (!view || !cbRef.current.onToc) return;
        const scroller = view.host?.closest?.('.overflow-y-auto') as HTMLElement | null;
        const top = scroller ? scroller.getBoundingClientRect().top : 0;
        const height = scroller ? scroller.clientHeight : (typeof window !== 'undefined' ? window.innerHeight : 800);
        const tops = collectHeadings(view.state.doc).map((h) => {
            let n = view.state.doc;
            for (const i of h.path) n = n.content[i];
            const el = view.domForNode.get(n) as Element | undefined;
            return el ? el.getBoundingClientRect().top - top : Number.POSITIVE_INFINITY;
        });
        const active = activeHeadingIndex(tops, height / 4);
        if (active !== activeRef.current) { activeRef.current = active; sendToc(); }
    }, [sendToc]);

    const onScroll = useCallback(() => {
        if (!cancelSpyRef.current) cancelSpyRef.current = scheduleFrame(spy);
    }, [spy]);

    return { schedule, flush, onScroll, sendToc };
}
