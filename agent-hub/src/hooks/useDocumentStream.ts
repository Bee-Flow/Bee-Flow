import { useCallback, useEffect, useMemo, useRef } from 'react';
import { API_BASE, authFetch } from '../utils/helpers';
import { parseFrame, readFrames } from './useProjectStream';

/** A number in [0, 1) for the reconnect jitter, from the platform's CSPRNG. */
const unitRandom = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;

/**
 * Live, transient events of one Studio document
 * (GET /api/studio-documents/:id/stream): who is in it, and whatever later
 * features push on the document's channel. Works for every document, in a
 * project or not.
 *
 * No cursor and no replay: a dropped connection reconnects (backoff with
 * jitter) and carries on; state that must not be missed is loaded by the page.
 * Same transport as useProjectStream (fetch streaming, because EventSource
 * cannot send the session header). Stops for good on `forbidden`, closes on
 * unmount.
 */

export type DocumentEventHandler = (event: any) => void;
/** Listen to one event type; returns the unsubscribe. */
export type DocumentSubscribe = (type: string, handler: DocumentEventHandler) => () => void;

const MAX_BACKOFF_MS = 30_000;

export default function useDocumentStream(documentId: string | null | undefined, enabled = true): { subscribe: DocumentSubscribe } {
    const handlers = useRef(new Map<string, Set<DocumentEventHandler>>());

    const subscribe = useCallback<DocumentSubscribe>((type, handler) => {
        let set = handlers.current.get(type);
        if (!set) { set = new Set(); handlers.current.set(type, set); }
        set.add(handler);
        return () => { handlers.current.get(type)?.delete(handler); };
    }, []);

    useEffect(() => {
        if (!enabled || !documentId) return undefined;
        let stopped = false;
        let controller: AbortController | null = null;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let backoff = 1000;

        const emit = (type: string, payload: unknown) => {
            for (const fn of Array.from(handlers.current.get(type) || [])) {
                try { fn(payload); } catch { /* a listener's problem */ }
            }
        };
        const reconnect = () => {
            if (stopped) return;
            const wait = Math.min(backoff, MAX_BACKOFF_MS) * (0.7 + unitRandom() * 0.6);
            backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
            timer = setTimeout(() => { timer = null; connect(); }, wait);
        };
        const onFrame = (frame: string): boolean => {
            const parsed = parseFrame(frame);
            if (!parsed || parsed.kind === 'ping') return true;
            if (parsed.kind === 'ready') { backoff = 1000; return true; }
            emit(parsed.kind, parsed.payload);
            if (parsed.kind === 'forbidden') { stopped = true; return false; }
            return true;
        };
        const connect = async () => {
            if (stopped) return;
            controller = new AbortController();
            try {
                const res = await authFetch(`${API_BASE}/api/studio-documents/${encodeURIComponent(documentId)}/stream`, {
                    signal: controller.signal, headers: { Accept: 'text/event-stream' },
                });
                // 404: no (longer) a reader; retrying cannot help.
                if (res.status === 404 || res.status === 403) { stopped = true; return; }
                if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
                const ended = await readFrames(res.body, onFrame, () => stopped);
                if (ended) reconnect();
            } catch {
                if (stopped || controller?.signal.aborted) return;
                reconnect();
            }
        };
        connect();

        return () => {
            stopped = true;
            controller?.abort();
            if (timer) clearTimeout(timer);
        };
    }, [documentId, enabled]);

    return useMemo(() => ({ subscribe }), [subscribe]);
}
