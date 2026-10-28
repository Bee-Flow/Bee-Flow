// Debounced auto-save pipeline of the ProductWebsitePanel container —
// moved verbatim from ProductWebsitePanel.jsx. All state/refs are owned by
// the panel (threaded in as arguments); this hook only groups the save
// callbacks + lifecycle effects.
import { useCallback, useEffect, useRef } from 'react';
import type useCmsPanelState from './useCmsPanelState';
import { messageOf, errorMessage } from '@/utils/caughtError';
import type { AuthFetchOptions } from '@/utils/helpers';
import { settled } from '@/api/settled';
import { toast } from '@/components/shared/Toast';
import { cmsApi } from '../cmsApi';
import { adoptRealignedOverrides } from './realignedOverrides';
import { CONFLICT_CODE, SaveConflictError, noteSavedRev, revisionFor, storedRev, withRev } from './cmsRevisions';
import { logger } from '@/utils/logger';

type PanelState = ReturnType<typeof useCmsPanelState>;


interface AutosaveInput extends Pick<PanelState,
    'activeSiteIdRef' | 'builderRunningRef' | 'pendingSaves' | 'saveTimerRef' | 'saveStatusTimer'
    | 'inFlightSaveRef' | 'failedSavesRef' | 'setSaveStatus' | 'setError' | 'setDirtySincePublish'
    | 'localeOverridesRef' | 'setLocaleOverrides'> {}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * One queued save as its request. Per-locale translation overrides use
 * namespaced keys so they ride the same debounce/retry machinery as base saves
 * without colliding (real keys are 'site' or a pg_… id, never 'locale:').
 */
/** One save's answer: whether the server took it, its status, and its JSON body ({} when it had none). */
interface SaveAnswer { ok: boolean; status: number; d: SaveBody }
interface SaveBody { code?: string; error?: string; dropped?: unknown; mediaWarning?: unknown; localeOverrides?: unknown; [field: string]: unknown }

async function put(url: string, init: AuthFetchOptions): Promise<SaveAnswer> {
    const r = await settled(url, init, 'empty');
    if (!r.ok) return { ok: false, status: r.status, d: r.body };
    return { ok: true, status: r.res.status, d: await r.res.json().catch(() => ({})) };
}

function sendSave(siteId: string, key: string, payload: unknown, rev: number): Promise<SaveAnswer> {
    if (key.startsWith('locale:site:')) {
        const locale = key.slice('locale:site:'.length);
        return put(cmsApi.siteLocaleOverride(siteId, locale), {
            method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ override: payload }),
        });
    }
    if (key.startsWith('locale:page:')) {
        const rest = key.slice('locale:page:'.length);
        const at = rest.lastIndexOf(':');       // pageId may contain no ':'
        return put(cmsApi.pageLocaleOverride(siteId, rest.slice(0, at), rest.slice(at + 1)), {
            method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ override: payload }),
        });
    }
    if (key === 'site') {
        return put(cmsApi.site(siteId), {
            method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ site: withRev(payload, rev) }),
        });
    }
    return put(cmsApi.page(siteId, key), {
        method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ page: withRev(payload, rev) }),
    });
}

