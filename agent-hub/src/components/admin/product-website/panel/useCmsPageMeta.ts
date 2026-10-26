// Page SEO / meta editors (inline in panel, not via iframe) of the
// ProductWebsitePanel container — moved verbatim from ProductWebsitePanel.jsx.
import { useCallback } from 'react';
import type { CmsActivePage, CmsPageDoc } from './cmsPanelTypes';
import type useCmsAutosave from './useCmsAutosave';
import type useCmsPanelState from './useCmsPanelState';
import { errorMessage, messageOf } from '@/utils/caughtError';
import { toast } from '@/components/shared/Toast';
import { cmsApi } from '../cmsApi';
import { noteSavedRev } from './cmsRevisions';
import { mutate, errorBody, RefusedError } from '@/api/mutate';

type PanelState = ReturnType<typeof useCmsPanelState>;

interface PageMetaInput extends Pick<PanelState, 'activeSiteIdRef' | 'builderRunningRef' | 'setSaveStatus' | 'setDirtySincePublish' | 'saveStatusTimer' | 'setError'> {
    activePage: CmsActivePage | null;
    updatePage: (pageId: string, fn: (page: CmsPageDoc) => CmsPageDoc) => void;
    drainPendingSaves: ReturnType<typeof useCmsAutosave>['drainPendingSaves'];
    reloadPayload: () => Promise<unknown>;
}

export default function useCmsPageMeta({
    activePage, updatePage, activeSiteIdRef, builderRunningRef, drainPendingSaves,
    setSaveStatus, setDirtySincePublish, saveStatusTimer, reloadPayload, setError,
}: PageMetaInput) {
    // ── page SEO / meta editor (inline in panel, not via iframe) ────

    // SEO fields live on the PageDoc, so they flow through the regular
    // PUT /admin/pages/:id auto-save path.
    const updatePageSeo = useCallback((field: string, value: unknown) => {
        if (!activePage) return;
        updatePage(activePage.id, p => ({ ...p, seo: { ...(p.seo || {}), [field]: value } }));
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
            let res: Response;
            try {
                res = await mutate(cmsApi.pageMeta(siteId, pageId), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(patch),
            });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const d = errorBody(err) ?? {};
                throw new Error(d.error || `Save failed (${err.status})`);
            }
            // A slug/title change raises the PageDoc's revision: the next block save must name it.
            const answer: unknown = await res.json().catch(() => null);
            if (typeof answer === 'object' && answer !== null && 'pageRev' in answer) noteSavedRev(siteId, pageId, answer.pageRev);
            setSaveStatus('saved');
            setDirtySincePublish(true);
            if (saveStatusTimer.current) clearTimeout(saveStatusTimer.current);
            saveStatusTimer.current = setTimeout(() => setSaveStatus('idle'), 1800);
            await reloadPayload();
        } catch (err) {
            setError(messageOf(err, ''));
            setSaveStatus('error');
            toast.error(`Save failed: ${errorMessage(err)}`);
        }
    }, [drainPendingSaves, activeSiteIdRef, builderRunningRef, reloadPayload, saveStatusTimer, setDirtySincePublish, setError, setSaveStatus]);

    const updatePageMeta = useCallback((field: string, value: unknown) => {
        if (!activePage) return;
        savePageMeta(activePage.id, { [field]: value });
    }, [activePage, savePageMeta]);

    return { updatePageSeo, savePageMeta, updatePageMeta };
}
