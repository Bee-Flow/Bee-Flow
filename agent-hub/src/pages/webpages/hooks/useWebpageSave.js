import { useState, useRef, useEffect, useCallback } from 'react';

/**
 * useWebpageSave — the save discipline of the webpage editor (Track W0).
 *
 * Extracted verbatim-in-spirit from the monolithic pages/WebpagesPage.jsx so
 * the list / editor split could not silently change it. The rules:
 *
 *  1. ONE debounced timer. Primary-slot edits (html/css/js) and extra-file
 *     edits both schedule through `scheduleSave()`, so two schedulers never
 *     race on one timer. The page id captured at schedule time is re-checked
 *     at fire time.
 *  2. `persist()` is page-guarded. It captures the page id and the content
 *     snapshot SYNCHRONOUSLY, PUTs, and only touches UI state (dirty markers,
 *     saveState) when the hook still guards the same page and is still
 *     mounted. `onSaved(id)` fires whenever the save landed, because the row
 *     it updates is keyed by id — a switch does not make the save un-happen.
 *  3. Nothing dirty → `persist()` is a no-op (no request, no state change).
 *     That is what makes "flush before leaving" safe to call unconditionally.
 *  4. The loaded content is the first "last saved" snapshot, and the first
 *     content effect after mount is skipped, so opening a page never fires a
 *     phantom save.
 *  5. Extras are PUT per path after the primary slots. A failed extra is
 *     re-queued for the next debounce; a failed primary leaves its slots
 *     dirty and still lets the extras through.
 *  6. A dirty marker belongs to the page it was made on. If `webpageId` ever
 *     changes under one instance, the queue is dropped and the baseline moves
 *     to the incoming content — never PUT page A's file into page B.
 *
 * Mount ONE instance per page (the editor is keyed on the webpage id): the
 * unmount is what ends a page's save lifecycle, so flush first (`flushNow`)
 * if anything may be pending — unmount cancels the timer. Should a later
 * refactor drop that key, a changed `webpageId` re-baselines onto the
 * incoming content and drops the previous page's dirty markers (rule 6)
 * rather than writing them to the new page.
 *
 * @param {object} opts
 * @param {string} opts.webpageId
 * @param {string} opts.html  live primary-slot content
 * @param {string} opts.css
 * @param {string} opts.js
 * @param {React.MutableRefObject<Record<string,{isText:boolean,content?:string}>>} opts.extraContentsRef
 *        live extra-file contents (persist reads the text ones it is asked to save)
 * @param {(path:string, opts?:object)=>Promise<any>} opts.api  the /api/webpages client
 * @param {(webpageId:string)=>void} [opts.onSaved]  called after a fully successful save
 * @param {number} [opts.debounceMs=1500]
 */
export const SAVE_DEBOUNCE_MS = 1500;
export const CHAT_SAVE_DEBOUNCE_MS = 800;

