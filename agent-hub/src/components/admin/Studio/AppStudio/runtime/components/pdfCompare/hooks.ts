import { useCallback, useEffect, useEffectEvent, useState } from 'react';
import useTranslation from '../../../../../../../hooks/useTranslation';
import { descriptorKey, fetchFileBlob, friendlyError, type FileEntry } from '../fileLoading';
import { diffRegions, sameGeometry, type ChangeRegion } from './pdfCompareMath';
import { isRenderCancelled, openPdf } from './pdfEngine';
import type { PdfDocHandle } from './pdfTypes';

export interface BlobState { status: 'idle' | 'loading' | 'ready' | 'error'; blob: Blob | null; url: string | null; name: string; error: string | null }
const IDLE: BlobState = { status: 'idle', blob: null, url: null, name: '', error: null };
const LOADING: BlobState = { ...IDLE, status: 'loading' };

/** Fetch one bound file (authenticated) into a Blob (and an object URL for Download). */
export function useFileBlob(descriptor: FileEntry, live: boolean, appId: string | undefined, attempt: number): BlobState {
    const { t } = useTranslation();
    const translate = useEffectEvent((status: number | undefined, message: string | undefined) => friendlyError(status, message, t));
    const key = descriptorKey(descriptor);
    const request = live && key && appId ? `${appId}|${key}|${attempt}` : null;
    // The result is stored with the request it answers; any other request means "loading".
    const [result, setResult] = useState<{ request: string; state: BlobState } | null>(null);
    const current = useEffectEvent(() => descriptor);
    useEffect(() => {
        if (!request || !appId) return undefined;
        let alive = true;
        let url: string | null = null;
        fetchFileBlob(current(), appId).then((f) => {
            if (!alive) return;
            url = URL.createObjectURL(f.blob);
            setResult({ request, state: { status: 'ready', blob: f.blob, url, name: f.name, error: null } });
        }).catch((err: { status?: number; message?: string }) => {
            if (alive) setResult({ request, state: { ...IDLE, status: 'error', error: translate(err?.status, err?.message) } });
        });
        return () => { alive = false; if (url) URL.revokeObjectURL(url); };
    }, [request, appId]);
    if (!request) return IDLE;
    return result && result.request === request ? result.state : LOADING;
}

export interface DocState { status: 'idle' | 'loading' | 'ready' | 'error'; doc: PdfDocHandle | null; error: string | null }

/** Open a PDF blob with pdf.js (lazy). An engine failure is a state, never a throw. */
export function usePdfDocument(blob: Blob | null): DocState {
    // The result is stored with the blob it belongs to; anything else is "loading".
    const [result, setResult] = useState<{ blob: Blob; doc: PdfDocHandle | null; error: string | null } | null>(null);
    useEffect(() => {
        if (!blob) return undefined;
        let alive = true;
        let opened: PdfDocHandle | null = null;
        (async () => {
            try {
                const doc = await openPdf(await blob.arrayBuffer());
                if (!alive) { doc.destroy(); return; }
                opened = doc;
                setResult({ blob, doc, error: null });
            } catch (err) {
                if (alive) setResult({ blob, doc: null, error: err instanceof Error ? err.message : 'error' });
            }
        })();
        return () => { alive = false; if (opened) opened.destroy(); };
    }, [blob]);
    if (!blob) return { status: 'idle', doc: null, error: null };
    if (!result || result.blob !== blob) return { status: 'loading', doc: null, error: null };
    return result.doc ? { status: 'ready', doc: result.doc, error: null } : { status: 'error', doc: null, error: result.error };
}

/** Width of an element, updated by ResizeObserver. 0 until measured. */
export function useElementWidth(): [number, (el: HTMLElement | null) => void] {
    const [el, setEl] = useState<HTMLElement | null>(null);
    const [width, setWidth] = useState(0);
    useEffect(() => {
        if (!el) return undefined;
        const read = () => setWidth(el.clientWidth);
        read();
        if (typeof ResizeObserver === 'undefined') return undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        // Debounced: dragging a window edge must not re-render the PDF on every pixel.
        const ro = new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(read, 60); });
        ro.observe(el);
        return () => { clearTimeout(timer); ro.disconnect(); };
    }, [el]);
    return [width, useCallback((node: HTMLElement | null) => setEl(node), [])];
}

const DIFF_WIDTH = 1600;

interface ChangeResult { left: PdfDocHandle; right: PdfDocHandle; byPage: Record<number, ChangeRegion[]>; mismatch: Record<number, true>; done: boolean }
const NONE: Omit<ChangeResult, 'left' | 'right'> = { byPage: {}, mismatch: {}, done: false };

async function diffPage(left: PdfDocHandle, right: PdfDocHandle, p: number): Promise<ChangeRegion[] | 'mismatch'> {
    const [pl, pr] = await Promise.all([left.getPage(p), right.getPage(p)]);
    if (!sameGeometry(pl, pr)) return 'mismatch';
    const a = document.createElement('canvas');
    const b = document.createElement('canvas');
    await Promise.all([pl.render(a, { cssWidth: DIFF_WIDTH, dpr: 1 }).promise, pr.render(b, { cssWidth: DIFF_WIDTH, dpr: 1 }).promise]);
    const ca = a.getContext('2d', { willReadFrequently: true });
    const cb = b.getContext('2d', { willReadFrequently: true });
    if (!ca || !cb) return [];
    return diffRegions(ca.getImageData(0, 0, a.width, a.height), cb.getImageData(0, 0, b.width, b.height));
}

/**
 * Changed regions for every page, computed one page at a time (the current
 * page first) so the boxes of page 1 appear before a 40-page drawing set is done.
 */
export function useChanges(left: PdfDocHandle | null, right: PdfDocHandle | null, enabled: boolean, firstPage: number) {
    const [result, setResult] = useState<ChangeResult | null>(null);
    const startPage = useEffectEvent(() => firstPage);
    useEffect(() => {
        if (!enabled || !left || !right) return undefined;
        let alive = true;
        const patch = (fn: (r: ChangeResult) => Partial<ChangeResult>) =>
            setResult((r) => { const base = r && r.left === left && r.right === right ? r : { left, right, ...NONE }; return { ...base, ...fn(base) }; });
        (async () => {
            const n = Math.min(left.numPages, right.numPages);
            const start = startPage();
            const order = [start, ...Array.from({ length: n }, (_, i) => i + 1).filter((p) => p !== start)].filter((p) => p >= 1 && p <= n);
            for (const p of order) {
                if (!alive) return;
                try {
                    const out = await diffPage(left, right, p);
                    if (alive) patch((r) => (out === 'mismatch' ? { mismatch: { ...r.mismatch, [p]: true } } : { byPage: { ...r.byPage, [p]: out } }));
                } catch (err) {
                    if (!isRenderCancelled(err)) { /* one bad page must not stop the others */ }
                }
                await new Promise((r) => setTimeout(r, 0)); // let the UI breathe between pages
            }
            if (alive) patch(() => ({ done: true }));
        })();
        return () => { alive = false; };
    }, [left, right, enabled]);
    const fresh = enabled && result && result.left === left && result.right === right ? result : null;
    return fresh ?? NONE;
}
