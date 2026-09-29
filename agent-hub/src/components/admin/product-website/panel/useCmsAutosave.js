// Debounced auto-save pipeline of the ProductWebsitePanel container —
// moved verbatim from ProductWebsitePanel.jsx. All state/refs are owned by
// the panel (threaded in as arguments); this hook only groups the save
// callbacks + lifecycle effects.
import { useCallback, useEffect } from 'react';
import { authFetch } from '../../../../utils/helpers';
import { toast } from '../../../shared/Toast';
import { cmsApi } from '../cmsApi';

export default function useCmsAutosave({
    activeSiteIdRef, builderRunningRef, pendingSaves, saveTimerRef, saveStatusTimer,
    inFlightSaveRef, failedSavesRef, setSaveStatus, setError, setDirtySincePublish,
}) {
    // ── auto-save (debounced) ────────────────────────────────────────

    const flushSaves = useCallback(async () => {
        // Read from the ref so debounced timers always target whichever
        // site was active when scheduleSave queued the work — switching
        // sites flushes pending saves BEFORE updating the ref, so the
        // edits land on the correct site even mid-switch.
        const siteId = activeSiteIdRef.current;
        // Merge any prior failed batch back in so a retry includes
        // everything the user thought they saved. Newer edits in
        // pendingSaves win on key collisions.
        const batch = { ...(failedSavesRef.current || {}), ...pendingSaves.current };
        if (!siteId || Object.keys(batch).length === 0) {
            inFlightSaveRef.current = null;
            return true; // nothing to save == success (callers gate publish on this)
        }
        pendingSaves.current = {};
        failedSavesRef.current = null;
        setSaveStatus('saving');
        try {
            const tasks = Object.entries(batch).map(([key, payload]) => {
                // Per-locale translation overrides — namespaced keys so they
                // ride the same debounce/retry machinery as base saves without
                // colliding (real keys are 'site' or a pg_… id, never 'locale:').
                if (key.startsWith('locale:site:')) {
                    const locale = key.slice('locale:site:'.length);
                    return authFetch(cmsApi.siteLocaleOverride(siteId, locale), {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ override: payload }),
                    });
                }
                if (key.startsWith('locale:page:')) {
                    const rest = key.slice('locale:page:'.length);
                    const at = rest.lastIndexOf(':');       // pageId may contain no ':'
                    const pageId = rest.slice(0, at);
                    const locale = rest.slice(at + 1);
                    return authFetch(cmsApi.pageLocaleOverride(siteId, pageId, locale), {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ override: payload }),
                    });
                }
                if (key === 'site') {
                    return authFetch(cmsApi.site(siteId), {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ site: payload }),
                    });
                }
                return authFetch(cmsApi.page(siteId, key), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ page: payload }),
                });
            });
            const results = await Promise.all(tasks);
            let droppedTotal = 0;
            for (const r of results) {
                const d = await r.json().catch(() => ({}));
                if (!r.ok) throw new Error(d.error || `Save failed (${r.status})`);
                // The server strips unknown-type blocks on save; surface it so
                // an edited/AI block silently vanishing doesn't look like a
                // "my change didn't stick" bug.
                if (Array.isArray(d?.dropped)) droppedTotal += d.dropped.length;
            }
            if (droppedTotal > 0) {
                toast.error(`${droppedTotal} block(s) weren't saved — unrecognized block type. Use a supported block or the "Download example" template.`);
            }
            setSaveStatus('saved');
            setDirtySincePublish(true); // the draft now differs from the last publish
            if (saveStatusTimer.current) clearTimeout(saveStatusTimer.current);
            saveStatusTimer.current = setTimeout(() => setSaveStatus('idle'), 1800);
            return true;
        } catch (err) {
            // Keep the batch so the user can retry without retyping.
            failedSavesRef.current = batch;
            setError(err.message);
            setSaveStatus('error');
            toast.error(`Save failed: ${err.message}`);
            return false; // let callers (publish) know the drain didn't land
        } finally {
            inFlightSaveRef.current = null;
        }
    }, [activeSiteIdRef, failedSavesRef, pendingSaves, inFlightSaveRef, setSaveStatus, setDirtySincePublish, saveStatusTimer, setError]);

    const scheduleSave = useCallback((key, payload) => {
        if (builderRunningRef.current) {
            // Stream lock: a human write raced the AI turn past the UI locks.
            // Dropping it is deliberate — the next draft event would overwrite
            // it anyway; the toast tells the user why nothing stuck.
            console.warn('[cms] edit dropped — AI turn in progress', key);
            toast.error('The AI assistant is editing — press Stop in the assistant to take over.');
            return;
        }
        pendingSaves.current[key] = payload;
        setSaveStatus('dirty');
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
            saveTimerRef.current = null;
            // Track the Promise so handlePublish can await it. Without this
            // ref, an in-flight save races the publish POST: the publish
            // reads the DB before the PUT lands, and the snapshot misses
            // the latest edits.
            inFlightSaveRef.current = flushSaves();
        }, 800);
    }, [builderRunningRef, pendingSaves, setSaveStatus, saveTimerRef, inFlightSaveRef, flushSaves]);

    useEffect(() => () => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        if (saveStatusTimer.current) clearTimeout(saveStatusTimer.current);
        // Flush any queued edit on unmount (e.g. SPA-navigating away from the
        // CMS within the 800ms debounce) so it isn't lost with the component.
        if (Object.keys(pendingSaves.current).length > 0 || failedSavesRef.current) {
            flushSaves();
        }
    }, [flushSaves, failedSavesRef, pendingSaves, saveStatusTimer, saveTimerRef]);

    // Warn + best-effort flush when leaving the page with unsaved edits. The
    // debounced PUT can be up to 800ms behind the last keystroke, so closing
    // the tab / hard-reloading mid-debounce would otherwise lose it silently.
    // This panel was the only autosave surface in the app without the guard.
    useEffect(() => {
        const hasUnsaved = () =>
            Object.keys(pendingSaves.current).length > 0
            || !!failedSavesRef.current
            || !!inFlightSaveRef.current
            || !!saveTimerRef.current;
        const onBeforeUnload = (e) => {
            if (!hasUnsaved()) return undefined;
            try { flushSaves(); } catch { /* browsers keep the request alive briefly on unload */ }
            e.preventDefault();
            e.returnValue = ''; // triggers the native "unsaved changes" prompt
            return '';
        };
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, [flushSaves, failedSavesRef, inFlightSaveRef, pendingSaves, saveTimerRef]);

    // Re-flush the failed batch held by flushSaves. Bound to the Retry
    // button in SaveBadge; no-op unless the most recent flush errored.
    const retrySave = useCallback(() => {
        if (!failedSavesRef.current) return;
        inFlightSaveRef.current = flushSaves();
    }, [flushSaves, failedSavesRef, inFlightSaveRef]);

    // Drain any pending debounced saves before an action that triggers a
    // reloadPayload — otherwise the reload overwrites local state with what
    // the DB has, and the user's in-flight edit blinks out of the UI while
    // the timer is still on its way to writing it. Called from savePageMeta
    // and the page CRUD handlers (add/duplicate/delete/setHomepage).
    const drainPendingSaves = useCallback(async () => {
        if (saveTimerRef.current) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
        }
        if (inFlightSaveRef.current) {
            await inFlightSaveRef.current.catch(() => {});
        }
        if (Object.keys(pendingSaves.current).length > 0) {
            inFlightSaveRef.current = flushSaves();
            await inFlightSaveRef.current;
        }
    }, [flushSaves, inFlightSaveRef, pendingSaves, saveTimerRef]);

    return { scheduleSave, flushSaves, retrySave, drainPendingSaves };
}