export default function useWebpageSave({
    webpageId,
    html, css, js,
    extraContentsRef,
    api,
    onSaved,
    debounceMs = SAVE_DEBOUNCE_MS,
}) {
    const [saveState, setSaveState] = useState('idle'); // 'idle' | 'saving' | 'saved' | 'error'
    const [lastSavedAt, setLastSavedAt] = useState(null);
    // Per-tab dirty markers for the EditorTabs dot indicator. Keys: 'html' |
    // 'css' | 'js' | 'extra:<path>'. Mirrors dirtyExtrasRef + primary-snapshot
    // diff but lives in state so the tabs re-render when it changes.
    const [dirtyFiles, setDirtyFiles] = useState({});

    // Refs that mirror html/css/js so persist() can be stable (no content in
    // its deps) — read the live value at call time. Synced via useEffect so
    // the ref tracks state regardless of which code path mutates it.
    const contentRef = useRef({ html, css, js });
    useEffect(() => { contentRef.current = { html, css, js }; }, [html, css, js]);

    const activeIdRef = useRef(webpageId);
    useEffect(() => { activeIdRef.current = webpageId; }, [webpageId]);
    const mountedRef = useRef(true);
    useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);
    const onSavedRef = useRef(onSaved);
    useEffect(() => { onSavedRef.current = onSaved; }, [onSaved]);

    const timerRef = useRef(null);
    // The loaded content is already saved — that is the baseline every
    // subsequent persist() diffs against.
    const lastSavedSnapshotRef = useRef({ html, css, js });
    // The first content effect after mount is the load itself, not an edit.
    const skipNextSaveRef = useRef(true);
    // Dirty extras — paths whose user-typed content hasn't been persisted yet.
    // persist() walks this set and PUTs each one alongside the primary slots.
    const dirtyExtrasRef = useRef(new Set());

    const isCurrent = useCallback((id) => mountedRef.current && activeIdRef.current === id, []);

    const persist = useCallback(async () => {
        // Capture the webpage we're saving against. If the user switches
        // webpages mid-save, the response landing on the new selection's state
        // would mark someone else's files clean — bail before applying.
        const targetWebpageId = activeIdRef.current;
        if (!targetWebpageId) return;
        const snapshot = { ...contentRef.current };
        const last = lastSavedSnapshotRef.current;
        const primaryDirty = snapshot.html !== last.html || snapshot.css !== last.css || snapshot.js !== last.js;
        // Snapshot the extras and clear the queue. Edits arriving DURING the
        // PUTs add themselves to the now-empty set and get caught next tick.
        const extraPaths = Array.from(dirtyExtrasRef.current);
        dirtyExtrasRef.current = new Set();
        if (!primaryDirty && extraPaths.length === 0) return;
        setSaveState('saving');
        let primarySucceeded = !primaryDirty;
        const failedExtras = [];
        const savedExtras = [];
        try {
            if (primaryDirty) {
                await api(`/${targetWebpageId}`, { method: 'PUT', body: JSON.stringify(snapshot) });
                lastSavedSnapshotRef.current = snapshot;
                primarySucceeded = true;
            }
        } catch (err) {
            console.error('[Webpages] Primary save failed:', err);
            if (isCurrent(targetWebpageId)) setSaveState('error');
            // Fall through to attempt extras — they may still succeed.
        }
        for (const path of extraPaths) {
            const entry = extraContentsRef.current?.[path];
            if (!entry || !entry.isText) {
                // Nothing to save for this path right now — drop the dirty flag.
                savedExtras.push(path);
                continue;
            }
            try {
                await api(`/${targetWebpageId}/files`, {
                    method: 'PUT',
                    body: JSON.stringify({ path, content: entry.content || '' }),
                });
                savedExtras.push(path);
            } catch (err) {
                console.error('[Webpages] Extra save failed for', path, err);
                failedExtras.push(path);
            }
        }
        const allSucceeded = failedExtras.length === 0 && primarySucceeded;
        if (allSucceeded) onSavedRef.current?.(targetWebpageId);
        // If the selection changed during the save, don't mutate the new
        // webpage's UI state. Dirty-marker bookkeeping is per-webpage — we only
        // loaded this state because the OLD selection was active.
        if (!isCurrent(targetWebpageId)) return;
        // Re-queue any failed extras so the next debounce retries them.
        for (const p of failedExtras) dirtyExtrasRef.current.add(p);
        // Clear dirty markers for everything that successfully saved.
        if (primarySucceeded || savedExtras.length > 0) {
            setDirtyFiles(prev => {
                const next = { ...prev };
                if (primarySucceeded && primaryDirty) {
                    delete next.html; delete next.css; delete next.js;
                }
                for (const p of savedExtras) delete next[`extra:${p}`];
                return next;
            });
        }
        if (allSucceeded) {
            setSaveState('saved');
            setLastSavedAt(new Date());
        } else if (failedExtras.length > 0) {
            setSaveState('error');
        }
    }, [api, extraContentsRef, isCurrent]);

    const cancelScheduled = useCallback(() => {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    }, []);

    // Single owner of the debounce timer. The id captured at schedule time is
    // re-checked against the currently guarded page at fire time.
    const scheduleSave = useCallback(() => {
        const scheduledId = activeIdRef.current;
        if (!scheduledId) return;
        cancelScheduled();
        timerRef.current = setTimeout(() => {
            timerRef.current = null;
            if (!isCurrent(scheduledId)) return;
            persist();
        }, debounceMs);
    }, [cancelScheduled, isCurrent, persist, debounceMs]);

    // Flush now: Cmd/Ctrl+S, leaving the page, zipping. Cancels the pending
    // debounce so the same edit is not saved twice.
    const flushNow = useCallback(() => {
        cancelScheduled();
        return persist();
    }, [cancelScheduled, persist]);

    // Defensive re-baseline. The editor is keyed on the webpage id, so in
    // practice a different page means a fresh hook instance and this never
    // fires. If a later refactor drops that key, the stale `dirtyExtrasRef`
    // would PUT the PREVIOUS page's extra-file contents to the NEW page's
    // `/:id/files` — a cross-page write, not just a redundant save. Treat the
    // incoming content as the new page's saved state instead, and drop every
    // marker that belonged to the page we just left.
    //
    // Declared BEFORE the content effect below so the `skipNextSaveRef` it
    // arms is consumed by that effect in the same commit.
    const prevIdRef = useRef(webpageId);
    useEffect(() => {
        if (prevIdRef.current === webpageId) return;
        prevIdRef.current = webpageId;
        cancelScheduled();
        lastSavedSnapshotRef.current = { html, css, js };
        skipNextSaveRef.current = true;
        dirtyExtrasRef.current = new Set();
        setDirtyFiles({});
        setSaveState('idle');
        setLastSavedAt(null);
    }, [webpageId, html, css, js, cancelScheduled]);

    useEffect(() => {
        if (!webpageId) return undefined;
        if (skipNextSaveRef.current) {
            skipNextSaveRef.current = false;
            return undefined;
        }
        scheduleSave();
        return cancelScheduled;
    }, [html, css, js, webpageId, scheduleSave, cancelScheduled]);

    // Mark a primary slot dirty when the user types into Monaco. SSE-driven
    // updates (AI edits) bypass this so they don't mark already-saved content
    // as dirty — the content effect above still schedules the save.
    const markPrimaryDirty = useCallback((slot) => {
        setDirtyFiles(prev => prev[slot] ? prev : { ...prev, [slot]: true });
    }, []);

    // User-initiated edit of an extra text file: mark the path dirty and
    // schedule a save. SSE-driven extra updates are already persisted
    // server-side and must NOT go through here.
    const markExtraDirty = useCallback((path) => {
        dirtyExtrasRef.current.add(path);
        const key = `extra:${path}`;
        setDirtyFiles(prev => prev[key] ? prev : { ...prev, [key]: true });
        scheduleSave();
    }, [scheduleSave]);

    // The server just handed us content that IS the saved state (a restored
    // version). Re-baseline and skip the content effect that the caller's
    // setHtml/setCss/setJs is about to trigger.
    const acceptServerSnapshot = useCallback((files) => {
        lastSavedSnapshotRef.current = {
            html: files?.html || '', css: files?.css || '', js: files?.js || '',
        };
        skipNextSaveRef.current = true;
    }, []);

    return {
        saveState,
        lastSavedAt,
        dirtyFiles,
        contentRef,
        persist,
        scheduleSave,
        flushNow,
        cancelScheduled,
        markPrimaryDirty,
        markExtraDirty,
        acceptServerSnapshot,
    };
}

