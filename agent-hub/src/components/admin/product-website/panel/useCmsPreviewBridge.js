// iframe postMessage protocol (cms-preview / cms-active / cms-edit /
// cms-select / cms-block-action / cms-insert-at / cms-hotkey / cms-scroll)
// of the ProductWebsitePanel container — moved verbatim from
// ProductWebsitePanel.jsx. State stays owned by the panel (threaded in).
 
import { useCallback, useEffect, useEffectEvent } from 'react';
import { toast } from '../../../shared/Toast';
import { mergePreviewPage, mergePreviewSite } from '../localeMerge';
import { buildPreviewContent } from '../preview/previewContent';
import { isChromeEntryId } from '../sentinels';
import { AI_LOCK_MSG, BLOCK_LABELS } from './helpers';

export default function useCmsPreviewBridge({
    iframeRef, previewReadyRef, site, previewPage, activePage, activePageId,
    activeBlockId, setActiveBlockId, setBlockEditorTab, activeLocale,
    translationMode, localeOverrides, builderRunning, builderRunningRef,
    applyIframeEdit, runHistoryHotkey, handleBlockAction, handleInsertAt,
}) {
    // ── iframe postMessage ───────────────────────────────────────────

    const postPreview = useCallback(() => {
        const win = iframeRef.current?.contentWindow;
        if (!win || !previewReadyRef.current) return;
        // Site-chrome view: render header + a neutral placeholder body +
        // footer so the user can see the chrome in isolation. Pass a
        // blocks-less page so buildPreviewContent doesn't carry homepage
        // blocks through, and tag the message with previewMode='chrome'
        // so the iframe shows the explainer instead of an empty body.
        // Any chrome entry (header / footer / cookie banner) previews the
        // chrome in isolation — blockless page + previewMode='chrome'.
        const isChromeView = isChromeEntryId(activePageId);
        const pageForPreview = isChromeView ? { blocks: [] } : previewPage;
        // In translation mode, pre-merge the active locale's overrides so the
        // preview renders translated text (with source fallback), matching
        // exactly what the published site will serve at ?locale=…
        let previewSite = site;
        let previewPageMerged = pageForPreview;
        if (translationMode) {
            const siteOv = localeOverrides.siteByLocale?.[activeLocale] || null;
            const pageOv = pageForPreview?.id
                ? (localeOverrides.pagesByLocale?.[pageForPreview.id]?.[activeLocale] || null)
                : null;
            previewSite = mergePreviewSite(site, siteOv);
            previewPageMerged = mergePreviewPage(pageForPreview, pageOv, siteOv);
        }
        const content = buildPreviewContent(previewSite, previewPageMerged);
        // Design flows alongside content (not nested) so the iframe can
        // apply CSS variables independently of content updates.
        const design = site?.design || null;
        const previewMode = isChromeView ? 'chrome' : 'page';
        // Target our own origin (the preview route is same-origin) so draft
        // content/design can't leak to a cross-origin frame in the preview slot.
        win.postMessage({ type: 'cms-preview', content, design, previewMode }, window.location.origin);
    }, [site, previewPage, activePageId, translationMode, activeLocale, localeOverrides, iframeRef, previewReadyRef]);

    // Selection + AI-stream-lock mirror → iframe (cms-active). Deliberately
    // a dedicated message posted from its own effect, NOT folded into
    // postPreview: content re-posts disturb inline-edit focus (see the
    // cms-select comment in onMessage below), and selection changes must
    // never re-send content. `labels` rides along so the iframe can title
    // its block chrome without importing admin code.
    const postActiveToPreview = useCallback(() => {
        const win = iframeRef.current?.contentWindow;
        if (!win || !previewReadyRef.current) return;
        win.postMessage({
            type: 'cms-active',
            blockId: activeBlockId || null,
            locked: builderRunning,
            labels: BLOCK_LABELS,
        }, window.location.origin);
    }, [activeBlockId, builderRunning, iframeRef, previewReadyRef]);

    // Re-post whenever the selection or the lock changes (the callback
    // identity tracks exactly those two). The cms-preview-ready branch
    // below covers the initial post after an iframe (re)mount.
    useEffect(() => { postActiveToPreview(); }, [postActiveToPreview]);

    // Select a block AND scroll the preview to it — bound to translation-row
    // clicks so the admin sees which block a string belongs to.
    const selectAndScrollToBlock = useCallback((blockId) => {
        setActiveBlockId(prev => (prev === blockId ? prev : blockId));
        const win = iframeRef.current?.contentWindow;
        if (win && previewReadyRef.current) win.postMessage({ type: 'cms-scroll', blockId }, window.location.origin);
    }, [iframeRef, previewReadyRef, setActiveBlockId]);

    useEffect(() => {
        const onMessage = (e) => {
            // Only trust our own same-origin preview iframe. Without this, any
            // page framing the admin (or another window) could post a
            // `cms-edit` and corrupt content, or read what we post back. The
            // renderer side already guards its inbound messages symmetrically.
            if (e.origin !== window.location.origin) return;
            if (e.source !== iframeRef.current?.contentWindow) return;
            const msg = e.data;
            if (!msg || typeof msg !== 'object') return;

            if (msg.type === 'cms-preview-ready') {
                previewReadyRef.current = true;
                postPreview();
                postActiveToPreview();
                return;
            }
            if (msg.type === 'cms-edit' && typeof msg.path === 'string') {
                if (builderRunningRef.current) {
                    // Stream lock: an inline preview edit mid-AI-turn would be
                    // silently overwritten by the next draft — refuse loudly.
                    toast.error(AI_LOCK_MSG);
                    return;
                }
                applyIframeEdit(msg.path, msg.value, msg.blockId);
                return;
            }
            // Inline focus in the preview → highlight that block in the left
            // panel, keeping selection in sync with the block being edited.
            // Functional update skips a redundant render when it's already
            // selected; the iframe isn't re-posted (postPreview ignores
            // activeBlockId), so the user's caret/focus isn't disturbed.
            if (msg.type === 'cms-select' && typeof msg.blockId === 'string') {
                setActiveBlockId(prev => (prev === msg.blockId ? prev : msg.blockId));
                return;
            }
            // Canvas block-toolbar action. A mutation — gated on the AI
            // stream lock at this single choke point, mirroring the
            // cms-edit refusal above (same toast).
            if (msg.type === 'cms-block-action'
                && typeof msg.blockId === 'string' && typeof msg.action === 'string') {
                if (builderRunningRef.current) {
                    toast.error(AI_LOCK_MSG);
                    return;
                }
                handleBlockAction(msg.blockId, msg.action);
                return;
            }
            // Canvas insert-between "+" → Add-block dialog with an explicit
            // index. Gated too: the add it leads to would mutate the page
            // mid-AI-turn.
            if (msg.type === 'cms-insert-at' && Number.isInteger(msg.index) && msg.index >= 0) {
                if (builderRunningRef.current) {
                    toast.error(AI_LOCK_MSG);
                    return;
                }
                handleInsertAt(msg.index);
                return;
            }
            // Undo/redo forwarded from the preview iframe (Ctrl/Cmd+Z is
            // otherwise dead while focus sits in the canvas). Same guards
            // as the window hotkey listener via runHistoryHotkey.
            if (msg.type === 'cms-hotkey' && (msg.action === 'undo' || msg.action === 'redo')) {
                runHistoryHotkey(msg.action);
                return;
            }
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
    }, [postPreview, postActiveToPreview, applyIframeEdit, runHistoryHotkey, handleBlockAction, handleInsertAt, builderRunningRef, iframeRef, previewReadyRef, setActiveBlockId]);

    // Push to iframe when active page or site chrome changes.
    useEffect(() => {
        const t = setTimeout(postPreview, 200);
        return () => clearTimeout(t);
    }, [postPreview]);

    // When switching pages, focus the first block. The iframe stays mounted —
    // the postPreview() push below carries the new page's content via
    // postMessage, no reload needed. Keyed on the id: a block edit must not
    // yank the selection back to the first block.
    const focusFirstBlock = useEffectEvent(() => {
        if (activePage) setActiveBlockId(activePage.blocks?.[0]?.id || null);
    });
    useEffect(() => { focusFirstBlock(); }, [activePageId]);

    // Always land on the Content sub-tab when the user picks a different block.
    useEffect(() => { setBlockEditorTab('content'); }, [activeBlockId, setBlockEditorTab]);

    return { selectAndScrollToBlock };
}
