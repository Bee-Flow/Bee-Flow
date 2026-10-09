import React, { useCallback, useEffect, useEffectEvent, useMemo } from 'react';
import CmsAssistantPane from './assistant/CmsAssistantPane';
import { cmsApi } from './cmsApi';
import AddBlockDialog from './dialogs/AddBlockDialog';
import { CreatePageContext } from './fields';
import InspectorHost from './inspector/InspectorHost';
import NavigatorPanel from './navigator/NavigatorPanel';
import { SaveTemplateDialog } from './PageList';
import CreateFirstSite from './panel/CreateFirstSite';
import { ACTIVE_SITE_LS_KEY } from './panel/helpers';
import useCmsAutosave from './panel/useCmsAutosave';
import useCmsBlockEditing from './panel/useCmsBlockEditing';
import useCmsBuilderBridge from './panel/useCmsBuilderBridge';
import useCmsContentMutations from './panel/useCmsContentMutations';
import useCmsHistory from './panel/useCmsHistory';
import useCmsPageMeta from './panel/useCmsPageMeta';
import useCmsPagesTemplates from './panel/useCmsPagesTemplates';
import useCmsPanelState from './panel/useCmsPanelState';
import useCmsPreviewBridge from './panel/useCmsPreviewBridge';
import useCmsPublishing from './panel/useCmsPublishing';
import useCmsSiteOps from './panel/useCmsSiteOps';
import PreviewStage from './preview/PreviewStage';
import {
    DESIGN_VIRTUAL_ID, HEADER_VIRTUAL_ID,
    COOKIE_VIRTUAL_ID, ANALYTICS_VIRTUAL_ID,
    isVirtualPageId, isChromeEntryId, normalizeVirtualId,
} from './sentinels';
import CmsBuilderShell from './shell/CmsBuilderShell';
import TopBar from './shell/TopBar';
import SitemapView from './SitemapView';
import { coverageForLocale } from './translatable';
import { authFetch } from '../../../utils/helpers';
import AppIcon from '../../icons/AppIcon';
import { useTranslation } from '../../../hooks/useTranslation';

/**
 * Product Website CMS — multi-site admin panel.
 *
 * Layout (three panes):
 *   LEFT-A  (180px)  Site switcher + page list — sorted, add/duplicate/
 *                    delete/set-homepage. Switching sites reloads the panel.
 *   LEFT-B  (300px)  Block list for active page + section settings below
 *   RIGHT            Live preview iframe (CMS preview route)
 *
 * Multi-site model:
 *   - GET /api/cms/sites lists every project on mount.
 *   - The active siteId is persisted to localStorage as cms.activeSiteId.
 *   - All editor traffic uses /api/cms/sites/:siteId/* (built via cmsApi.js).
 *   - Org-wide flags (enabled, default-locale, upload) stay at /api/cms/admin/*.
 *
 * Editing model:
 *   - Structural changes (page/block CRUD, reorder, content edits) flow through
 *     a debounced auto-save (~800ms) that PUTs the affected SiteDoc/PageDoc.
 *   - Inline text edits arrive as postMessages from the iframe
 *     (cms-edit { path, value }) and merge into block content.
 *   - Page meta changes (title, slug, hideHeader, hideFooter) round-trip
 *     immediately through PUT /pages/:id/meta so the site index stays in sync.
 *   - Site chrome (header/footer) is edited via a "Site" virtual page that
 *     appears at the top of the page list.
 *
 * postMessage protocol:
 *   ← cms-preview-ready
 *   ← cms-edit            { path, value, blockId? }
 *   ← cms-select          { blockId }
 *   ← cms-hotkey          { action: 'undo' | 'redo' }
 *   ← cms-block-action    { blockId, action: 'move-up' | 'move-down' |
 *                                       'duplicate' | 'delete' | 'settings' }
 *   ← cms-insert-at       { index }
 *   → cms-preview         { content, design, previewMode }
 *                                                content = { header, footer, blocks };
 *                                                design = site.design (colors/fonts/radius/theme);
 *                                                previewMode = 'page' | 'chrome'
 *   → cms-active          { blockId, locked, labels }   selection + AI stream
 *                                                lock mirror for the canvas
 *                                                chrome (posted separately from
 *                                                cms-preview so content re-posts
 *                                                never disturb inline-edit focus)
 *   → cms-scroll          { blockId }
 *
 * The implementation is decomposed into ./panel/ — module-scope helpers
 * (helpers.js), the state core (useCmsPanelState) and one custom hook per
 * concern (autosave, history, content mutations, AI builder bridge, block
 * editing, pages+templates, publishing, preview bridge, page meta, site
 * ops), all called below in their original order so every piece of state
 * stays owned by this component's fiber.
 */

