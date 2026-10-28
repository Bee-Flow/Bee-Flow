import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

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

/** One wire event of an ai_browse step. */
export interface BrowseEvent {
    type: string;
    queuePosition?: number | null;
    url?: string;
    task?: string;
    /** The base64 screenshot of a `frame` event. */
    b64?: string;
    summary?: string;
    tool?: string;
}

/** What a browser_view shows for one action: the latest frame and state, nothing older. */
interface BrowserPreview {
    active?: boolean;
    ended?: boolean;
    queued?: boolean;
    queuePosition?: number | null;
    url?: string;
    task?: string;
    frame?: string;
    action?: string | null;
}

interface BrowserRunStore {
    previews: Record<string, BrowserPreview>;
    publish: (actionId: string, evt: BrowseEvent) => void;
}

const BrowserRunContext = createContext<BrowserRunStore | null>(null);

const EMPTY = Object.freeze({});

/** How each wire event folds into an action's preview. */
const FOLD_BY_TYPE: Record<string, (cur: BrowserPreview, evt: BrowseEvent) => BrowserPreview> = {
    queued: (cur, evt) => ({ ...cur, active: true, ended: false, queued: true, queuePosition: evt.queuePosition ?? null, url: evt.url || cur.url, task: evt.task || cur.task }),
    start: (cur, evt) => ({ ...cur, active: true, ended: false, queued: false, url: evt.url || cur.url, task: evt.task || cur.task }),
    // Latest frame REPLACES — never appended.
    frame: (cur, evt) => ({ ...cur, active: true, ended: false, queued: false, frame: evt.b64 }),
    action: (cur, evt) => ({ ...cur, active: true, ended: false, action: evt.summary || evt.tool || null }),
    end: (cur) => ({ ...cur, ended: true, queued: false }),
    reset: () => ({}),
};

/**
 * Create the store. Returns { previews, publish } — `previews` is a plain
 * object keyed by actionId; `publish(actionId, evt)` folds one wire event into
 * that action's preview and triggers a render.
 */
export function useBrowserRunStore() {
    const [previews, setPreviews] = useState<Record<string, BrowserPreview>>({});

    const publish = useCallback((actionId: string, evt: BrowseEvent) => {
        if (!actionId || !evt || typeof evt.type !== 'string') return;
        const fold = Object.hasOwn(FOLD_BY_TYPE, evt.type) ? FOLD_BY_TYPE[evt.type] : null;
        if (!fold) return;
        // Folded in order: each queued update starts from the one before it.
        setPreviews((prev) => ({ ...prev, [actionId]: fold(prev[actionId] || {}, evt) }));
    }, []);

    return useMemo(() => ({ previews, publish }), [publish, previews]);
}

export function BrowserRunProvider({ value, children }: { value: BrowserRunStore; children?: ReactNode }) {
    return <BrowserRunContext.Provider value={value}>{children}</BrowserRunContext.Provider>;
}

/** Read the store. Safe outside a provider (returns an inert store). */
export function useBrowserRun() {
    return useContext(BrowserRunContext) || { previews: EMPTY, publish: () => {} };
}
