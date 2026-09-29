// AI builder bridge (assistant/CmsAssistantPane) of the ProductWebsitePanel
// container — moved verbatim from ProductWebsitePanel.jsx. State stays owned
// by the panel (threaded in as arguments).
import { useCallback, useMemo } from 'react';
import { authFetch } from '../../../../utils/helpers';
import { toast } from '../../../shared/Toast';
import { cmsApi } from '../cmsApi';
import { HEADER_VIRTUAL_ID, isVirtualPageId } from '../sentinels';

export default function useCmsBuilderBridge({
    activeSiteIdRef, siteStateRef, pagesStateRef, historyResetRef,
    builderRunningRef, setBuilderRunning, builderTurnRef,
    builderUndoAvailableRef, setBuilderUndoAvailable, disarmBuilderUndo,
    drainPendingSaves, setDirtySincePublish,
    activePageId, setActivePageId, setSiteDoc, setPages,
    localeOverridesRef, setLocaleOverrides, confirm,
    setActiveLocale, activeBlockId, activeLocale, setRightView,
}) {
    // ── AI builder bridge (assistant/CmsAssistantPane) ───────────────
    //
    // Contract (resolves the AI-vs-autosave race): drafts the assistant
    // streams are ALREADY server-persisted — applyExternalDraft folds them
    // into state WITHOUT touching pendingSaves/scheduleSave. While a turn
    // runs, the stream lock blocks every human write path; Undo turn is a
    // server-side revert of the pre-turn snapshot (AI turns are never
    // client-history entries).

    const beginBuilderTurn = useCallback(async () => {
        await drainPendingSaves();
        builderTurnRef.current = {
            preSite: JSON.parse(JSON.stringify(siteStateRef.current || null)),
            prePages: JSON.parse(JSON.stringify(pagesStateRef.current || [])),
            created: [],
            touched: new Set(),
            draftsSeen: 0,
        };
        historyResetRef.current();
        disarmBuilderUndo();
        builderRunningRef.current = true;
        setBuilderRunning(true);
    }, [drainPendingSaves, disarmBuilderUndo, builderRunningRef, builderTurnRef, historyResetRef, pagesStateRef, setBuilderRunning, siteStateRef]);

    const applyExternalDraft = useCallback((evt) => {
        if (!evt || evt.siteId !== activeSiteIdRef.current) return; // stale site
        const turn = builderTurnRef.current;
        if (turn) turn.draftsSeen += 1;
        if (evt.kind === 'site' && evt.site) {
            siteStateRef.current = evt.site;
            setSiteDoc(evt.site);
            return;
        }
        if (evt.kind !== 'page' || !evt.pageId || !evt.page) return;
        const prevPages = pagesStateRef.current || [];
        const prev = prevPages.find(p => p.id === evt.pageId);
        if (turn) {
            if (!prev && !turn.created.includes(evt.pageId)) turn.created.push(evt.pageId);
            turn.touched.add(evt.pageId);
        }
        // Mirror the server-side override prune for blocks the AI removed —
        // the server already pruned its copy (pruneBlockLocaleOverrides);
        // without this local mirror, a later manual translation edit would
        // PUT the whole stale override and resurrect the orphans.
        if (prev?.blocks && Array.isArray(evt.page.blocks)) {
            const nextIds = new Set(evt.page.blocks.map(b => b.id));
            for (const b of prev.blocks) {
                if (nextIds.has(b.id)) continue;
                const ovPrev = localeOverridesRef.current;
                const perLocale = ovPrev.pagesByLocale?.[evt.pageId];
                if (!perLocale) continue;
                let changed = false;
                const nextPerLocale = {};
                for (const [loc, ov] of Object.entries(perLocale)) {
                    if (ov?.blocks && Object.prototype.hasOwnProperty.call(ov.blocks, b.id)) {
                        const nb = { ...ov.blocks };
                        delete nb[b.id];
                        nextPerLocale[loc] = { ...ov, blocks: nb };
                        changed = true;
                    } else {
                        nextPerLocale[loc] = ov;
                    }
                }
                if (changed) {
                    const updated = { ...ovPrev, pagesByLocale: { ...ovPrev.pagesByLocale, [evt.pageId]: nextPerLocale } };
                    localeOverridesRef.current = updated;
                    setLocaleOverrides(updated);   // no save — server already pruned
                }
            }
        }
        const nextPages = prev
            ? prevPages.map(p => (p.id === evt.pageId ? evt.page : p))
            : [...prevPages, evt.page];
        pagesStateRef.current = nextPages;
        setPages(nextPages);
    }, [activeSiteIdRef, builderTurnRef, localeOverridesRef, pagesStateRef, setLocaleOverrides, setPages, setSiteDoc, siteStateRef]);

    const endBuilderTurn = useCallback((info = {}) => {
        builderRunningRef.current = false;
        setBuilderRunning(false);
        const turn = builderTurnRef.current;
        if (!turn) return;
        if (turn.draftsSeen > 0) {
            // Server-persisted changes → the draft differs from the snapshot.
            setDirtySincePublish(true);
            builderUndoAvailableRef.current = true;
            setBuilderUndoAvailable(true);
        }
        const focus = (info.createdPageIds || [])[0] || (info.touchedPageIds || [])[0] || null;
        if (focus && !info.failed) setActivePageId(focus);
        // The pre-turn snapshot stays armed for Undo turn until the next
        // turn or the next human edit (disarmBuilderUndo in applyHistoryDraft).
    }, [builderRunningRef, builderTurnRef, builderUndoAvailableRef, setActivePageId, setBuilderRunning, setBuilderUndoAvailable, setDirtySincePublish]);

    const undoBuilderTurn = useCallback(async () => {
        const turn = builderTurnRef.current;
        const siteId = activeSiteIdRef.current;
        if (!turn || !siteId || builderRunningRef.current) return;
        const ok = await confirm({
            title: 'Undo this AI turn?',
            description: 'Reverts every change from the last assistant turn. Pages it created are deleted.',
            confirmLabel: 'Undo turn',
            destructive: true,
        });
        if (!ok) return;
        try {
            // 1. DELETE created pages FIRST — removePage rewrites the site
            //    index, so restoring the pre-turn site doc afterwards leaves
            //    the index canonical.
            for (const id of turn.created) {
                const res = await authFetch(cmsApi.page(siteId, id), { method: 'DELETE' });
                if (!res.ok && res.status !== 404) {
                    const d = await res.json().catch(() => ({}));
                    throw new Error(d.error || `Failed to delete page (${res.status})`);
                }
            }
            // 2. Restore the pre-turn site doc (index + chrome + design).
            if (turn.preSite) {
                const res = await authFetch(cmsApi.site(siteId), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ site: turn.preSite }),
                });
                if (!res.ok) {
                    const d = await res.json().catch(() => ({}));
                    throw new Error(d.error || 'Failed to restore site');
                }
            }
            // 3. Restore each touched pre-existing page.
            for (const id of turn.touched) {
                if (turn.created.includes(id)) continue;
                const pre = turn.prePages.find(p => p.id === id);
                if (!pre) continue;
                const res = await authFetch(cmsApi.page(siteId, id), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ page: pre }),
                });
                if (!res.ok) {
                    const d = await res.json().catch(() => ({}));
                    throw new Error(d.error || 'Failed to restore page');
                }
            }
            // Fold the snapshot back locally WITHOUT scheduling saves.
            siteStateRef.current = turn.preSite;
            pagesStateRef.current = turn.prePages;
            setSiteDoc(turn.preSite);
            setPages(turn.prePages);
            if (turn.created.includes(activePageId)) setActivePageId(HEADER_VIRTUAL_ID);
            builderTurnRef.current = null;
            disarmBuilderUndo();
            toast.success('AI turn undone');
        } catch (err) {
            toast.error(`Undo failed: ${err.message}`);
        }
    }, [confirm, activePageId, disarmBuilderUndo, activeSiteIdRef, builderRunningRef, builderTurnRef, pagesStateRef, setActivePageId, setPages, setSiteDoc, siteStateRef]);

    // Locale switches remount the preview iframe and flip translate mode —
    // blocked while an AI turn runs (the turn's drafts target the default
    // locale docs).
    const changeLocaleSafe = useCallback((code) => {
        if (builderRunningRef.current) {
            toast.error('The AI assistant is editing — press Stop in the assistant to take over.');
            return;
        }
        setActiveLocale(code);
    }, [builderRunningRef, setActiveLocale]);

    const builderContext = useCallback(() => ({
        activePageId: isVirtualPageId(activePageId) ? null : activePageId,
        activeBlockId,
        activeLocale,
    }), [activePageId, activeBlockId, activeLocale]);

    const builderBridge = useMemo(() => ({
        beginTurn: beginBuilderTurn,
        applyExternalDraft,
        endTurn: endBuilderTurn,
        undoTurn: undoBuilderTurn,
        context: builderContext,
        selectPage: (id) => { setActivePageId(id); setRightView('preview'); },
    }), [beginBuilderTurn, applyExternalDraft, endBuilderTurn, undoBuilderTurn, builderContext, setActivePageId, setRightView]);

    return { builderBridge, changeLocaleSafe };
}