// Virtual page-list ids live in ./sentinels.js (legacy '__site__' aliases
// to the header entry; navigator shows Design/Header/Footer/Cookie banner).

// SaveBadge lives in ./shell/SaveBadge.jsx; the Content/Style sub-tabs in
// ./inspector/PageInspector.jsx.

// ── main component ───────────────────────────────────────────────────

// Props (both provided by AdminDashboard's full-bleed branch):
//   onExit()          — leave the builder, back to the admin dashboard
//   onNavigate(path)  — app-level navigation for cross-links
//                       (e.g. 'admin/languages', 'admin/website-analytics')
export default function ProductWebsitePanel({ onExit, onNavigate } = {}) {
    const { t } = useTranslation();
    const {
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
    } = useCmsPanelState();

    // ── derived ─────────────────────────────────────────────────────

    // Merge the PageDoc with its matching site.pages[i] index entry so the
    // PageMetaStrip can read isHomepage/hideHeader/hideFooter/isNotFound/
    // noAnalytics (which live on the index, not the PageDoc). Every
    // index-only field MUST be listed here — the PageDoc sanitizer strips
    // them, so an omitted field reads as undefined forever and its toggle
    // can never be switched back off.
    const activePage = useMemo(() => {
        if (isVirtualPageId(activePageId)) return null;
        const doc = pages.find(p => p.id === activePageId);
        if (!doc) return null;
        const idx = (site?.pages || []).find(p => p.id === activePageId);
        return idx
            ? { ...doc, isHomepage: !!idx.isHomepage,
                hideHeader: !!idx.hideHeader,
                hideFooter: !!idx.hideFooter,
                isNotFound: !!idx.isNotFound,
                noAnalytics: !!idx.noAnalytics }
            : doc;
    }, [pages, activePageId, site]);

    const activeBlock = useMemo(() => {
        if (!activePage || !activeBlockId) return null;
        return activePage.blocks?.find(b => b.id === activeBlockId) || null;
    }, [activePage, activeBlockId]);

    // ── translation mode ────────────────────────────────────────────
    // Editing any non-default locale switches the panel into "translation
    // mode": structure is authored in the default locale, so here we edit
    // TEXT ONLY and write into sparse per-locale overrides.
    const translationMode = activeLocale !== defaultLocale;
    const activeSiteOverride = useMemo(
        () => localeOverrides.siteByLocale?.[activeLocale] || null,
        [localeOverrides, activeLocale]);
    const activePageOverride = useMemo(
        () => (activePage ? localeOverrides.pagesByLocale?.[activePage.id]?.[activeLocale] : null) || null,
        [localeOverrides, activePage, activeLocale]);

    // Public page index — passed to LinkField pickers
    const pageIndex = useMemo(() =>
        (site?.pages || []).map(p => ({ id: p.id, slug: p.slug, title: p.title, isHomepage: p.isHomepage })),
        [site]
    );

    // What page does the iframe preview render?
    //   - editing a real page → that page
    //   - editing a virtual entry (Design / Site chrome) → fall back to the
    //     homepage so the user can see chrome and design changes against
    //     real block content (otherwise the preview is just header+footer).
    const previewPage = useMemo(() => {
        if (activePage) return activePage;
        const homePageId = site?.homepageId || (site?.pages || [])[0]?.id;
        if (!homePageId) return null;
        return pages.find(p => p.id === homePageId) || null;
    }, [activePage, pages, site]);

    // ── load sites list + pick the active site ────────────────────────
    //
    // On mount: GET /api/cms/sites → state list. Pick last-used (from
    // localStorage) if it still exists, else the first site, else null.
    // Effect B below then loads that site's full editor payload.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await authFetch(cmsApi.listSites());
                if (!res.ok) throw new Error(`Failed to load sites (${res.status})`);
                const data = await res.json();
                if (cancelled) return;
                const list = Array.isArray(data.sites) ? data.sites : [];
                setSites(list);
                setLiveSiteId(data.liveSiteId || null);
                const remembered = (() => {
                    try { return localStorage.getItem(ACTIVE_SITE_LS_KEY); } catch { return null; }
                })();
                const initial = (remembered && list.find(s => s.id === remembered))
                    ? remembered
                    : (list[0]?.id || null);
                activeSiteIdRef.current = initial;
                setActiveSiteId(initial);
                if (!initial) setLoading(false);  // empty state — no payload to fetch
            } catch (err) {
                if (!cancelled) {
                    setError(err.message);
                    setLoading(false);
                }
            } finally {
                if (!cancelled) setSitesLoaded(true);
            }
        })();
        return () => { cancelled = true; };
    }, [activeSiteIdRef, setActiveSiteId, setError, setLiveSiteId, setLoading, setSites, setSitesLoaded]);

    const { scheduleSave, flushSaves, retrySave, drainPendingSaves } = useCmsAutosave({
        activeSiteIdRef, builderRunningRef, pendingSaves, saveTimerRef, saveStatusTimer,
        inFlightSaveRef, failedSavesRef, setSaveStatus, setError, setDirtySincePublish,
    });

    const { siteStateRef, pagesStateRef, history, historyResetRef, runHistoryHotkey } = useCmsHistory({
        site, pages, activeLocale, translationMode,
        aiRunningRef, builderRunningRef, disarmBuilderUndo, scheduleSave,
        setSiteDoc, setPages,
    });

    // ── load the active site's editor payload ─────────────────────────
    //
    // Fires whenever activeSiteId changes (initial pick or site switch).
    // Resets all per-site state, then fetches GET /api/cms/sites/:siteId.
    // The soft dirty-since-publish heuristic reads the site list as it is
    // when the payload lands (best effort), without re-running the load.
    const seedDirtySincePublish = useEffectEvent((siteId, publishedAt) => {
        const listEntry = sites.find(s => s.id === siteId);
        setDirtySincePublish(!!(
            publishedAt
            && listEntry?.updatedAt
            && Date.parse(listEntry.updatedAt) > Date.parse(publishedAt)
        ));
    });
    useEffect(() => {
        if (!activeSiteId) return;
        let cancelled = false;
        setLoading(true);
        setError(null);
        // Clean local state so the editor never shows stale content from
        // the previous site mid-fetch.
        setSiteDoc(null);
        setPages([]);
        setActivePageId(HEADER_VIRTUAL_ID);
        setActiveBlockId(null);
        setSaveStatus('idle');
        setPublishedAt(null);
        pendingSaves.current = {};
        (async () => {
            try {
                const res = await authFetch(cmsApi.site(activeSiteId));
                if (!res.ok) throw new Error(`Failed to load site (${res.status})`);
                const data = await res.json();
                if (cancelled) return;
                // Server includes liveSiteId on the site payload — refresh
                // it here in case another tab toggled live in the meantime.
                if (data.liveSiteId !== undefined) setLiveSiteId(data.liveSiteId || null);
                setDefaultLocale(data.defaultLocale || 'en');
                setLocales(data.locales || [{ code: 'en', name: 'English', isDefault: true }]);
                setSiteDoc(data.site || null);
                setPages(data.pages || []);
                setLocaleOverrides(data.localeOverrides || { siteByLocale: {}, pagesByLocale: {} });
                setPublishedAt(data.publishedAt || null);
                seedDirtySincePublish(activeSiteId, data.publishedAt);
                setActiveLocale(data.defaultLocale || 'en');
                historyResetRef.current();
                const firstPageId = data.site?.pages?.[0]?.id;
                setActivePageId(firstPageId || HEADER_VIRTUAL_ID);
                if (firstPageId && data.pages?.length) {
                    setActiveBlockId(data.pages[0]?.blocks?.[0]?.id || null);
                }
            } catch (err) {
                if (!cancelled) setError(err.message);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [activeSiteId, historyResetRef, pendingSaves, setActiveBlockId, setActiveLocale, setActivePageId, setDefaultLocale, setError, setLiveSiteId, setLoading, setLocaleOverrides, setLocales, setPages, setPublishedAt, setSaveStatus, setSiteDoc]);

    const {
        updatePage, updateBlockContent, updateBlockStyle,
        updatePageOverride, updateSiteOverride,
        handleAiTranslate, handleClearAndRetranslateBlock, handleResetTranslations,
    } = useCmsContentMutations({
        pages, activePage, activePageId, activeLocale, locales, translateTier,
        aiStatus, setAiStatus, localeOverrides, setLocaleOverrides, localeOverridesRef,
        reorderWarnedRef, aiRunningRef, activeSiteIdRef, siteStateRef, pagesStateRef,
        history, scheduleSave, drainPendingSaves, confirm,
    });

    const { builderBridge, changeLocaleSafe } = useCmsBuilderBridge({
        activeSiteIdRef, siteStateRef, pagesStateRef, historyResetRef,
        builderRunningRef, setBuilderRunning, builderTurnRef,
        builderUndoAvailableRef, setBuilderUndoAvailable, disarmBuilderUndo,
        drainPendingSaves, setDirtySincePublish,
        activePageId, setActivePageId, setSiteDoc, setPages,
        localeOverridesRef, setLocaleOverrides, confirm,
        setActiveLocale, activeBlockId, activeLocale, setRightView,
    });

    const {
        applyIframeEdit, addBlock, toggleBlock, duplicateBlock, deleteBlock,
        reorderBlocks, handleBlockAction, handleInsertAt,
    } = useCmsBlockEditing({
        site, activePage, activeBlockId, setActiveBlockId, activeLocale, translationMode,
        history, pagesStateRef, updatePage, updateSiteOverride, updatePageOverride,
        localeOverridesRef, setLocaleOverrides, scheduleSave,
        setAddBlockRequest, setInspectorOpen,
    });

    const {
        handleAddPage, handleDuplicatePage, handleExportPage, handleImportPage,
        handleDeletePage, handleSetHomepage, handleReorderPages, reloadPayload,
        handleSaveAsTemplate, submitTemplate, handleDeleteTemplate,
    } = useCmsPagesTemplates({
        activeSiteIdRef, drainPendingSaves, setActivePageId, pages, updatePage, confirm,
        historyResetRef, setSiteDoc, setPages, locales, setLocales, setLocaleOverrides,
        setPublishedAt, setDirtySincePublish, pendingSaves, inFlightSaveRef,
        builderRunningRef, saveStatus, setTemplates, pendingTemplatePage, setPendingTemplatePage,
    });

    const {
        updateSiteChrome, updateDesign, updateSiteAnalytics,
        persistLive, handlePublish, handleSetDefaultLocale,
    } = useCmsPublishing({
        history, siteStateRef, pagesStateRef,
        activeSiteId, activeSiteIdRef, liveSiteId, setLiveSiteId, sites, confirm, builderRunningRef,
        saveTimerRef, inFlightSaveRef, failedSavesRef, flushSaves,
        setPublishing, setPublishedAt, setDirtySincePublish, setError,
        locales, setDefaultLocale,
    });

    const { selectAndScrollToBlock } = useCmsPreviewBridge({
        iframeRef, previewReadyRef, site, previewPage, activePage, activePageId,
        activeBlockId, setActiveBlockId, setBlockEditorTab, activeLocale,
        translationMode, localeOverrides, builderRunning, builderRunningRef,
        applyIframeEdit, runHistoryHotkey, handleBlockAction, handleInsertAt,
    });

    const { updatePageSeo, savePageMeta, updatePageMeta } = useCmsPageMeta({
        activePage, updatePage, activeSiteIdRef, builderRunningRef, drainPendingSaves,
        setSaveStatus, setDirtySincePublish, saveStatusTimer, reloadPayload, setError,
    });

    const {
        siteIoStatus, handleSwitchSite, handleCreateSite, handleRenameSite,
        handleExportSite, handleImportFileChosen, handleDeleteSite,
        handleDuplicateSite, handleSetLiveVersion,
    } = useCmsSiteOps({
        activeSiteIdRef, setActiveSiteId, setSites, setLiveSiteId, liveSiteId, sites,
        confirm, builderRunningRef, saveTimerRef, inFlightSaveRef, flushSaves, reloadPayload,
    });

    // Context value for the LinkField "+ Create new page…" picker. Wraps
    // handleAddPage with keepActive=true so the user stays on whatever
    // they were configuring (Site chrome / current block) instead of
    // being yanked onto the freshly-created page editor. Memoized so the
    // Provider value reference is stable — without it every render of
    // ProductWebsitePanel would re-trigger every consuming LinkField.
    //
    // MUST be declared above the early-return guards below: hooks have
    // to run unconditionally on every render (otherwise React throws
    // "Rendered more hooks than during the previous render" once the
    // guards stop firing).
    const createPageFromPicker = useCallback(
        (input) => handleAddPage(input, { keepActive: true }),
        [handleAddPage],
    );

    // ── render ───────────────────────────────────────────────────────

    if (!sitesLoaded || (loading && !site)) {
        return (
            <div className="h-full flex items-center justify-center text-[var(--text-secondary)]">
                {sitesLoaded ? 'Loading site…' : 'Loading CMS…'}
            </div>
        );
    }

    if (sitesLoaded && sites.length === 0) {
        return <CreateFirstSite onCreate={handleCreateSite} />;
    }

    const entryId = normalizeVirtualId(activePageId);
    const isChromeView = isChromeEntryId(activePageId);
    const isDesignView = entryId === DESIGN_VIRTUAL_ID;
    const isAnalyticsView = entryId === ANALYTICS_VIRTUAL_ID;

    // Dedicated CMS preview route — isolated from the public site / auth /
    // redirect logic. Page switches do NOT reload the iframe; they're pushed
    // via postMessage in postPreview(). Locale switches remount (key).
    const iframeSrc = `/__cms_preview__?preview=1&locale=${encodeURIComponent(activeLocale)}`;

    // Versions of the active site = every site sharing its versionGroupId.
    // listSites() carries versionGroupId/versionName on each entry; the
    // `|| s.id` fallback covers entries that pre-date versioning.
    const activeGroupId =
        sites.find(s => s.id === activeSiteId)?.versionGroupId
        || site?.versionGroupId
        || activeSiteId;
    const versions = sites.filter(s => (s.versionGroupId || s.id) === activeGroupId);

    const activeLocaleName = locales.find(l => l.code === activeLocale)?.name || activeLocale;
    const isLive = liveSiteId === activeSiteId;

    // Per-locale translation coverage for the locale menu ("n/m fields").
    // Cheap walk over client-side state; soft numbers by design (D3).
    const coverageByLocale = {};
    for (const l of locales) {
        if (l.code === defaultLocale || !site) continue;
        coverageByLocale[l.code] = coverageForLocale(site, pages, localeOverrides, l.code);
    }
    const otherLiveSite = liveSiteId && liveSiteId !== activeSiteId
        ? sites.find(s => s.id === liveSiteId)
        : null;

    const statusText = rightView === 'preview'
        ? t('cms_site.site.panel.status', '{view} · {locale}{editorOnly} · Click text to edit', {
            view: isChromeView ? t('cms_site.site.panel.view_chrome', 'site chrome') : isDesignView ? t('cms_site.site.panel.view_design', 'design') : isAnalyticsView ? t('cms_site.site.panel.view_analytics', 'analytics') : (activePage?.slug || 'home'),
            locale: activeLocale,
            editorOnly: !isLive ? t('cms_site.site.panel.editor_only', ' · editor only') : '',
        })
        : null;

    // Stage empty-state overlays — the preview always stays center-stage, so
    // "nothing here yet" guidance lives ON the stage instead of a bare pane.
    const noPages = (site?.pages || []).length === 0;
    const activePageEmpty = !!activePage && (activePage.blocks || []).length === 0 && !translationMode;
    const stageOverlay = rightView === 'preview' && (noPages || activePageEmpty) ? (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="pointer-events-auto max-w-xs w-full mx-4 rounded-xl border border-[var(--border-default)] bg-[var(--bg-secondary)]/95 shadow-xl p-5 text-center">
                <AppIcon
                    name={noPages ? 'FileText' : 'LayoutGrid'}
                    className="w-8 h-8 mx-auto mb-3 text-[var(--text-muted)]"
                />
                <h4 className="text-sm font-semibold text-[var(--text-primary)] mb-1">
                    {noPages ? t('cms_site.site.panel.no_pages_title', 'This site has no pages yet') : t('cms_site.site.panel.empty_page', 'Empty page')}
                </h4>
                <p className="text-xs text-[var(--text-muted)] mb-3">
                    {noPages
                        ? t('cms_site.site.panel.no_pages_body', 'Every website starts with a page.')
                        : t('cms_site.site.panel.empty_page_body', 'Add your first block from the Blocks list on the left (+).')}
                </p>
                {noPages && (
                    <button
                        type="button"
                        onClick={() => handleAddPage({ title: 'Home' })}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--accent-primary)] text-white text-xs font-medium hover:bg-[var(--accent-primary)]/90"
                    >
                        <AppIcon name="Plus" className="w-3.5 h-3.5" />
                        {t('cms_site.site.panel.create_first_page', 'Create your first page')}
                    </button>
                )}
            </div>
        </div>
    ) : null;

    // The iframe node is built HERE so the container keeps owning iframeRef
    // and the key={activeLocale} remount semantics (cms-preview-ready
    // re-handshake); PreviewStage only decides visibility.
    const iframe = (
        <iframe
            ref={iframeRef}
            title={t('cms_site.site.panel.preview_title', 'Product website preview')}
            src={iframeSrc}
            className="flex-1 w-full bg-white"
            key={activeLocale}
        />
    );

    return (
      <CreatePageContext.Provider value={createPageFromPicker}>
        <CmsBuilderShell
            navOpen={navOpen}
            inspectorOpen={inspectorOpen}
            onCloseNav={() => setNavOpen(false)}
            onCloseInspector={() => setInspectorOpen(false)}
            onCloseAiDock={() => setAssistantOpen(false)}
            locked={builderRunning}
            aiDock={assistantOpen ? (
                <CmsAssistantPane
                    siteId={activeSiteId}
                    bridge={builderBridge}
                    pages={pageIndex}
                    translationMode={translationMode}
                    defaultLocaleName={locales.find(l => l.code === defaultLocale)?.name || defaultLocale}
                    canUndoTurn={builderUndoAvailable}
                    onClose={toggleAssistant}
                />
            ) : null}
            dialogs={
                <>
                    {pendingTemplatePage ? (
                        <SaveTemplateDialog
                            page={pendingTemplatePage}
                            onCancel={() => setPendingTemplatePage(null)}
                            onConfirm={submitTemplate}
                        />
                    ) : null}
                    {addBlockRequest ? (
                        <AddBlockDialog
                            design={site?.design || null}
                            onAdd={(type, variant) => {
                                addBlock(type, addBlockRequest.index, variant ? { variant } : null);
                                setAddBlockRequest(null);
                            }}
                            onCancel={() => setAddBlockRequest(null)}
                        />
                    ) : null}
                    {confirmDialog}
                </>
            }
            topBar={
                <TopBar
                    onExit={onExit}
                    siteMenuProps={{
                        sites,
                        versions,
                        activeSiteId,
                        liveSiteId,
                        onSelectSite: handleSwitchSite,
                        onCreateSite: handleCreateSite,
                        onRenameSite: handleRenameSite,
                        onDeleteSite: handleDeleteSite,
                        onSetLiveVersion: handleSetLiveVersion,
                        onDuplicateVersion: handleDuplicateSite,
                        onExportSite: handleExportSite,
                        onImportFile: handleImportFileChosen,
                        ioStatus: siteIoStatus,
                    }}
                    localeMenuProps={{
                        locales,
                        activeLocale,
                        defaultLocale,
                        coverageByLocale,
                        onSelect: changeLocaleSafe,
                        onSetDefault: handleSetDefaultLocale,
                        onManageLanguages: onNavigate ? () => onNavigate('admin/languages') : undefined,
                    }}
                    publishProps={{
                        publishing,
                        publishedAt,
                        dirtySincePublish,
                        isLive,
                        liveSiteName: otherLiveSite?.name || null,
                        onPublish: handlePublish,
                        onSetLive: persistLive,
                    }}
                    saveStatus={saveStatus}
                    onRetrySave={retrySave}
                    view={rightView}
                    onViewChange={setRightView}
                    device={device}
                    onDeviceChange={changeDevice}
                    assistantOpen={assistantOpen}
                    onToggleAssistant={toggleAssistant}
                    assistantRunning={builderRunning}
                    history={{
                        canUndo: history.canUndo,
                        canRedo: history.canRedo,
                        onUndo: history.undo,
                        onRedo: history.redo,
                    }}
                    translationMode={translationMode}
                    translatingLocaleName={activeLocaleName}
                    onExitTranslationMode={() => changeLocaleSafe(defaultLocale)}
                    navOpen={navOpen}
                    onToggleNav={toggleNav}
                    inspectorOpen={inspectorOpen}
                    onToggleInspector={toggleInspector}
                    focusMode={focusMode}
                    onToggleFocusMode={toggleFocusMode}
                    onOpenAnalytics={onNavigate ? () => onNavigate('admin/website-analytics') : undefined}
                    onManageLanguages={onNavigate ? () => onNavigate('admin/languages') : undefined}
                    isLive={isLive}
                />
            }
            navigator={
                <NavigatorPanel
                    activeEntryId={entryId}
                    onSelectEntry={setActivePageId}
                    pageListProps={{
                        pages: site?.pages || [],
                        activePageId,
                        onSelect: setActivePageId,
                        onAdd: handleAddPage,
                        onDuplicate: handleDuplicatePage,
                        onDelete: handleDeletePage,
                        onSetHomepage: handleSetHomepage,
                        onRename: (pageId, title) => savePageMeta(pageId, { title }),
                        onEditSlug: (pageId, slug) => savePageMeta(pageId, { slug }),
                        onReorder: handleReorderPages,
                        templates,
                        onSaveAsTemplate: handleSaveAsTemplate,
                        onDeleteTemplate: handleDeleteTemplate,
                        onExportPage: handleExportPage,
                        onImportPage: handleImportPage,
                    }}
                    blockListProps={(activePage && !translationMode) ? {
                        blocks: activePage.blocks || [],
                        activeBlockId,
                        onSelect: setActiveBlockId,
                        // index:null = default insert-after-active behaviour
                        // (the canvas "+" zones request an explicit index).
                        onRequestAdd: () => setAddBlockRequest({ index: null }),
                        onToggle: toggleBlock,
                        onDuplicate: duplicateBlock,
                        onDelete: deleteBlock,
                        onReorder: reorderBlocks,
                    } : null}
                />
            }
            stage={
                <PreviewStage
                    view={rightView}
                    statusText={statusText}
                    errorText={error}
                    onDismissError={() => setError(null)}
                    deviceWidth={device === 'tablet' ? 768 : device === 'mobile' ? 390 : null}
                    overlay={stageOverlay}
                    iframe={iframe}
                    sitemap={rightView === 'sitemap' ? (
                        <SitemapView
                            siteId={activeSiteId}
                            activePageId={isVirtualPageId(activePageId) ? null : activePageId}
                            onSelectPage={(id) => {
                                setActivePageId(id);
                                setRightView('preview');
                            }}
                            onMutated={async () => {
                                // Pull the flyout's server-side changes into panel
                                // state before a stale 'site' save can clobber them.
                                await drainPendingSaves();
                                await reloadPayload();
                            }}
                        />
                    ) : null}
                />
            }
            inspector={
                <InspectorHost
                    activePageId={activePageId}
                    activePage={activePage}
                    translationMode={translationMode}
                    translateProps={{
                        site,
                        page: activePage,
                        localeName: activeLocaleName,
                        defaultLocaleName: locales.find(l => l.code === defaultLocale)?.name || defaultLocale,
                        pageOverride: activePageOverride,
                        siteOverride: activeSiteOverride,
                        aiStatus,
                        onPageLeaf: (blockId, fieldPath, value) =>
                            activePage && updatePageOverride(activePage.id, activeLocale, ['blocks', blockId, 'content', ...fieldPath], value),
                        onPageSeo: (field, value) =>
                            activePage && updatePageOverride(activePage.id, activeLocale, ['seo', field], value),
                        onChromeLeaf: (storagePath, value) =>
                            updateSiteOverride(activeLocale, storagePath, value),
                        onSelectBlock: selectAndScrollToBlock,
                        tier: translateTier,
                        onTierChange: changeTranslateTier,
                        onAiTranslate: () => handleAiTranslate(isChromeView ? 'site' : 'page', translateTier),
                        onClearAndRetranslateBlock: isChromeView ? undefined : handleClearAndRetranslateBlock,
                        onResetTranslations: () => handleResetTranslations(isChromeView ? 'site' : 'page'),
                    }}
                    chromeProps={{
                        site,
                        pages: pageIndex,
                        locales,
                        defaultLocale,
                        onChangeSite: updateSiteChrome,
                    }}
                    designProps={{
                        design: site?.design,
                        onChange: updateDesign,
                    }}
                    analyticsProps={{
                        site,
                        onChange: updateSiteAnalytics,
                        onOpenCookieSettings: () => setActivePageId(COOKIE_VIRTUAL_ID),
                        onOpenAnalytics: onNavigate ? () => onNavigate('admin/website-analytics') : undefined,
                    }}
                    pageProps={{
                        pageIndex,
                        activeBlock,
                        blockEditorTab,
                        onBlockEditorTab: setBlockEditorTab,
                        siteDesign: site?.design,
                        onMetaChange: updatePageMeta,
                        onSeoChange: updatePageSeo,
                        onBlockContentChange: (next) => activePage && activeBlock && updateBlockContent(activePage.id, activeBlock.id, next),
                        onBlockStyleChange: (next) => activePage && activeBlock && updateBlockStyle(activePage.id, activeBlock.id, next),
                        onToggleBlock: toggleBlock,
                    }}
                />
            }
        />
      </CreatePageContext.Provider>
    );
}

// Preview content shaping (buildPreviewContent / chromeStoragePath /
// applyChromeEdit / setIn) lives in ./preview/previewContent.js — a pure,
// unit-tested module. Imported at the top of this file.
