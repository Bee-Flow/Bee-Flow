// Site chrome/design/analytics mutators + live toggle, publish and
// default-locale switch of the ProductWebsitePanel container — moved
// verbatim from ProductWebsitePanel.jsx. State stays owned by the panel.
import { useCallback } from 'react';
import { authFetch } from '../../../../utils/helpers';
import { toast } from '../../../shared/Toast';
import { cmsApi } from '../cmsApi';
import { AI_LOCK_MSG } from './helpers';

export default function useCmsPublishing({
    history, siteStateRef, pagesStateRef,
    activeSiteId, activeSiteIdRef, liveSiteId, setLiveSiteId, sites, confirm, builderRunningRef,
    saveTimerRef, inFlightSaveRef, failedSavesRef, flushSaves,
    setPublishing, setPublishedAt, setDirtySincePublish, setError,
    locales, setDefaultLocale,
}) {
    // ── site chrome mutations ────────────────────────────────────────

    // The history object is rebuilt per render; its commit is a stable callback.
    const commitHistory = history.commit;
    const updateSiteChrome = useCallback((nextSite) => {
        commitHistory({ site: nextSite, pages: pagesStateRef.current });
    }, [commitHistory, pagesStateRef]);

    // Design changes route through the SAME pendingSaves['site'] slot as
    // chrome changes (via the history apply path), so a design edit followed
    // by a header edit (or vice versa) coalesces into ONE PUT carrying the
    // latest snapshot of both. Last-write-wins on the entire SiteDoc — no
    // separate /design endpoint, no race window.
    const updateDesign = useCallback((nextDesign) => {
        const prev = siteStateRef.current;
        if (!prev) return;
        commitHistory({ site: { ...prev, design: nextDesign }, pages: pagesStateRef.current });
    }, [commitHistory, siteStateRef, pagesStateRef]);

    // Analytics settings live on the site doc too — same coalesced
    // pendingSaves['site'] slot, same undo/redo history as chrome/design.
    const updateSiteAnalytics = useCallback((nextAnalytics) => {
        const prev = siteStateRef.current;
        if (!prev) return;
        commitHistory({ site: { ...prev, analytics: nextAnalytics }, pages: pagesStateRef.current });
    }, [commitHistory, siteStateRef, pagesStateRef]);

    // ── top-level toggles ────────────────────────────────────────────

    // Toggle whether *this* site (activeSiteId) is the live one. Only one
    // project can be live at a time; when another site is currently live
    // the user must confirm taking it offline before this one goes live.
    const persistLive = async (next) => {
        if (!activeSiteId) return;
        if (builderRunningRef.current) { toast.error(AI_LOCK_MSG); return; }
        if (next) {
            const otherLive = liveSiteId && liveSiteId !== activeSiteId
                ? sites.find(s => s.id === liveSiteId)
                : null;
            if (otherLive) {
                const ok = await confirm({
                    title: 'Move the live site?',
                    description: `"${otherLive.name}" is currently live. Setting this site live will take "${otherLive.name}" offline.`,
                    confirmLabel: 'Set live',
                });
                if (!ok) return;
            }
            setLiveSiteId(activeSiteId);
            try {
                const res = await authFetch(cmsApi.siteLive(activeSiteId), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ live: true }),
                });
                if (!res.ok) throw new Error(`Failed to set live (${res.status})`);
            } catch (err) {
                toast.error(err.message);
                setLiveSiteId(liveSiteId);   // roll back optimistic update
            }
        } else {
            setLiveSiteId(null);
            try {
                const res = await authFetch(cmsApi.siteLive(activeSiteId), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ live: false }),
                });
                if (!res.ok) throw new Error(`Failed to take site offline (${res.status})`);
            } catch (err) {
                toast.error(err.message);
                setLiveSiteId(liveSiteId);
            }
        }
    };

    // Publish — snapshot the current draft on the server. Drains pending
    // debounced saves first so in-flight edits land in the snapshot rather
    // than being captured by the next publish click. The public site
    // (/api/cms/site) reads from this snapshot.
    const handlePublish = useCallback(async () => {
        const siteId = activeSiteIdRef.current;
        if (!siteId) return;
        if (builderRunningRef.current) { toast.error(AI_LOCK_MSG); return; }
        // Drain any pending save in three steps:
        //   1. Cancel an unfired debounce timer (would re-queue work).
        //   2. Await any save the timer already started (in-flight PUTs).
        //   3. Run flushSaves once more to push anything queued since.
        if (saveTimerRef.current) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
        }
        if (inFlightSaveRef.current) {
            try { await inFlightSaveRef.current; } catch { /* error already surfaced */ }
            inFlightSaveRef.current = null;
        }
        const drainedOk = await flushSaves();
        // Never snapshot a site that still has unsaved edits — publishing here
        // would push stale content live while the UI shows "just published".
        // flushSaves already surfaced the save error and kept the retry batch.
        if (!drainedOk || failedSavesRef.current) {
            toast.error('Not published — some changes failed to save. Fix the error and retry.');
            return;
        }
        setPublishing(true);
        try {
            const res = await authFetch(cmsApi.sitePublish(siteId), { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `Publish failed (${res.status})`);
            setPublishedAt(data.publishedAt || new Date().toISOString());
            setDirtySincePublish(false);
        } catch (err) {
            setError(err.message);
        } finally {
            setPublishing(false);
        }
    }, [flushSaves, activeSiteIdRef, builderRunningRef, failedSavesRef, inFlightSaveRef, saveTimerRef, setDirtySincePublish, setError, setPublishedAt, setPublishing]);

    // "Set as default locale" — an org-wide switch of the site's source
    // language; consequential enough to confirm (it flips translate mode).
    const handleSetDefaultLocale = async (code) => {
        const name = locales.find(l => l.code === code)?.name || code;
        const ok = await confirm({
            title: `Make ${name} the default locale?`,
            description: 'The default locale is the source language: pages are authored in it, and other languages translate from it.',
            confirmLabel: 'Set default',
        });
        if (!ok) return;
        await persistDefaultLocale(code);
    };

    const persistDefaultLocale = async (next) => {
        setDefaultLocale(next);
        try {
            await authFetch(cmsApi.defaultLocale(), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ locale: next }),
            });
        } catch (err) { toast.error(`Failed to set default locale: ${err.message}`); }
    };

    return {
        updateSiteChrome, updateDesign, updateSiteAnalytics,
        persistLive, handlePublish, handleSetDefaultLocale,
    };
}
