// State core of the ProductWebsitePanel container — every useState/useRef
// (plus the tiny persisted toggle callbacks that close directly over them)
// moved verbatim from ProductWebsitePanel.jsx. Called first in the panel,
// so all state stays owned by the panel's fiber; the panel and the other
// panel hooks receive these bindings by explicit threading.
import { useCallback, useEffect, useRef, useState } from 'react';
import scopedStorage from '../../../../utils/scopedStorage';
import useConfirm from '../../../shared/useConfirm';
import { SITE_VIRTUAL_ID } from '../sentinels';

export default function useCmsPanelState() {
    // ── multi-site state ─────────────────────────────────────────────
    const [sites, setSites]                   = useState([]);
    const [sitesLoaded, setSitesLoaded]       = useState(false);
    const [activeSiteId, setActiveSiteId]     = useState(null);

    // Mirror of activeSiteId for use inside callbacks that have stable
    // (empty) deps — keeps debounced saves pointing at the correct site
    // even mid-switch (the switcher's flush runs BEFORE we update the ref).
    const activeSiteIdRef = useRef(null);

    // ── server state ────────────────────────────────────────────────
    const [loading, setLoading]               = useState(true);
    const [error, setError]                   = useState(null);
    // liveSiteId is the *globally* live project id (or null). The Live
    // toggle in the panel reflects whether this site === liveSiteId,
    // since at most one project can be live at a time.
    const [liveSiteId, setLiveSiteId]         = useState(null);
    const [defaultLocale, setDefaultLocale]   = useState('en');
    const [locales, setLocales]               = useState([{ code: 'en', name: 'English', isDefault: true }]);
    // Per-locale translation overrides, mirroring getAdminPayload's
    // `localeOverrides`. siteByLocale: { [locale]: siteOverride };
    // pagesByLocale: { [pageId]: { [locale]: pageOverride } }. Only populated
    // for non-default locales — the default locale lives in the base docs.
    const [localeOverrides, setLocaleOverrides] = useState({ siteByLocale: {}, pagesByLocale: {} });
    // AI auto-translate progress for the active page/site. null = idle.
    const [aiStatus, setAiStatus]             = useState(null);
    const [site, setSiteDoc]                  = useState(null);   // SiteDoc
    const [pages, setPages]                   = useState([]);     // [PageDoc]
    const [saveStatus, setSaveStatus]         = useState('idle');
    // ISO string of the last successful publish for the active site, or
    // null if it has never been published. Drives the "Publish" button
    // hint and the disabled state when there's nothing new to ship.
    const [publishedAt, setPublishedAt]       = useState(null);
    const [publishing, setPublishing]         = useState(false);

    // ── editor state ────────────────────────────────────────────────
    const [activeLocale, setActiveLocale]     = useState('en');
    const [activePageId, setActivePageId]     = useState(SITE_VIRTUAL_ID);
    const [activeBlockId, setActiveBlockId]   = useState(null);
    const [blockEditorTab, setBlockEditorTab] = useState('content'); // 'content' | 'style'
    const [rightView, setRightView]           = useState('preview'); // 'preview' | 'sitemap'
    // Add-block dialog request — null = closed. { index: null } comes from
    // the BlockList "+" (default insert-after-active); { index: n } comes
    // from a canvas insert-between "+" zone (cms-insert-at) and splices at
    // that explicit position.
    const [addBlockRequest, setAddBlockRequest] = useState(null);
    // Page templates — global list, summary shape (no blocks payload).
    // Loaded once on mount and refreshed after save/delete. `pendingTemplatePage`
    // holds the page whose context-menu opened the Save dialog (null = no
    // dialog open). The blocks for that page are read out of `pages` state
    // when the user confirms the save.
    const [templates, setTemplates]                       = useState([]);
    const [pendingTemplatePage, setPendingTemplatePage]   = useState(null);

    // ── shell state ─────────────────────────────────────────────────
    // One promise-based ConfirmDialog for every destructive action.
    const { confirm, confirmDialog } = useConfirm();
    // While focus mode is active the individual panel flags stay persisted
    // untouched — they double as the restore state after a reload — so the
    // initializers force the panels closed when the focus flag is set.
    const [navOpen, setNavOpen]             = useState(() =>
        scopedStorage.getItem('cmsFocusMode') !== '1' && scopedStorage.getItem('cmsNavOpen') !== '0');
    const [inspectorOpen, setInspectorOpen] = useState(() =>
        scopedStorage.getItem('cmsFocusMode') !== '1' && scopedStorage.getItem('cmsInspectorOpen') !== '0');
    const toggleNav = useCallback(() => setNavOpen(v => {
        scopedStorage.setItem('cmsNavOpen', v ? '0' : '1');
        return !v;
    }), []);
    const toggleInspector = useCallback(() => setInspectorOpen(v => {
        scopedStorage.setItem('cmsInspectorOpen', v ? '0' : '1');
        return !v;
    }), []);
    // Soft "draft differs from the published snapshot" heuristic — drives the
    // PublishMenu status pill. True after any successful draft write since the
    // last publish; seeded on load from updatedAt vs publishedAt. Copy in the
    // UI stays soft (no false precision).
    const [dirtySincePublish, setDirtySincePublish] = useState(false);
    // Preview device preset ('desktop' | 'tablet' | 'mobile') — a pure
    // max-width on the stage's iframe wrapper.
    const [device, setDevice] = useState(() => scopedStorage.getItem('cmsPreviewDevice') || 'desktop');
    const changeDevice = useCallback((key) => {
        scopedStorage.setItem('cmsPreviewDevice', key);
        setDevice(key);
    }, []);
    // AI-translate model tier (AiTranslateControl vocabulary: fast/thinking/
    // writer/pro — the same picker the Languages tab uses). Persisted per user.
    const [translateTier, setTranslateTier] = useState(() => scopedStorage.getItem('cmsTranslateTier') || 'fast');
    const changeTranslateTier = useCallback((t) => {
        scopedStorage.setItem('cmsTranslateTier', t);
        setTranslateTier(t);
    }, []);
    // D4 guard bookkeeping — warn once per block per session when a list is
    // reordered in the default locale while translations exist for it.
    const reorderWarnedRef = useRef(new Set());
    // ── AI assistant (builder) state ────────────────────────────────
    const [assistantOpen, setAssistantOpen] = useState(() =>
        scopedStorage.getItem('cmsFocusMode') !== '1' && scopedStorage.getItem('cmsAssistantOpen') === '1');
    const toggleAssistant = useCallback(() => setAssistantOpen(v => {
        scopedStorage.setItem('cmsAssistantOpen', v ? '0' : '1');
        return !v;
    }), []);
    // ── focus mode ──────────────────────────────────────────────────
    // One switch that collapses nav + inspector + AI dock at once and
    // restores the prior open-state on exit. Persisted via the same
    // scopedStorage mechanism as the individual panel flags (which are
    // left untouched while focused — see the initializers above).
    const [focusMode, setFocusMode] = useState(() => scopedStorage.getItem('cmsFocusMode') === '1');
    const focusRestoreRef = useRef(null);
    const toggleFocusMode = useCallback(() => {
        const entering = !focusMode;
        scopedStorage.setItem('cmsFocusMode', entering ? '1' : '0');
        if (entering) {
            focusRestoreRef.current = { nav: navOpen, inspector: inspectorOpen, assistant: assistantOpen };
            setNavOpen(false);
            setInspectorOpen(false);
            setAssistantOpen(false);
        } else {
            // Restore the pre-focus open-state; after a reload (ref empty)
            // fall back to the individually persisted panel flags.
            const r = focusRestoreRef.current || {
                nav: scopedStorage.getItem('cmsNavOpen') !== '0',
                inspector: scopedStorage.getItem('cmsInspectorOpen') !== '0',
                assistant: scopedStorage.getItem('cmsAssistantOpen') === '1',
            };
            focusRestoreRef.current = null;
            setNavOpen(r.nav);
            setInspectorOpen(r.inspector);
            setAssistantOpen(r.assistant);
        }
        setFocusMode(entering);
    }, [focusMode, navOpen, inspectorOpen, assistantOpen]);
    // Focus-mode hotkey '\' — skipped while typing (inputs, textareas,
    // selects, contentEditable) so backslashes can still be typed.
    useEffect(() => {
        const onKey = (e) => {
            if (e.key !== '\\' || e.ctrlKey || e.metaKey || e.altKey) return;
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
            e.preventDefault();
            toggleFocusMode();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [toggleFocusMode]);
    // Stream lock: while an AI turn runs, human writes are blocked so the
    // server-persisted drafts can't be clobbered (cmsStore has no CAS).
    const [builderRunning, setBuilderRunning] = useState(false);
    const builderRunningRef = useRef(false);
    // Per-turn bookkeeping for What-changed / Undo turn: pre-turn snapshot +
    // what the drafts touched. Armed until the next turn or human edit.
    const builderTurnRef = useRef(null); // { preSite, prePages, created:[], touched:Set, draftsSeen }
    const [builderUndoAvailable, setBuilderUndoAvailable] = useState(false);
    const builderUndoAvailableRef = useRef(false);
    const disarmBuilderUndo = useCallback(() => {
        if (builderUndoAvailableRef.current) {
            builderUndoAvailableRef.current = false;
            setBuilderUndoAvailable(false);
        }
    }, []);

    // refs for debounced saves
    const iframeRef         = useRef(null);
    const previewReadyRef   = useRef(false);
    const saveTimerRef      = useRef(null);
    const saveStatusTimer   = useRef(null);
    const pendingSaves      = useRef({});   // { [pageId]: PageDoc | 'site' }
    // Tracks the most recent flushSaves() Promise so handlePublish can await
    // an in-flight save that was kicked off by the debounce timer firing
    // (the timer callback otherwise drops the Promise on the floor, which
    // lets a Publish click race the network round-trip).
    const inFlightSaveRef   = useRef(null);
    // True while an AI translate POST is in flight — gates manual translation
    // writes so they can't be clobbered by the returned whole-override.
    const aiRunningRef      = useRef(false);
    // Holds the batch from the most recent failed flushSaves() so the user
    // can retry without losing their edits. Cleared when a flush succeeds.
    const failedSavesRef    = useRef(null);
    // Live mirror of localeOverrides so the override mutators can read the
    // latest value synchronously between rapid edits (typing in the list)
    // without stale-closure races.
    const localeOverridesRef = useRef({ siteByLocale: {}, pagesByLocale: {} });

    return {
        sites, setSites, sitesLoaded, setSitesLoaded, activeSiteId, setActiveSiteId, activeSiteIdRef,
        loading, setLoading, error, setError, liveSiteId, setLiveSiteId,
        defaultLocale, setDefaultLocale, locales, setLocales,
        localeOverrides, setLocaleOverrides, aiStatus, setAiStatus,
        site, setSiteDoc, pages, setPages, saveStatus, setSaveStatus,
        publishedAt, setPublishedAt, publishing, setPublishing,
        activeLocale, setActiveLocale, activePageId, setActivePageId,
        activeBlockId, setActiveBlockId, blockEditorTab, setBlockEditorTab,
        rightView, setRightView, addBlockRequest, setAddBlockRequest,
        templates, setTemplates, pendingTemplatePage, setPendingTemplatePage,
        confirm, confirmDialog,
        navOpen, setNavOpen, inspectorOpen, setInspectorOpen, toggleNav, toggleInspector,
        dirtySincePublish, setDirtySincePublish,
        device, changeDevice, translateTier, changeTranslateTier, reorderWarnedRef,
        assistantOpen, setAssistantOpen, toggleAssistant,
        focusMode, toggleFocusMode,
        builderRunning, setBuilderRunning, builderRunningRef, builderTurnRef,
        builderUndoAvailable, setBuilderUndoAvailable, builderUndoAvailableRef, disarmBuilderUndo,
        iframeRef, previewReadyRef, saveTimerRef, saveStatusTimer, pendingSaves,
        inFlightSaveRef, aiRunningRef, failedSavesRef, localeOverridesRef,
    };
}
