import { useCallback } from 'react';
import CmsAssistantPane from './assistant/CmsAssistantPane';
import { CreatePageContext } from './fields';
import CreateFirstSite from './panel/CreateFirstSite';
import PanelInspector from './panel/PanelInspector';
import PanelNavigator from './panel/PanelNavigator';
import PanelStage, { PanelDialogs } from './panel/PanelStage';
import PanelTopBar from './panel/PanelTopBar';
import { derivePanelView } from './panel/panelView';
import useCmsAutosave from './panel/useCmsAutosave';
import useCmsBlockEditing from './panel/useCmsBlockEditing';
import useCmsBlogPanel from './panel/useCmsBlogPanel';
import useCmsBuilderBridge from './panel/useCmsBuilderBridge';
import useCmsContentMutations from './panel/useCmsContentMutations';
import useCmsDerived from './panel/useCmsDerived';
import useCmsHistory from './panel/useCmsHistory';
import useCmsPageMeta from './panel/useCmsPageMeta';
import useCmsPagesTemplates from './panel/useCmsPagesTemplates';
import useCmsPanelState from './panel/useCmsPanelState';
import useCmsPreviewBridge from './panel/useCmsPreviewBridge';
import useCmsPublishing from './panel/useCmsPublishing';
import { useCmsSitePayload, useCmsSitesList } from './panel/useCmsSiteLoader';
import useCmsSiteOps from './panel/useCmsSiteOps';
import CmsBuilderShell from './shell/CmsBuilderShell';
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
// ./inspector/PageInspector.jsx. The derived state, the two load effects, the
// blog entry and the four panes (top bar, navigator, stage, inspector) live
// in ./panel/ as well; this component only wires the hooks together.

// Props (both provided by AdminDashboard's full-bleed branch):
//   onExit()          — leave the builder, back to the admin dashboard
//   onNavigate(path)  — app-level navigation for cross-links
//                       (e.g. 'admin/languages', 'admin/website-analytics')
interface ProductWebsitePanelProps {
    onExit?: () => void;
    onNavigate?: (path: string) => void;
}