/**
 * useWebpageChatPersistence — the chat is the source of truth on the client.
 * Whenever it changes AND we're not mid-stream (chatLoading=false), the full
 * message array is debounce-saved to `PUT /:id/chat`. The no-op case where
 * the chat matches what was last persisted is skipped, so hydrating the
 * loaded history (`markSaved(messages)` BEFORE handing it to the engine)
 * never triggers a PUT.
 *
 * Returns `{ markSaved, clearOnServer }`; `clearOnServer` is "New chat":
 * one DELETE with no trailing PUT (the empty array is marked saved first).
 */
export function useWebpageChatPersistence({ webpageId, chatMessages, chatLoading, api, debounceMs = CHAT_SAVE_DEBOUNCE_MS }) {
    const lastSavedChatRef = useRef('[]');
    const timerRef = useRef(null);

    useEffect(() => {
        if (!webpageId) return undefined;
        // Don't save mid-stream — wait for the assistant turn to settle so
        // we save the final shape rather than the partial streaming state.
        if (chatLoading) return undefined;
        const serialized = JSON.stringify(chatMessages || []);
        if (serialized === lastSavedChatRef.current) return undefined;

        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(async () => {
            timerRef.current = null;
            try {
                await api(`/${webpageId}/chat`, {
                    method: 'PUT',
                    body: JSON.stringify({ messages: chatMessages || [] }),
                });
                lastSavedChatRef.current = serialized;
            } catch (err) {
                console.warn('[Webpages] Chat save failed:', err.message);
            }
        }, debounceMs);
        return () => {
            if (timerRef.current) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
        };
    }, [chatMessages, chatLoading, webpageId, api, debounceMs]);

    const markSaved = useCallback((messages) => {
        lastSavedChatRef.current = JSON.stringify(Array.isArray(messages) ? messages : []);
    }, []);

    const clearOnServer = useCallback(async () => {
        if (!webpageId) return;
        // Mark the empty array as "saved" so the debounced effect doesn't
        // also fire a PUT a moment later — DELETE is enough.
        markSaved([]);
        try {
            await api(`/${webpageId}/chat`, { method: 'DELETE' });
        } catch (err) {
            console.warn('[Webpages] Chat clear failed:', err.message);
        }
    }, [api, webpageId, markSaved]);

    return { markSaved, clearOnServer };
}
