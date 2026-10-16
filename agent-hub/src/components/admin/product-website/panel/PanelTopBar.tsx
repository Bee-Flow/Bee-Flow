import type { PanelView } from './panelView';
import type useCmsAutosave from './useCmsAutosave';
import type useCmsBuilderBridge from './useCmsBuilderBridge';
import type useCmsHistory from './useCmsHistory';
import type useCmsPanelState from './useCmsPanelState';
import type useCmsPublishing from './useCmsPublishing';
import type useCmsSiteOps from './useCmsSiteOps';
import type { BlogEditor } from '../blog/useBlogEditor';
import TopBar from '../shell/TopBar';

interface PanelTopBarProps {
    ps: ReturnType<typeof useCmsPanelState>;
    view: PanelView;
    siteOps: ReturnType<typeof useCmsSiteOps>;
    publish: ReturnType<typeof useCmsPublishing>;
    history: ReturnType<typeof useCmsHistory>['history'];
    retrySave: ReturnType<typeof useCmsAutosave>['retrySave'];
    changeLocaleSafe: ReturnType<typeof useCmsBuilderBridge>['changeLocaleSafe'];
    blog: BlogEditor;
    onExit?: () => void;
    onNavigate?: (path: string) => void;
}

/** The builder's top bar: site/version menu, locale menu, publish, save state and view toggles. */
export default function PanelTopBar({ ps, view, siteOps, publish, history, retrySave, changeLocaleSafe, blog, onExit, onNavigate }: PanelTopBarProps) {
    const manageLanguages = onNavigate ? () => onNavigate('admin/languages') : undefined;
    return (
        <TopBar
            onExit={onExit}
            siteMenuProps={{
                sites: ps.sites,
                versions: view.versions,
                activeSiteId: ps.activeSiteId,
                liveSiteId: ps.liveSiteId,
                onSelectSite: siteOps.handleSwitchSite,
                onCreateSite: siteOps.handleCreateSite,
                onRenameSite: siteOps.handleRenameSite,
                onDeleteSite: siteOps.handleDeleteSite,
                onSetLiveVersion: siteOps.handleSetLiveVersion,
                onDuplicateVersion: siteOps.handleDuplicateSite,
                onExportSite: siteOps.handleExportSite,
                onImportFile: siteOps.handleImportFileChosen,
                ioStatus: siteOps.siteIoStatus,
            }}
            localeMenuProps={{
                locales: ps.locales,
                activeLocale: ps.activeLocale,
                defaultLocale: ps.defaultLocale,
                coverageByLocale: view.coverageByLocale,
                onSelect: changeLocaleSafe,
                onSetDefault: publish.handleSetDefaultLocale,
                onManageLanguages: manageLanguages,
            }}
            publishProps={{
                publishing: ps.publishing,
                publishedAt: ps.publishedAt,
                dirtySincePublish: ps.dirtySincePublish,
                isLive: view.isLive,
                liveSiteName: view.otherLiveSite?.name || null,
                // Pending post edits land before the snapshot is taken.
                onPublish: async (...args: Parameters<typeof publish.handlePublish>) => { await blog.flush(); return publish.handlePublish(...args); },
                onSetLive: publish.persistLive,
            }}
            saveStatus={ps.saveStatus}
            onRetrySave={retrySave}
            view={ps.rightView}
            onViewChange={ps.setRightView}
            device={ps.device}
            onDeviceChange={ps.changeDevice}
            assistantOpen={ps.assistantOpen}
            onToggleAssistant={ps.toggleAssistant}
            assistantRunning={ps.builderRunning}
            history={{
                canUndo: history.canUndo,
                canRedo: history.canRedo,
                onUndo: history.undo,
                onRedo: history.redo,
            }}
            translationMode={ps.activeLocale !== ps.defaultLocale}
            translatingLocaleName={view.activeLocaleName}
            onExitTranslationMode={() => changeLocaleSafe(ps.defaultLocale)}
            navOpen={ps.navOpen}
            onToggleNav={ps.toggleNav}
            inspectorOpen={ps.inspectorOpen}
            onToggleInspector={ps.toggleInspector}
            focusMode={ps.focusMode}
            onToggleFocusMode={ps.toggleFocusMode}
            onOpenAnalytics={onNavigate ? () => onNavigate('admin/website-analytics') : undefined}
            onManageLanguages={manageLanguages}
            isLive={view.isLive}
        />
    );
}
