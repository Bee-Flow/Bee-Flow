// Page SEO / meta editors (inline in panel, not via iframe) of the
// ProductWebsitePanel container — moved verbatim from ProductWebsitePanel.jsx.
import { useCallback, type MutableRefObject } from 'react';
import { authFetch } from '../../../../utils/helpers';
import { toast } from '../../../shared/Toast';
import { cmsApi } from '../cmsApi';
import type { CmsPageDoc } from './cmsPanelTypes';
import type { SaveStatus } from '../shell/SaveBadge';

export interface UseCmsPageMetaArgs {
    activePage: { id: string } | null | undefined;
    updatePage: (pageId: string, updater: (p: CmsPageDoc) => CmsPageDoc) => void;
    activeSiteIdRef: MutableRefObject<string | null | undefined>;
    builderRunningRef: MutableRefObject<boolean>;
    drainPendingSaves: () => Promise<void>;
    setSaveStatus: (status: SaveStatus) => void;
    setDirtySincePublish: (dirty: boolean) => void;
    saveStatusTimer: MutableRefObject<ReturnType<typeof setTimeout> | null | undefined>;
    reloadPayload: () => Promise<unknown>;
    setError: (message: string) => void;
}

export default function useCmsPageMeta({
    activePage, updatePage, activeSiteIdRef, builderRunningRef, drainPendingSaves,
    setSaveStatus, setDirtySincePublish, saveStatusTimer, reloadPayload, setError,
}: UseCmsPageMetaArgs) {
    // ── page SEO / meta editor (inline in panel, not via iframe) ────

    // SEO fields live on the PageDoc, so they flow through the regular
    // PUT /admin/pages/:id auto-save path.
    const updatePageSeo = useCallback((field: string, value: unknown) => {
        if (!activePage) return;
        updatePage(activePage.id, p => ({ ...p, seo: { ...((p.seo as Record<string, unknown>) || {}), [field]: value } }));
    }, [activePage, updatePage]);

    // Meta fields (title, slug, hideHeader, hideFooter, isNotFound) live on
    // the site index entry — NOT on the PageDoc — so they need the dedicated
    // /meta endpoint, which updates both the index and the PageDoc title/slug
    // atomically. PUT /admin/pages/:id (setPage) would silently drop
    // hideHeader/hideFooter and leave the site index out of sync.
    const savePageMeta = useCallback(async (pageId: string, patch: Record<string, unknown>) => {
        const siteId = activeSiteIdRef.current;
        if (!siteId) return;
        if (builderRunningRef.current) { toast.error('The AI assistant is editing — press Stop in the assistant to take over.'); return; }
        // Drain debounced edits first — otherwise the reloadPayload() below
        // would overwrite local state with stale DB content while the
        // user's pending block edit is still on its way out.
        await drainPendingSaves();
        setSaveStatus('saving');
        try {
            const res = await authFetch(cmsApi.pageMeta(siteId, pageId), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(patch),
            });
            if (!res.ok) {
                const d = await res.json().catch(() => ({})) as { error?: string };
                throw new Error(d.error || `Save failed (${res.status})`);
            }
            setSaveStatus('saved');
            setDirtySincePublish(true);
            if (saveStatusTimer.current) clearTimeout(saveStatusTimer.current);
            saveStatusTimer.current = setTimeout(() => setSaveStatus('idle'), 1800);
            await reloadPayload();
        } catch (err) {
            const message = (err as Error).message;
            setError(message);
            setSaveStatus('error');
            toast.error(`Save failed: ${message}`);
        }
    }, [drainPendingSaves, activeSiteIdRef, builderRunningRef, reloadPayload, saveStatusTimer, setDirtySincePublish, setError, setSaveStatus]);

    const updatePageMeta = useCallback((field: string, value: unknown) => {
        if (!activePage) return;
        savePageMeta(activePage.id, { [field]: value });
    }, [activePage, savePageMeta]);

    return { updatePageSeo, savePageMeta, updatePageMeta };
}
