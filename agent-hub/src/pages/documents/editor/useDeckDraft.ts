// A presentation drawn as it is typed: the outline and the look sent to the
// server's slide viewer (POST /:id/preview) a moment after the last change,
// shown in the canvas without saving. Saving is the autosave's business.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CanvasHandle } from '../DocumentCanvas';
import { previewDeckDraft } from '../documentsApi';

// Slower than typing: the server renders the whole deck each time.
const DECK_PREVIEW_MS = 450;

interface Draft { bodyHtml?: string; settings?: Record<string, unknown> }

export default function useDeckDraft(documentId: string, canvasRef: React.RefObject<CanvasHandle | null>) {
    const draft = useRef<Draft>({});
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const seq = useRef(0);
    const abort = useRef<AbortController | null>(null);
    const [previewError, setPreviewError] = useState('');

    const previewDraft = useCallback((partial: Draft) => {
        if (partial.bodyHtml !== undefined) draft.current.bodyHtml = partial.bodyHtml;
        if (partial.settings !== undefined) draft.current.settings = partial.settings;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(async () => {
            const mine = ++seq.current;
            abort.current?.abort();
            const ac = new AbortController();
            abort.current = ac;
            try {
                const html = await previewDeckDraft(documentId, { ...draft.current }, { signal: ac.signal });
                if (mine !== seq.current) return;
                canvasRef.current?.setDraft(html);
                setPreviewError('');
            } catch (e: any) {
                if (e?.name === 'AbortError') return;
                if (mine === seq.current) setPreviewError(e?.message || '');
            }
        }, DECK_PREVIEW_MS);
    }, [documentId, canvasRef]);

    /** What was drafted is saved now: the next preview starts from the stored state. */
    const settled = useCallback(() => {
        draft.current.settings = undefined;
        if (timer.current) clearTimeout(timer.current);
    }, []);

    useEffect(() => () => { if (timer.current) clearTimeout(timer.current); abort.current?.abort(); }, []);
    return { previewDraft, previewError, settled };
}

/**
 * The slide the outline's caret is on: the cover ("# " title) is slide 0 when
 * there is one, then one slide per "## " heading.
 */
export function slideAt(outline: string, caret: number): number {
    const before = outline.slice(0, Math.max(0, caret)).split('\n');
    const hasCover = /^#\s/m.test(outline);
    const headings = before.filter((line) => /^##\s/.test(line)).length;
    return hasCover ? headings : Math.max(0, headings - 1);
}