export default function useCmsAutosave({
    activeSiteIdRef, builderRunningRef, pendingSaves, saveTimerRef, saveStatusTimer,
    inFlightSaveRef, failedSavesRef, setSaveStatus, setError, setDirtySincePublish,
    localeOverridesRef, setLocaleOverrides,
}: AutosaveInput) {
    // The server re-aligns the stored translations when a page/site save
    // reorders items and returns them (locale -> override). Replace the
    // in-memory copy, or the next translation edit would write the old order
    // straight back. A locale with an edit still queued is left alone.
    const adoptRealigned = useCallback((scope: string, moved: unknown) => {
        const prefix = scope === 'site' ? 'locale:site:' : `locale:page:${scope}:`;
        const next = adoptRealignedOverrides(localeOverridesRef.current, scope, moved,
            (locale) => `${prefix}${locale}` in pendingSaves.current);
        if (next === localeOverridesRef.current) return;
        localeOverridesRef.current = next;
        setLocaleOverrides(next);
    }, [localeOverridesRef, pendingSaves, setLocaleOverrides]);

    // ── auto-save (debounced) ────────────────────────────────────────

    // Flushes run one after another: a second save must be based on the
    // revision the first one produced, so it may not start before that answer.
    const flushQueueRef = useRef<Promise<unknown>>(Promise.resolve());

    const performFlush = useCallback(async () => {
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
            const makeTask = ([key, payload]: [string, unknown]) => sendSave(siteId, key, payload, revisionFor(siteId, key, payload));
            // Translations first, content second: the content save re-aligns the
            // stored translations to a reordered list, so it must see them.
            const entries = Object.entries(batch);
            const isLocale = ([key]: [string, unknown]) => key.startsWith('locale:');
            const localeResults = await Promise.all(entries.filter(isLocale).map(makeTask));
            const contentEntries = entries.filter((e) => !isLocale(e));
            const contentResults = await Promise.all(contentEntries.map(makeTask));
            let droppedTotal = 0;
            let mediaWarning = '';
            let failure: Error | null = null;
            const resultKeys = [...entries.filter(isLocale), ...contentEntries].map(([key]) => key);
            for (const [i, r] of [...localeResults, ...contentResults].entries()) {
                const key = resultKeys[i];
                const idx = contentResults.indexOf(r);
                const d = r.d;
                if (!r.ok) {
                    // Keep reading the other answers: their revisions must still be recorded.
                    failure = failure ?? (r.status === 409 && d.code === CONFLICT_CODE
                        ? new SaveConflictError(d.error || 'Changed elsewhere. Reload to get the latest version.')
                        : new Error(d.error || `Save failed (${r.status})`));
                    continue;
                }
                if (idx >= 0) adoptRealigned(key, d?.localeOverrides);
                const rev = key === 'site' ? storedRev(d, 'site') : storedRev(d, 'page');
                if (!key.startsWith('locale:')) noteSavedRev(siteId, key, rev);
                // The server strips unknown-type blocks on save; surface it so
                // an edited/AI block silently vanishing doesn't look like a
                // "my change didn't stick" bug.
                if (Array.isArray(d?.dropped)) droppedTotal += d.dropped.length;
                // A translated media address the server refused: the default language shows instead.
                if (typeof d?.mediaWarning === 'string') mediaWarning = d.mediaWarning;
            }
            if (failure) throw failure;
            if (droppedTotal > 0) {
                toast.error(`${droppedTotal} block(s) weren't saved — unrecognized block type. Use a supported block or the "Download example" template.`);
            }
            if (mediaWarning) toast.error(mediaWarning);
            setSaveStatus('saved');
            setDirtySincePublish(true); // the draft now differs from the last publish
            if (saveStatusTimer.current) clearTimeout(saveStatusTimer.current);
            saveStatusTimer.current = setTimeout(() => setSaveStatus('idle'), 1800);
            return true;
        } catch (err) {
            // A conflict cannot be fixed by retrying the same bytes: the editor has to
            // be reloaded, so the batch is not kept for the Retry button.
            failedSavesRef.current = err instanceof SaveConflictError ? null : batch;
            setError(messageOf(err, ''));
            setSaveStatus('error');
            toast.error(`Save failed: ${errorMessage(err)}`);
            return false; // let callers (publish) know the drain didn't land
        } finally {
            inFlightSaveRef.current = null;
        }
    }, [activeSiteIdRef, failedSavesRef, pendingSaves, inFlightSaveRef, setSaveStatus, setDirtySincePublish, saveStatusTimer, setError, adoptRealigned]);

    const flushSaves = useCallback((): Promise<boolean> => {
        const run = flushQueueRef.current.then(performFlush);
        // performFlush answers false instead of throwing; the chain only has to wait for it.
        flushQueueRef.current = run.then(() => undefined, () => undefined);
        return run;
    }, [performFlush]);

    const scheduleSave = useCallback((key: string, payload: unknown) => {
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
        const onBeforeUnload = (e: BeforeUnloadEvent) => {
            if (!hasUnsaved()) return undefined;
            try { flushSaves(); } catch (err) { logger.debug('browsers keep the request alive briefly on unload', err); }
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
