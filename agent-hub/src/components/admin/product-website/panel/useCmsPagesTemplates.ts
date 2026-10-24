// Page CRUD (server round-trips), payload reload + page templates of the
// ProductWebsitePanel container — moved verbatim from ProductWebsitePanel.jsx.
// State stays owned by the panel (threaded in as arguments).
import { useCallback, useEffect, type Dispatch, type SetStateAction } from 'react';
import { authFetch } from '../../../../utils/helpers';
import { toast } from '../../../shared/Toast';
import { cmsApi } from '../cmsApi';
import { exportPage as exportPageToFile, type ImportPayload } from '../pageIO';
import { HEADER_VIRTUAL_ID } from '../sentinels';
import type { CmsLocale, CmsLocaleOverrides, CmsPageDoc, CmsPageIndexEntry, CmsSiteDoc } from './cmsPanelTypes';
import type { CmsTemplateSummary } from './useCmsPanelState';
import { logger } from '../../../../utils/logger';
import { request, RefusedError, errorBody, mutate } from '../../../../api/mutate';

/** The template-save dialog's page: the page plus the blocks resolved for it. */
type PendingTemplatePage = { id: string; blocks?: unknown[]; [key: string]: unknown };

interface UseCmsPagesTemplatesArgs {
    activeSiteIdRef: { current: string | null };
    drainPendingSaves: () => Promise<void>;
    setActivePageId: (id: string | null) => void;
    pages: CmsPageDoc[];
    updatePage: (pageId: string, fn: (p: CmsPageDoc) => CmsPageDoc) => void;
    confirm: (opts: { title: string; description: string; confirmLabel: string; destructive: boolean }) => Promise<boolean>;
    historyResetRef: { current: () => void };
    setSiteDoc: Dispatch<SetStateAction<CmsSiteDoc | null>>;
    setPages: Dispatch<SetStateAction<CmsPageDoc[]>>;
    locales: CmsLocale[];
    setLocales: Dispatch<SetStateAction<CmsLocale[]>>;
    setLocaleOverrides: Dispatch<SetStateAction<CmsLocaleOverrides>>;
    setPublishedAt: Dispatch<SetStateAction<string | null>>;
    setDirtySincePublish: Dispatch<SetStateAction<boolean>>;
    pendingSaves: { current: Record<string, unknown> };
    inFlightSaveRef: { current: unknown };
    builderRunningRef: { current: boolean };
    saveStatus: string;
    setTemplates: Dispatch<SetStateAction<CmsTemplateSummary[]>>;
    pendingTemplatePage: PendingTemplatePage | null;
    setPendingTemplatePage: Dispatch<SetStateAction<PendingTemplatePage | null>>;
}