export default function ProductWebsitePanel({ onExit, onNavigate }: ProductWebsitePanelProps = {}) {
    const { t } = useTranslation();
    const ps = useCmsPanelState();
    const {
        sites, setSites, sitesLoaded, setSitesLoaded, activeSiteId, setActiveSiteId, activeSiteIdRef,
        loading, setLoading, setError, liveSiteId, setLiveSiteId,
        defaultLocale, setDefaultLocale, locales, setLocales,
        localeOverrides, setLocaleOverrides, aiStatus, setAiStatus,
        site, setSiteDoc, pages, setPages, saveStatus, setSaveStatus,
        setPublishedAt, setPublishing,
        activeLocale, setActiveLocale, activePageId, setActivePageId,
        activeBlockId, setActiveBlockId, setBlockEditorTab,
        rightView, setRightView, setAddBlockRequest,
        setTemplates, pendingTemplatePage, setPendingTemplatePage,
        confirm, setInspectorOpen,
        setDirtySincePublish, translateTier,
        assistantOpen, toggleAssistant,
        builderRunning, setBuilderRunning, builderRunningRef, builderTurnRef,
        builderUndoAvailable, setBuilderUndoAvailable, builderUndoAvailableRef, disarmBuilderUndo,
        iframeRef, previewReadyRef, saveTimerRef, saveStatusTimer, pendingSaves,
        inFlightSaveRef, aiRunningRef, failedSavesRef, localeOverridesRef,
    } = ps;

    const derived = useCmsDerived({ site, pages, activePageId, activeBlockId, activeLocale, defaultLocale, localeOverrides });
    const { activePage, translationMode, pageIndex, previewPage } = derived;

    useCmsSitesList({ activeSiteIdRef, setActiveSiteId, setError, setLiveSiteId, setLoading, setSites, setSitesLoaded });

    const { scheduleSave, flushSaves, retrySave, drainPendingSaves } = useCmsAutosave({
        activeSiteIdRef, builderRunningRef, pendingSaves, saveTimerRef, saveStatusTimer,
        inFlightSaveRef, failedSavesRef, setSaveStatus, setError, setDirtySincePublish,
        localeOverridesRef, setLocaleOverrides,
    });

    const { siteStateRef, pagesStateRef, history, historyResetRef, runHistoryHotkey } = useCmsHistory({
        site, pages, activeLocale, translationMode,
        aiRunningRef, builderRunningRef, disarmBuilderUndo, scheduleSave,
        setSiteDoc, setPages,
    });

    useCmsSitePayload({
        activeSiteId, sites, historyResetRef, pendingSaves,
        setActiveBlockId, setActiveLocale, setActivePageId, setDefaultLocale, setDirtySincePublish, setError,
        setLiveSiteId, setLoading, setLocaleOverrides, setLocales, setPages, setPublishedAt, setSaveStatus, setSiteDoc,
    });

    const mutations = useCmsContentMutations({
        pages, activePage, activePageId, activeLocale, locales, translateTier,
        aiStatus, setAiStatus, localeOverrides, setLocaleOverrides, localeOverridesRef,
        aiRunningRef, activeSiteIdRef, siteStateRef, pagesStateRef,
        history, scheduleSave, drainPendingSaves, confirm,
    });
    const { updatePage, updatePageOverride, updateSiteOverride } = mutations;

    const { builderBridge, changeLocaleSafe } = useCmsBuilderBridge({
        activeSiteIdRef, siteStateRef, pagesStateRef, historyResetRef,
        builderRunningRef, setBuilderRunning, builderTurnRef,
        builderUndoAvailableRef, setBuilderUndoAvailable, disarmBuilderUndo,
        drainPendingSaves, setDirtySincePublish,
        activePageId, setActivePageId, setSiteDoc, setPages,
        localeOverridesRef, setLocaleOverrides, confirm,
        setActiveLocale, activeBlockId, activeLocale, setRightView,
    });

    const blockOps = useCmsBlockEditing({
        site, activePage, activeBlockId, setActiveBlockId, activeLocale, translationMode,
        history, pagesStateRef, updatePage, updateSiteOverride, updatePageOverride,
        localeOverridesRef, setLocaleOverrides, scheduleSave,
        setAddBlockRequest, setInspectorOpen,
    });

    const pagesOps = useCmsPagesTemplates({
        activeSiteIdRef, drainPendingSaves, setActivePageId, pages, updatePage, confirm,
        historyResetRef, setSiteDoc, setPages, locales, setLocales, setLocaleOverrides,
        setPublishedAt, setDirtySincePublish, pendingSaves, inFlightSaveRef,
        builderRunningRef, saveStatus, setTemplates, pendingTemplatePage, setPendingTemplatePage,
    });
    const { handleAddPage, reloadPayload } = pagesOps;

    const publish = useCmsPublishing({
        history, siteStateRef, pagesStateRef,
        activeSiteId, activeSiteIdRef, liveSiteId, setLiveSiteId, sites, confirm, builderRunningRef,
        saveTimerRef, inFlightSaveRef, failedSavesRef, flushSaves,
        setPublishing, setPublishedAt, setDirtySincePublish, setError,
        locales, setDefaultLocale,
    });

    // ── blog ── posts autosave on their own; the index settings ride the site save.
    const blogPanel = useCmsBlogPanel({ activeSiteId, activePageId, site, translationMode, activeLocale, defaultLocale, setDirtySincePublish, t });

    const { selectAndScrollToBlock } = useCmsPreviewBridge({
        iframeRef, previewReadyRef, site, previewPage, activePage, activePageId,
        activeBlockId, setActiveBlockId, setBlockEditorTab, activeLocale,
        translationMode, localeOverrides, builderRunning, builderRunningRef,
        applyIframeEdit: blockOps.applyIframeEdit, runHistoryHotkey,
        handleBlockAction: blockOps.handleBlockAction, handleInsertAt: blockOps.handleInsertAt,
        blogPreview: blogPanel.blogPreview,
    });

    const pageMeta = useCmsPageMeta({
        activePage, updatePage, activeSiteIdRef, builderRunningRef, drainPendingSaves,
        setSaveStatus, setDirtySincePublish, saveStatusTimer, reloadPayload, setError,
    });

    const siteOps = useCmsSiteOps({
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
        (input: { title: string; slug?: string; }) => handleAddPage(input, { keepActive: true }),
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
        return <CreateFirstSite onCreate={siteOps.handleCreateSite} />;
    }

    const view = derivePanelView({
        t, sites, site, pages, locales, localeOverrides, activeSiteId, liveSiteId,
        activePageId, activePage, activeLocale, defaultLocale, rightView,
        isBlogView: blogPanel.isBlogView, translationMode,
    });

    return (
      <CreatePageContext.Provider value={createPageFromPicker}>
        <CmsBuilderShell
            navOpen={ps.navOpen}
            inspectorOpen={ps.inspectorOpen}
            onCloseNav={() => ps.setNavOpen(false)}
            onCloseInspector={() => setInspectorOpen(false)}
            onCloseAiDock={() => ps.setAssistantOpen(false)}
            locked={builderRunning}
            aiDock={assistantOpen ? (
                <CmsAssistantPane
                    siteId={activeSiteId}
                    bridge={builderBridge}
                    pages={pageIndex}
                    translationMode={translationMode}
                    defaultLocaleName={view.defaultLocaleName}
                    canUndoTurn={builderUndoAvailable}
                    onClose={toggleAssistant}
                />
            ) : null}
            dialogs={<PanelDialogs ps={ps} addBlock={blockOps.addBlock} submitTemplate={pagesOps.submitTemplate} />}
            topBar={
                <PanelTopBar
                    ps={ps} view={view} siteOps={siteOps} publish={publish} history={history}
                    retrySave={retrySave} changeLocaleSafe={changeLocaleSafe} blog={blogPanel.blog}
                    onExit={onExit} onNavigate={onNavigate}
                />
            }
            navigator={
                <PanelNavigator
                    ps={ps} entryId={view.entryId} activePage={activePage} translationMode={translationMode}
                    pagesOps={pagesOps} blockOps={blockOps} savePageMeta={pageMeta.savePageMeta}
                    isBlogView={blogPanel.isBlogView} blog={blogPanel.blog}
                />
            }
            stage={
                <PanelStage
                    ps={ps}
                    view={view}
                    onCreateFirstPage={() => handleAddPage({ title: 'Home' })}
                    onSitemapMutated={async () => {
                        // Pull the flyout's server-side changes into panel
                        // state before a stale 'site' save can clobber them.
                        await drainPendingSaves();
                        await reloadPayload();
                    }}
                />
            }
            inspector={
                <PanelInspector
                    ps={ps} {...derived} isChromeView={view.isChromeView}
                    activeLocaleName={view.activeLocaleName} defaultLocaleName={view.defaultLocaleName}
                    mutations={mutations} blockOps={blockOps} publish={publish} pageMeta={pageMeta}
                    selectAndScrollToBlock={selectAndScrollToBlock} blogPanel={blogPanel} onNavigate={onNavigate}
                />
            }
        />
      </CreatePageContext.Provider>
    );
}

// Preview content shaping (buildPreviewContent / chromeStoragePath /
// applyChromeEdit / setIn) lives in ./preview/previewContent.js — a pure,
// unit-tested module.
