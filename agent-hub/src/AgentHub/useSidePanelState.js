import { useCallback, useEffect, useRef, useState } from 'react';

// Side-panel state for the chat workspace: the notebook pane, the Gamma
// preview, the webpage side panel and the document side panel (all mutually
// exclusive), plus the webpage picker popover. Moved verbatim out of AgentHub.jsx — the state still lives
// in AgentHub's fiber because this hook is called from the exact position the
// inline useState/useRef calls used to occupy.
const useSidePanelState = () => {
    const [notebookContent, setNotebookContent] = useState('');
    const [notebookSelection, setNotebookSelection] = useState('');
    const [showNotebook, setShowNotebook] = useState(false);
    const [notebookLinkedId, setNotebookLinkedId] = useState(null);
    const [showGammaPreview, setShowGammaPreview] = useState(false);
    const [gammaPreview, setGammaPreview] = useState(null);
    // Webpage side panel — mutually exclusive with the notebook / gamma slot.
    // Holds the id of the webpage currently displayed (null = panel closed).
    const [sidePanelWebpageId, setSidePanelWebpageId] = useState(null);
    // Metadata for the open webpage (resolved once the panel loads it). Used
    // to surface { id, name } to the chat backend so the AI knows what the
    // user is looking at. Server reads sidePanelWebpageId and pulls fresh
    // html/css/js itself — we don't ship the bytes on every chat turn.
    const [sidePanelWebpage, setSidePanelWebpage] = useState(null);
    // Mirror the latest html/css/js of the open webpage. We ship these with
    // every webpage-chat turn so the AI sees the user's current page, and
    // update them locally whenever it edits via webpage_doc_update SSE.
    const [sidePanelWebpageFiles, setSidePanelWebpageFiles] = useState({ html: '', css: '', js: '' });
    // Selection captured from the iframe selection bridge — shown as a chip
    // above the chat input and shipped as `webpageSelection` on next send.
    const [attachedWebpageSelection, setAttachedWebpageSelection] = useState(null);
    // Bumped to force SideWebpagePanel to re-fetch after AI edits land —
    // simpler than threading mutable state through the preview.
    const [sidePanelReloadKey, setSidePanelReloadKey] = useState(0);
    // Document side panel — the fourth occupant of the same slot. Holds the id
    // of the document on screen (null = closed). Unlike the webpage panel it
    // carries no file mirror: a document is not shipped with the chat turn, and
    // the AI reaches it through document_read instead.
    const [sidePanelDocumentId, setSidePanelDocumentId] = useState(null);
    const [webpagePickerOpen, setWebpagePickerOpen] = useState(false);
    const webpageButtonRef = useRef(null);
    const webpageButtonRefDirect = useRef(null);

    const toggleNotebookPanel = useCallback(() => {
        setShowNotebook(prev => {
            const next = !prev;
            if (next) {
                setShowGammaPreview(false);
                setSidePanelWebpageId(null);
                setSidePanelDocumentId(null);
            }
            return next;
        });
    }, []);

    const closeSidePreview = useCallback(() => {
        setShowNotebook(false);
        setShowGammaPreview(false);
        setSidePanelWebpageId(null);
        setSidePanelDocumentId(null);
    }, []);

    const openWebpageInSidePanel = useCallback((id) => {
        if (!id) return;
        setSidePanelWebpageId(prev => {
            // Drop stale metadata when switching to a different webpage so the
            // chat payload doesn't carry the previous page's name briefly.
            if (prev !== id) setSidePanelWebpage(null);
            return id;
        });
        setShowNotebook(false);
        setShowGammaPreview(false);
        setSidePanelDocumentId(null);
        setWebpagePickerOpen(false);
    }, []);

    const closeWebpagePanel = useCallback(() => {
        setSidePanelWebpageId(null);
        setSidePanelWebpage(null);
        setSidePanelWebpageFiles({ html: '', css: '', js: '' });
        setAttachedWebpageSelection(null);
    }, []);

    const openDocumentInSidePanel = useCallback((id) => {
        if (!id) return;
        setSidePanelDocumentId(id);
        setShowNotebook(false);
        setShowGammaPreview(false);
        setSidePanelWebpageId(null);
        setWebpagePickerOpen(false);
    }, []);

    const closeDocumentPanel = useCallback(() => setSidePanelDocumentId(null), []);

    const clearWebpageSelection = useCallback(() => setAttachedWebpageSelection(null), []);

    // WebpageLinkCard in a chat message dispatches this event so we can host
    // the webpage in the side slot without losing chat context. Listener
    // calls preventDefault() to claim it — the card falls back to navigation
    // when no listener (e.g. message rendered outside the chat shell).
    useEffect(() => {
        const onOpenSide = (e) => {
            const id = e?.detail?.id;
            if (!id) return;
            e.preventDefault();
            openWebpageInSidePanel(id);
        };
        window.addEventListener('beeflow:open-webpage-side', onOpenSide);
        return () => window.removeEventListener('beeflow:open-webpage-side', onOpenSide);
    }, [openWebpageInSidePanel]);

    // Same contract for DocumentLinkCard: claim the event with preventDefault
    // so the card knows the chat shell handled it, and falls back to plain
    // navigation when a message is rendered outside the shell.
    //
    // ...EXCEPT on a phone, where ChatSidePanels renders nothing at all (every
    // panel there is `!isMobile`). Claiming the event on a narrow viewport
    // would set an id that nothing displays, and the tap would look like a
    // dead link. Declining to claim it hands the click back to the card, which
    // navigates to the full-screen Studio view — the only place a document
    // fits on a phone anyway. The breakpoint is useViewport's own MOBILE_QUERY,
    // read at click time rather than subscribed to: what matters is the width
    // when somebody taps, not a re-render.
    useEffect(() => {
        const onOpenDocSide = (e) => {
            const id = e?.detail?.id;
            if (!id) return;
            const noRoomForAPanel = typeof window !== 'undefined'
                && typeof window.matchMedia === 'function'
                && window.matchMedia('(max-width: 767px)').matches;
            if (noRoomForAPanel) return;
            e.preventDefault();
            openDocumentInSidePanel(id);
        };
        window.addEventListener('beeflow:open-document-side', onOpenDocSide);
        return () => window.removeEventListener('beeflow:open-document-side', onOpenDocSide);
    }, [openDocumentInSidePanel]);

    return {
        notebookContent, setNotebookContent,
        notebookSelection, setNotebookSelection,
        showNotebook, setShowNotebook,
        notebookLinkedId, setNotebookLinkedId,
        showGammaPreview, setShowGammaPreview,
        gammaPreview, setGammaPreview,
        sidePanelWebpageId, setSidePanelWebpageId,
        sidePanelWebpage, setSidePanelWebpage,
        sidePanelWebpageFiles, setSidePanelWebpageFiles,
        attachedWebpageSelection, setAttachedWebpageSelection,
        sidePanelReloadKey, setSidePanelReloadKey,
        sidePanelDocumentId, setSidePanelDocumentId,
        webpagePickerOpen, setWebpagePickerOpen,
        webpageButtonRef, webpageButtonRefDirect,
        toggleNotebookPanel, closeSidePreview,
        openWebpageInSidePanel, closeWebpagePanel, clearWebpageSelection,
        openDocumentInSidePanel, closeDocumentPanel,
    };
};

export default useSidePanelState;