export default function useCmsPagesTemplates({
    activeSiteIdRef, drainPendingSaves, setActivePageId, pages, updatePage, confirm,
    historyResetRef, setSiteDoc, setPages, locales, setLocales, setLocaleOverrides,
    setPublishedAt, setDirtySincePublish, pendingSaves, inFlightSaveRef,
    builderRunningRef, saveStatus, setTemplates, pendingTemplatePage, setPendingTemplatePage,
}: UseCmsPagesTemplatesArgs) {
    const reloadPayload = useCallback(async () => {
        const siteId = activeSiteIdRef.current;
        if (!siteId) return;
        let res: Response;
        try {
            res = await request(cmsApi.site(siteId));
        } catch (err) {
            if (!(err instanceof RefusedError)) throw err;
            return;
        }
        const data = await res.json();
        // Re-check guards AFTER the round-trip: the user may have switched
        // sites or started a new edit while this GET was in flight. Applying a
        // now-stale server payload here would yank state out from under a live
        // edit (the classic "my change reverted"). The call-site guards run
        // before the fetch, so this is the only race-free place to bail.
        if (activeSiteIdRef.current !== siteId) return;            // site switched mid-fetch
        if (Object.keys(pendingSaves.current).length > 0) return;   // new local edits queued
        if (inFlightSaveRef.current) return;                        // a save is racing
        if (builderRunningRef.current) return;                      // AI turn owns the state
        setSiteDoc(data.site || null);
        setPages(data.pages || []);
        setLocales(data.locales || locales);
        setLocaleOverrides(data.localeOverrides || { siteByLocale: {}, pagesByLocale: {} });
        if (data.publishedAt !== undefined) setPublishedAt(data.publishedAt || null);
        historyResetRef.current(); // server-confirmed load — undo across it would clobber
    }, [locales, activeSiteIdRef, pendingSaves, inFlightSaveRef, builderRunningRef, setSiteDoc, setPages, setLocales, setLocaleOverrides, setPublishedAt, historyResetRef]);

    // ── page CRUD (round-trips — no optimistic debounce needed here) ─

    // Creates a page on the active site. Returns { id, slug, title } so
    // callers (e.g. the LinkField "Create new page…" picker) can immediately
    // point a link at the freshly-created page without round-tripping
    // through the page list. Callers that initiated from PageList (the
    // default) get the new page focused in the side panel; callers from
    // inside a picker pass `{ keepActive: true }` to stay where they were.
    const handleAddPage = useCallback(async ({ title, slug, templateId }: { title?: string; slug?: string; templateId?: string } = {}, options: { keepActive?: boolean } = {}) => {
        const siteId = activeSiteIdRef.current;
        if (!siteId) return null;
        await drainPendingSaves();
        try {
            const res = await authFetch(cmsApi.pages(siteId), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title, slug, templateId }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to create page');
            // Reload full payload so site index + page doc are consistent.
            await reloadPayload();
            if (!options.keepActive) setActivePageId(data.id);
            return { id: data.id, slug: data.slug, title: title || data.slug };
        } catch (err) {
            toast.error(`Failed to create page: ${(err as Error).message}`);
            // Rethrow so picker callers can surface the error inline
            // instead of silently swallowing it.
            throw err;
        }
    }, [activeSiteIdRef, drainPendingSaves, reloadPayload, setActivePageId]);

    const handleDuplicatePage = useCallback(async (pageId: string) => {
        const siteId = activeSiteIdRef.current;
        if (!siteId) return;
        await drainPendingSaves();
        try {
            const res = await authFetch(cmsApi.pages(siteId), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ copyFromId: pageId }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to duplicate page');
            await reloadPayload();
            setActivePageId(data.id);
            setDirtySincePublish(true);
        } catch (err) { toast.error(`Failed to duplicate page: ${(err as Error).message}`); }
    }, [activeSiteIdRef, drainPendingSaves, reloadPayload, setActivePageId, setDirtySincePublish]);

    // Per-page export — bundles { meta, blocks } as a JSON download. Looks
    // up blocks from the full pages state (the site index in site.pages is
    // meta-only). Triggered from the row's actions menu.
    const handleExportPage = useCallback((pageId: string) => {
        const page = pages.find((p: CmsPageDoc) => p.id === pageId);
        if (!page) return;
        exportPageToFile(page);
    }, [pages]);

    // Per-page import — always creates a NEW page (never overwrites). Goes
    // through the existing create flow (so the server resolves slug
    // collisions by suffixing) and then patches the imported blocks in via
    // updatePage, which schedules the debounced PUT to persist them.
    const handleImportPage = useCallback(async (payload: ImportPayload | null | undefined) => {
        const incomingSlug  = (payload?.meta?.slug  || '').trim() || 'page';
        const incomingTitle = (payload?.meta?.title || '').trim() || incomingSlug;
        let created;
        try {
            created = await handleAddPage({ title: incomingTitle, slug: incomingSlug });
        } catch {
            return;
        }
        if (!created?.id) return;
        updatePage(created.id, (p: CmsPageDoc) => ({ ...p, blocks: Array.isArray(payload?.blocks) ? payload.blocks : [] }));
        // Surface what the importer had to normalize or drop — otherwise a
        // partial import looks like a silent success with missing sections.
        const droppedCount = Array.isArray(payload?.dropped) ? payload.dropped.length : 0;
        const warnCount = Array.isArray(payload?.warnings) ? payload.warnings.length : 0;
        if (droppedCount > 0) {
            const types = [...new Set(payload?.dropped?.map((d: { type?: string | null }) => (d.type == null ? '(no type)' : d.type)))];
            toast.error(`Imported "${incomingTitle}" — ${droppedCount} block(s) skipped (unrecognized type: ${types.join(', ')}).`);
        } else if (warnCount > 0) {
            toast.success(`Imported "${incomingTitle}" — ${warnCount} block(s) adjusted to the expected format.`);
        } else {
            toast.success(`Imported "${incomingTitle}".`);
        }
    }, [handleAddPage, updatePage]);

    const handleDeletePage = useCallback(async (pageId: string) => {
        const siteId = activeSiteIdRef.current;
        if (!siteId) return;
        const page = pages.find((p: CmsPageDoc) => p.id === pageId);
        const ok = await confirm({
            title: `Delete "${page?.title || 'this page'}"?`,
            description: 'The page and all of its blocks are permanently removed. This cannot be undone.',
            confirmLabel: 'Delete page',
            destructive: true,
        });
        if (!ok) return;
        await drainPendingSaves();
        try {
            const res = await authFetch(cmsApi.page(siteId, pageId), { method: 'DELETE' });
            if (!res.ok) { const d = await res.json(); throw new Error(d.error); }
            await reloadPayload();
            setActivePageId(HEADER_VIRTUAL_ID);
            setDirtySincePublish(true);
        } catch (err) {
            toast.error(`Failed to delete page: ${(err as Error).message}`);
        }
    }, [pages, confirm, activeSiteIdRef, drainPendingSaves, reloadPayload, setActivePageId, setDirtySincePublish]);

    const handleSetHomepage = useCallback(async (pageId: string) => {
        const siteId = activeSiteIdRef.current;
        if (!siteId) return;
        await drainPendingSaves();
        try {
            const res = await authFetch(cmsApi.pageHomepage(siteId, pageId), { method: 'PUT' });
            if (!res.ok) { const d = await res.json(); throw new Error(d.error); }
            await reloadPayload();
            setDirtySincePublish(true);
        } catch (err) { toast.error(`Failed to set homepage: ${(err as Error).message}`); }
    }, [activeSiteIdRef, drainPendingSaves, reloadPayload, setDirtySincePublish]);

    const handleReorderPages = useCallback(async (orderedIds: string[]) => {
        const siteId = activeSiteIdRef.current;
        if (!siteId) return;
        historyResetRef.current();
        try {
            // Optimistic: update site.pages order locally.
            setSiteDoc(prev => {
                if (!prev) return prev;
                const byId = new Map((prev.pages ?? []).map((p): [string, CmsPageIndexEntry] => [p.id, p]));
                return { ...prev, pages: orderedIds.map((id) => byId.get(id)).filter((p): p is CmsPageIndexEntry => Boolean(p)) };
            });
            const res = await authFetch(cmsApi.pagesOrder(siteId), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderedIds }),
            });
            if (!res.ok) { const d = await res.json(); throw new Error(d.error); }
            setDirtySincePublish(true);
        } catch (err) { toast.error(`Failed to reorder pages: ${(err as Error).message}`); }
    }, [activeSiteIdRef, historyResetRef, setDirtySincePublish, setSiteDoc]);

    // Refetch latest payload when the tab regains focus, so opening the CMS
    // after a break (or after editing in another tab) shows current content
    // instead of the cached snapshot from initial mount. Guarded against any
    // dirty/in-flight state so we never yank state out from under an edit.
    useEffect(() => {
        const onVisible = () => {
            if (document.visibilityState !== 'visible') return;
            if (saveStatus !== 'idle' && saveStatus !== 'saved') return;
            if (Object.keys(pendingSaves.current).length > 0) return;
            if (inFlightSaveRef.current) return;
            if (builderRunningRef.current) return;
            if (!activeSiteIdRef.current) return;
            reloadPayload();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => document.removeEventListener('visibilitychange', onVisible);
    }, [saveStatus, reloadPayload, activeSiteIdRef, builderRunningRef, inFlightSaveRef, pendingSaves]);

    // ── page templates (global, shared across sites) ──────────────────
    const refreshTemplates = useCallback(async () => {
        try {
            let res: Response;
            try {
                res = await request(cmsApi.templates());
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                return;
            }
            const data = await res.json();
            setTemplates(Array.isArray(data.templates) ? data.templates : []);
        } catch (err) { logger.debug('non-fatal — manager + picker just stay empty', err); }
    }, [setTemplates]);

    // Initial load — runs once when the panel mounts. Templates are
    // org-wide so they don't need to re-fetch on site switches.
    useEffect(() => { refreshTemplates(); }, [refreshTemplates]);

    // Resolve the page's blocks BEFORE opening the dialog. The panel's
    // `pages` state caches every PageDoc for the active site, so the
    // currently active page is always there. Pages from another site
    // (or freshly imported sites that haven't been touched yet) get a
    // fallback fetch so the dialog never opens with `undefined` blocks.
    // Empty arrays are refused too — the saved template would otherwise
    // be an unusable starter that the user can't tell apart from a real
    // save until they try to apply it.
    const handleSaveAsTemplate = useCallback(async (page: { id: string; }) => {
        if (!page?.id) return;
        const siteId = activeSiteIdRef.current;

        let blocks: unknown[] | null | undefined = pages.find((p: CmsPageDoc) => p.id === page.id)?.blocks;

        if (!Array.isArray(blocks) && siteId) {
            // Fallback — not in the local cache. Round-trip to fetch the
            // PageDoc so we never open the dialog without blocks.
            try {
                let res: Response;
                try {
                    res = await request(cmsApi.page(siteId, page.id));
                } catch (err) {
                    if (!(err instanceof RefusedError)) throw err;
                    const data = errorBody(err) ?? {};
                    throw new Error(data.error || 'Failed to load page');
                }
                const doc = await res.json();
                blocks = Array.isArray(doc?.blocks) ? doc.blocks : null;
            } catch (err) {
                console.error('[templates] failed to load page blocks', err);
                toast.error(`Couldn't load page blocks — ${(err as Error).message}`);
                return;
            }
        }

        if (!Array.isArray(blocks) || blocks.length === 0) {
            toast.error('This page has no blocks to save as a template.');
            return;
        }

        // Stash blocks alongside the page so submitTemplate doesn't have
        // to resolve them a second time (and can't drift if `pages`
        // re-renders between the dialog opening and the user confirming).
        setPendingTemplatePage({ ...page, blocks });
    }, [pages, activeSiteIdRef, setPendingTemplatePage]);

    const submitTemplate = useCallback(async ({ name, description }: { name: string; description?: string }) => {
        const page = pendingTemplatePage;
        if (!page?.id) return;
        const blocks = Array.isArray(page.blocks) ? page.blocks : [];
        if (blocks.length === 0) {
            toast.error('No blocks resolved — can\'t save an empty template.');
            return;
        }
        try {
            let res: Response;
            try {
                res = await mutate(cmsApi.templates(), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, description, blocks }),
            });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const data = errorBody(err) ?? {};
                throw new Error(data.error || `HTTP ${err.status}`);
            }
            const data = await res.json().catch(() => ({}));
            await refreshTemplates();
            setPendingTemplatePage(null);
            toast.success('Template saved');
        } catch (err) {
            console.error('[templates] save failed', err);
            toast.error('Failed to save template — check console');
            // No rethrow — the dialog's inner try/finally always resets
            // `saving` and the parent keeps `pendingTemplatePage` set so
            // the modal stays open for retry. Rethrowing would just
            // produce a duplicate unhandled-rejection log.
        }
    }, [pendingTemplatePage, refreshTemplates, setPendingTemplatePage]);


    const handleDeleteTemplate = useCallback(async (id: string) => {
        try {
            let res: Response;
            try {
                res = await mutate(cmsApi.template(id), { method: 'DELETE' });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const data = errorBody(err) ?? {};
                throw new Error(data.error || `HTTP ${err.status}`);
            }
            const data = await res.json().catch(() => ({}));
            await refreshTemplates();
            toast.success('Template deleted');
        } catch (err) {
            console.error('[templates] delete failed', err);
            toast.error('Failed to delete template — check console');
        }
    }, [refreshTemplates]);

    return {
        handleAddPage, handleDuplicatePage, handleExportPage, handleImportPage,
        handleDeletePage, handleSetHomepage, handleReorderPages, reloadPayload,
        handleSaveAsTemplate, submitTemplate, handleDeleteTemplate,
    };
}
