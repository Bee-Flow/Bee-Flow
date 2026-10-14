import { useCallback, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { API_BASE, authFetch } from '../../../utils/helpers';
import type { WebpagePatch, WebpageRow } from '../webpageEditorTypes';

interface PublishingDeps {
    pageId: string;
    page: WebpageRow;
    setPage: Dispatch<SetStateAction<WebpageRow>>;
    onMetaChange?: (id: string, patch: WebpagePatch) => void;
    flushNow: () => Promise<unknown>;
    mountedRef: RefObject<boolean>;
    setError: (message: string | null) => void;
}

/**
 * Publishing (org / group visibility) and the audience capsule.
 *
 * `republish` tells the server this is an explicit publish (freeze the
 * current content as the snapshot the audience reads) and not a change of
 * audience. Ticking a group must NOT push the owner's newest work live, so the
 * capsule's callbacks never set it — only the header's pill does.
 */
export default function useWebpagePublishing({ pageId, page, setPage, onMetaChange, flushNow, mountedRef, setError }: PublishingDeps) {
    const [publishMenuOpen, setPublishMenuOpen] = useState(false);
    const [publishBusy, setPublishBusy] = useState(false);

    const callPublish = useCallback(async (nextPublished: boolean, nextSharedGroups?: string[], { republish = false } = {}) => {
        try {
            const res = await authFetch(`${API_BASE}/api/webpages/${pageId}/publish`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    isPublished: nextPublished,
                    ...(nextSharedGroups !== undefined ? { sharedGroups: nextSharedGroups } : {}),
                    ...(republish ? { republish: true } : {}),
                }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || `Publish failed (${res.status})`);
            }
            // The server answers with the version it actually pinned. Take it
            // from the response rather than assuming: a publish that could not
            // pin is a 500 above, and anything else would leave the header
            // claiming a snapshot that does not exist.
            const body = await res.json().catch(() => ({}));
            const patch: WebpagePatch = {
                isPublished: nextPublished,
                ...(nextSharedGroups !== undefined ? { sharedGroups: nextSharedGroups } : {}),
                ...('publishedVersionId' in body ? { publishedVersionId: body.publishedVersionId } : {}),
            };
            if (!mountedRef.current) return;
            setPage(prev => prev ? { ...prev, ...patch } : prev);
            onMetaChange?.(pageId, patch);
        } catch (err) {
            if (mountedRef.current) setError((err as Error).message);
        }
    }, [pageId, onMetaChange, mountedRef, setPage, setError]);

    /**
     * The header's one primary action — and it does TWO different things,
     * because publishing a draft and republishing a live page are two
     * different decisions:
     *
     *   draft      OPENS THE CAPSULE. It does not publish. A one-click
     *              "Publish" would hand a personal page to the whole
     *              organisation without ever naming the audience — a silent
     *              widening, and the capsule right beside it asks before doing
     *              exactly that (`confirmWidening`). The button that starts
     *              the flow must not be the shortcut around its own guard.
     *   published  re-freezes the current content for the audience the page
     *              ALREADY has. No audience changes, so nothing widens and
     *              there is nothing to confirm.
     *
     * Either way pending edits are flushed first: publishing a keystroke that
     * has not reached the server yet would pin yesterday's page and read as a
     * save bug rather than a publish bug.
     */
    const handlePublishAction = useCallback(async () => {
        if (publishBusy) return;
        if (!page.isPublished) { setPublishMenuOpen(true); return; }
        setPublishBusy(true);
        try {
            await flushNow().catch(e => console.warn('[Webpages] pre-publish flush failed', e));
            const groups = Array.isArray(page.sharedGroups) ? page.sharedGroups : [];
            await callPublish(true, groups, { republish: true });
        } finally {
            if (mountedRef.current) setPublishBusy(false);
        }
    }, [callPublish, flushNow, page.isPublished, page.sharedGroups, publishBusy, mountedRef]);

    const handleSetPersonal = useCallback(() => {
        callPublish(false, []);
        setPublishMenuOpen(false);
    }, [callPublish]);
    const handleSetEntireOrg = useCallback(() => {
        callPublish(true, []);
        setPublishMenuOpen(false);
    }, [callPublish]);
    const handleToggleGroup = useCallback((gid: string) => {
        const current = Array.isArray(page.sharedGroups) ? page.sharedGroups : [];
        const next = current.includes(gid) ? current.filter(x => x !== gid) : [...current, gid];
        callPublish(true, next);
    }, [callPublish, page.sharedGroups]);

    return {
        publishMenuOpen, setPublishMenuOpen, publishBusy,
        handlePublishAction, handleSetPersonal, handleSetEntireOrg, handleToggleGroup,
    };
}
