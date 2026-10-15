// Site chrome/design/analytics mutators + live toggle, publish and
// default-locale switch of the ProductWebsitePanel container — moved
// verbatim from ProductWebsitePanel.jsx. State stays owned by the panel.
import { useCallback, type MutableRefObject } from 'react';
import { authFetch } from '../../../../utils/helpers';
import { mutate } from '../../../../api/mutate';
import { toast } from '../../../shared/Toast';
import { cmsApi } from '../cmsApi';
import { AI_LOCK_MSG } from './helpers';
import type { CmsLocale, CmsPageDoc, CmsSiteDoc, CmsSiteListEntry } from './cmsPanelTypes';
import type { CmsHistoryDraft } from './useCmsHistory';
import type { SaveBatch } from './useCmsAutosave';
import type { ConfirmFn } from './PanelSlots';

interface PublishResponse {
    publishedAt?: string;
    error?: string;
}

export interface UseCmsPublishingArgs {
    history: { commit: (draft: CmsHistoryDraft) => void };
    siteStateRef: MutableRefObject<CmsSiteDoc | null | undefined>;
    pagesStateRef: MutableRefObject<CmsPageDoc[]>;
    activeSiteId: string | null | undefined;
    activeSiteIdRef: MutableRefObject<string | null | undefined>;
    liveSiteId: string | null | undefined;
    setLiveSiteId: (id: string | null | undefined) => void;
    sites: CmsSiteListEntry[];
    confirm: ConfirmFn;
    builderRunningRef: MutableRefObject<boolean>;
    saveTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null | undefined>;
    inFlightSaveRef: MutableRefObject<Promise<boolean> | null | undefined>;
    failedSavesRef: MutableRefObject<SaveBatch | null | undefined>;
    flushSaves: () => Promise<boolean>;
    setPublishing: (publishing: boolean) => void;
    setPublishedAt: (publishedAt: string) => void;
    setDirtySincePublish: (dirty: boolean) => void;
    setError: (message: string) => void;
    locales: CmsLocale[];
    setDefaultLocale: (code: string) => void;
}

export default function useCmsPublishing({
    history, siteStateRef, pagesStateRef,
    activeSiteId, activeSiteIdRef, liveSiteId, setLiveSiteId, sites, confirm, builderRunningRef,
    saveTimerRef, inFlightSaveRef, failedSavesRef, flushSaves,
    setPublishing, setPublishedAt, setDirtySincePublish, setError,
    locales, setDefaultLocale,
}: UseCmsPublishingArgs) {
    // ── site chrome mutations ────────────────────────────────────────

    // The history object is rebuilt per render; its commit is a stable callback.
    const commitHistory = history.commit;
    const updateSiteChrome = useCallback((nextSite: CmsSiteDoc) => {
        commitHistory({ site: nextSite, pages: pagesStateRef.current });
    }, [commitHistory, pagesStateRef]);

    // Design changes route through the SAME pendingSaves['site'] slot as
    // chrome changes (via the history apply path), so a design edit followed
    // by a header edit (or vice versa) coalesces into ONE PUT carrying the
    // latest snapshot of both. Last-write-wins on the entire SiteDoc — no
    // separate /design endpoint, no race window.
    const updateDesign = useCallback((nextDesign: Record<string, unknown>) => {
        const prev = siteStateRef.current;
        if (!prev) return;
        commitHistory({ site: { ...prev, design: nextDesign }, pages: pagesStateRef.current });
    }, [commitHistory, siteStateRef, pagesStateRef]);

    // Analytics settings live on the site doc too — same coalesced
    // pendingSaves['site'] slot, same undo/redo history as chrome/design.
    const updateSiteAnalytics = useCallback((nextAnalytics: Record<string, unknown>) => {
        const prev = siteStateRef.current;
        if (!prev) return;
        commitHistory({ site: { ...prev, analytics: nextAnalytics }, pages: pagesStateRef.current });
    }, [commitHistory, siteStateRef, pagesStateRef]);

    // ── top-level toggles ────────────────────────────────────────────

    // Toggle whether *this* site (activeSiteId) is the live one. Only one
    // project can be live at a time; when another site is currently live
    // the user must confirm taking it offline before this one goes live.
    const persistLive = async (next: boolean) => {
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
                toast.error((err as Error).message);
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
                toast.error((err as Error).message);
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
            const data = await res.json().catch(() => ({})) as PublishResponse;
            if (!res.ok) throw new Error(data.error || `Publish failed (${res.status})`);
            setPublishedAt(data.publishedAt || new Date().toISOString());
            setDirtySincePublish(false);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setPublishing(false);
        }
    }, [flushSaves, activeSiteIdRef, builderRunningRef, failedSavesRef, inFlightSaveRef, saveTimerRef, setDirtySincePublish, setError, setPublishedAt, setPublishing]);

    // "Set as default locale" — an org-wide switch of the site's source
    // language; consequential enough to confirm (it flips translate mode).
    const handleSetDefaultLocale = async (code: string) => {
        const name = locales.find(l => l.code === code)?.name || code;
        const ok = await confirm({
            title: `Make ${name} the default locale?`,
            description: 'The default locale is the source language: pages are authored in it, and other languages translate from it.',
            confirmLabel: 'Set default',
        });
        if (!ok) return;
        await persistDefaultLocale(code);
    };

    const persistDefaultLocale = async (next: string) => {
        setDefaultLocale(next);
        try {
            await mutate(cmsApi.defaultLocale(), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ locale: next }),
            });
        } catch (err) { toast.error(`Failed to set default locale: ${(err as Error).message}`); }
    };

    return {
        updateSiteChrome, updateDesign, updateSiteAnalytics,
        persistLive, handlePublish, handleSetDefaultLocale,
    };
}
