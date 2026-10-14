import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * App Studio runtime — the live-browse frame store.
 *
 * ai_browse steps stream screenshot/action events; a browser_view component
 * renders the latest one for its action. Frames arrive ~5/s and are NEVER
 * accumulated (the chat BrowserLivePreview discipline — latest frame only,
 * bounded memory) and NEVER persisted: a reload shows only the step's text
 * result.
 *
 * The store lives in RunSurface (above both useActionRunner and the renderer),
 * so `publish` is handed to the runner as its onBrowseEvent callback while
 * `previews` is read by components through this context. Keyed by actionId, so
 * the browser_view wired to an action shows exactly that action's browse.
 */

/** One wire event of a live browse. Only the fields each `type` carries are set. */
export interface BrowseEvent {
    type: string;
    url?: string;
    task?: string;
    queuePosition?: number | null;
    b64?: string;
    summary?: string;
    tool?: string;
}

/** What a browser_view shows for one action. */
export interface BrowsePreview {
    active?: boolean;
    ended?: boolean;
    queued?: boolean;
    queuePosition?: number | null;
    url?: string;
    task?: string;
    frame?: string;
    action?: string | null;
}

export interface BrowserRunStore {
    previews: Record<string, BrowsePreview>;
    publish: (actionId: string, evt: BrowseEvent) => void;
}

const BrowserRunContext = createContext<BrowserRunStore | null>(null);

const EMPTY: Record<string, BrowsePreview> = Object.freeze({});

/**
 * Create the store. Returns { previews, publish } — `previews` is a plain
 * object keyed by actionId; `publish(actionId, evt)` folds one wire event into
 * that action's preview and triggers a render.
 */
export function useBrowserRunStore(): BrowserRunStore {
    const ref = useRef<Record<string, BrowsePreview>>({});
    const [, bump] = useState(0);
    const rerender = useCallback(() => bump((n) => (n + 1) % 1_000_000), []);

    const publish = useCallback((actionId: string, evt: BrowseEvent) => {
        if (!actionId || !evt || typeof evt.type !== 'string') return;
        const cur: BrowsePreview = ref.current[actionId] || {};
        let next: BrowsePreview = cur;
        switch (evt.type) {
            case 'queued':
                next = { ...cur, active: true, ended: false, queued: true, queuePosition: evt.queuePosition ?? null, url: evt.url || cur.url, task: evt.task || cur.task };
                break;
            case 'start':
                next = { ...cur, active: true, ended: false, queued: false, url: evt.url || cur.url, task: evt.task || cur.task };
                break;
            case 'frame':
                // Latest frame REPLACES — never appended.
                next = { ...cur, active: true, ended: false, queued: false, frame: evt.b64 };
                break;
            case 'action':
                next = { ...cur, active: true, ended: false, action: evt.summary || evt.tool || null };
                break;
            case 'end':
                next = { ...cur, ended: true, queued: false };
                break;
            case 'reset':
                next = {};
                break;
            default:
                return;
        }
        ref.current = { ...ref.current, [actionId]: next };
        rerender();
    }, [rerender]);

    return useMemo(() => ({ previews: ref.current, publish }), [publish, ref.current]);
}

export function BrowserRunProvider({ value, children }: { value: BrowserRunStore; children?: ReactNode }) {
    return <BrowserRunContext.Provider value={value}>{children}</BrowserRunContext.Provider>;
}

/** Read the store. Safe outside a provider (returns an inert store). */
export function useBrowserRun(): BrowserRunStore {
    return useContext(BrowserRunContext) || { previews: EMPTY, publish: () => {} };
}
