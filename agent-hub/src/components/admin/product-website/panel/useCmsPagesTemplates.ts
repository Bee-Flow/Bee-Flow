// Page CRUD (server round-trips), payload reload + page templates of the
// ProductWebsitePanel container — moved verbatim from ProductWebsitePanel.jsx.
// State stays owned by the panel (threaded in as arguments).
import { useCallback, useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { authFetch } from '../../../../utils/helpers';
import { toast } from '../../../shared/Toast';
import { cmsApi } from '../cmsApi';
import { exportPage as exportPageToFile, type ImportPageResult } from '../pageIO';
import { HEADER_VIRTUAL_ID } from '../sentinels';
import type { SaveStatus } from '../shell/SaveBadge';
import type { PageTemplate } from '../pageList/pageListShared';
import type { CmsBlock, CmsLocale, CmsLocaleOverrides, CmsPageDoc, CmsPageIndexEntry, CmsSiteDoc } from './cmsPanelTypes';
import type { SaveBatch } from './useCmsAutosave';
import type { ConfirmFn } from './PanelSlots';

interface PageDataResponse {
    site?: CmsSiteDoc | null;
    pages?: CmsPageDoc[];
    locales?: CmsLocale[];
    localeOverrides?: CmsLocaleOverrides;
    publishedAt?: string | null;
}

interface PageCreatedResponse {
    id: string;
    slug?: string;
    error?: string;
}

interface ImportPagePayload {
    meta?: { slug?: string; title?: string };
    blocks?: unknown[];
    dropped?: ImportPageResult['dropped'];
    warnings?: ImportPageResult['warnings'];
}

export interface UseCmsPagesTemplatesArgs {
    activeSiteIdRef: MutableRefObject<string | null | undefined>;
    drainPendingSaves: () => Promise<void>;
    setActivePageId: (id: string) => void;
    pages: CmsPageDoc[];
    updatePage: (pageId: string, updater: (p: CmsPageDoc) => CmsPageDoc) => void;
    confirm: ConfirmFn;
    historyResetRef: MutableRefObject<() => void>;
    setSiteDoc: Dispatch<SetStateAction<CmsSiteDoc | null | undefined>>;
    setPages: (pages: CmsPageDoc[]) => void;
    locales: CmsLocale[];
    setLocales: (locales: CmsLocale[]) => void;
    setLocaleOverrides: (overrides: CmsLocaleOverrides) => void;
    setPublishedAt: (publishedAt: string | null) => void;
    setDirtySincePublish: (dirty: boolean) => void;
    pendingSaves: MutableRefObject<SaveBatch>;
    inFlightSaveRef: MutableRefObject<Promise<boolean> | null | undefined>;
    builderRunningRef: MutableRefObject<boolean>;
    saveStatus: SaveStatus;
    setTemplates: (templates: PageTemplate[]) => void;
    pendingTemplatePage: CmsPageDoc | null;
    setPendingTemplatePage: (page: CmsPageDoc | null) => void;
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
        const res = await authFetch(cmsApi.site(siteId));
        if (!res.ok) return;
        const data = await res.json() as PageDataResponse;
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
    const handleAddPage = useCallback(async (
        { title, slug, templateId }: { title?: string; slug?: string; templateId?: string } = {},
        options: { keepActive?: boolean } = {},
    ) => {
        const siteId = activeSiteIdRef.current;
        if (!siteId) return null;
        await drainPendingSaves();
        try {
            const res = await authFetch(cmsApi.pages(siteId), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title, slug, templateId }),
            });
            const data = await res.json() as PageCreatedResponse;
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
            const data = await res.json() as PageCreatedResponse;
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
        const page = pages.find(p => p.id === pageId);
        if (!page) return;
        exportPageToFile(page);
    }, [pages]);

    // Per-page import — always creates a NEW page (never overwrites). Goes
    // through the existing create flow (so the server resolves slug
    // collisions by suffixing) and then patches the imported blocks in via
    // updatePage, which schedules the debounced PUT to persist them.
    const handleImportPage = useCallback(async (payload: ImportPagePayload | null | undefined) => {
        const incomingSlug  = (payload?.meta?.slug  || '').trim() || 'page';
        const incomingTitle = (payload?.meta?.title || '').trim() || incomingSlug;
        let created: Awaited<ReturnType<typeof handleAddPage>> | undefined = undefined;
        try {
            created = await handleAddPage({ title: incomingTitle, slug: incomingSlug });
        } catch {
            return;
        }
        if (!created?.id) return;
        updatePage(created.id, p => ({ ...p, blocks: Array.isArray(payload?.blocks) ? payload.blocks as CmsBlock[] : [] }));
        // Surface what the importer had to normalize or drop — otherwise a
        // partial import looks like a silent success with missing sections.
        const droppedCount = Array.isArray(payload?.dropped) ? payload.dropped.length : 0;
        const warnCount = Array.isArray(payload?.warnings) ? payload.warnings.length : 0;
        if (droppedCount > 0) {
            const types = [...new Set((payload?.dropped ?? []).map(d => (d.type == null ? '(no type)' : d.type)))];
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
        const page = pages.find(p => p.id === pageId);
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
            if (!res.ok) { const d = await res.json() as { error?: string }; throw new Error(d.error); }
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
            if (!res.ok) { const d = await res.json() as { error?: string }; throw new Error(d.error); }
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
                const byId = new Map<string, CmsPageIndexEntry>((prev.pages as CmsPageIndexEntry[]).map(p => [p.id, p] as const));
                return { ...prev, pages: orderedIds.map(id => byId.get(id)).filter((p): p is CmsPageIndexEntry => Boolean(p)) };
            });
            const res = await authFetch(cmsApi.pagesOrder(siteId), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderedIds }),
            });
            if (!res.ok) { const d = await res.json() as { error?: string }; throw new Error(d.error); }
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
            const res = await authFetch(cmsApi.templates());
            if (!res.ok) return;
            const data = await res.json() as { templates?: PageTemplate[] };
            setTemplates(Array.isArray(data.templates) ? data.templates : []);
        } catch { /* non-fatal — manager + picker just stay empty */ }
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
    const handleSaveAsTemplate = useCallback(async (page: CmsPageDoc | null | undefined) => {
        if (!page?.id) return;
        const siteId = activeSiteIdRef.current;

        let blocks: CmsBlock[] | null | undefined = pages.find(p => p.id === page.id)?.blocks;

        if (!Array.isArray(blocks) && siteId) {
            // Fallback — not in the local cache. Round-trip to fetch the
            // PageDoc so we never open the dialog without blocks.
            try {
                const res = await authFetch(cmsApi.page(siteId, page.id));
                if (!res.ok) {
                    const data = await res.json().catch(() => ({})) as { error?: string };
                    throw new Error(data.error || 'Failed to load page');
                }
                const doc = await res.json() as { blocks?: unknown };
                blocks = Array.isArray(doc?.blocks) ? doc.blocks as CmsBlock[] : null;
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
            const res = await authFetch(cmsApi.templates(), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, description, blocks }),
            });
            const data = await res.json().catch(() => ({})) as { error?: string };
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
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
            const res = await authFetch(cmsApi.template(id), { method: 'DELETE' });
            const data = await res.json().catch(() => ({})) as { error?: string };
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
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
