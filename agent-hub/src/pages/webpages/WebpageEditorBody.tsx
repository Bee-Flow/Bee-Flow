import type { RefObject } from 'react';
import type { OrgGroup } from '../../api/queries/orgGroups';
import type { RetryModelTiers } from '../../components/chat/MessageItem/MessageActionsRow';
import type useWebpageChat from './hooks/useWebpageChat';
import type { WebpageExtraFiles, useWebpageFileActions } from './hooks/useWebpageExtraFiles';
import type { ContentSetter, PrimaryContent, WebpageRow } from '../../api/webpageEditorTypes';
import WebpageDataTab from './WebpageDataTab';
import WebpageHistoryTab from './WebpageHistoryTab';
import WebpageIDE from './WebpageIDE';
import WebpagePreview from './WebpagePreview';
import type { WebpageSource } from './WebpageSources';
import WebpageUsedByTab from './WebpageUsedByTab';

interface SaveView {
    saveState: string;
    lastSavedAt: Date | null;
    dirtyFiles: Record<string, boolean>;
    persist: () => unknown;
}

interface AudienceHandlers {
    onSetPersonal: () => void;
    onSetEntireOrg: () => void;
    onToggleGroup: (gid: string) => void;
}

export interface WebpageEditorBodyProps {
    activeTab: string;
    pageId: string;
    page: WebpageRow;
    user?: { id?: string } | null;
    isOwner: boolean;
    managed: unknown;
    content: PrimaryContent;
    edits: { html: ContentSetter; css: ContentSetter; js: ContentSetter; extra: (path: string, content: string) => void };
    sources: WebpageSource[];
    setSources: (sources: WebpageSource[]) => void;
    visibleGroups: OrgGroup[];
    audience: AudienceHandlers;
    onRestoreVersion: (vid: string) => Promise<void>;
    onVersionsLoaded: (n: number) => void;
    extras: WebpageExtraFiles;
    fileActions: ReturnType<typeof useWebpageFileActions>;
    chat: ReturnType<typeof useWebpageChat>;
    save: SaveView;
    tiers: { modelTiers: RetryModelTiers; selectedTier: string; onTierChange?: (tier: string) => void };
    onTab: (id: string) => void;
    onDownloadZip: () => Promise<void>;
    onShowInCode: (file?: string) => void;
    focusFile: { key: string; at: number } | null;
    idePaneRef: RefObject<HTMLDivElement | null>;
}

/** The IDE: editors, file tree and the builder chat, wired to the editor's hooks. */
function IdePane(p: WebpageEditorBodyProps) {
    const { chat, extras, fileActions, save } = p;
    const { engine, undo, plans, selection } = chat;
    return (
        <div ref={p.idePaneRef} className="h-full">
            <WebpageIDE
                selected={p.page}
                html={p.content.html} css={p.content.css} js={p.content.js}
                onHtmlChange={p.edits.html}
                onCssChange={p.edits.css}
                onJsChange={p.edits.js}
                dirtyFiles={save.dirtyFiles}
                extraFiles={extras.extraFiles}
                extraContents={extras.extraContents}
                onExtraChange={p.edits.extra}
                onCreateFile={fileActions.handleCreateFile}
                onRenameFile={fileActions.handleRenameFile}
                onDeleteFile={fileActions.handleDeleteFile}
                onUploadAsset={fileActions.handleAssetUpload}
                sources={p.sources}
                onSourcesChange={p.setSources}
                chatMessages={engine.messages}
                chatLoading={engine.isLoading}
                onChatSend={chat.sendFromChat}
                onChatStop={engine.stopGenerating}
                onChatRetry={engine.retryMessage}
                onChatEdit={engine.editAndRegenerate}
                onPlanApprove={plans.handlePlanApprove}
                onPlanReject={plans.handlePlanReject}
                onNewChat={chat.handleNewChat}
                chatMode={chat.chatMode}
                onChatModeChange={chat.handleChatModeChange}
                onSelectionAttach={selection.handleSelectionAttach}
                attachedSelection={selection.attachedSelection}
                onSelectionClear={selection.handleSelectionClear}
                modelTiers={p.tiers.modelTiers}
                selectedTier={p.tiers.selectedTier}
                onTierChange={p.tiers.onTierChange}
                saveState={save.saveState}
                lastSavedAt={save.lastSavedAt}
                onRetrySave={save.persist}
                onVersionsClick={() => p.onTab('history')}
                onDownload={p.onDownloadZip}
                user={p.user}
                // W2: the header owns these now. The IDE keeps its own
                // state as the default so it still works standalone, but
                // while a tab drives it the tab wins.
                devMode={p.activeTab === 'code'}
                onDevModeChange={(next: boolean) => p.onTab(next ? 'code' : 'preview')}
                hideHoistedActions
                turnState={undo.turnState}
                onKeepTurn={undo.handleKeepTurn}
                onUndoTurn={undo.handleUndoTurn}
                onShowInCode={p.onShowInCode}
                focusFile={p.focusFile}
                managed={p.managed}
            />
        </div>
    );
}

/** Body of the open editor: the section the header's strip points at. */
export default function WebpageEditorBody(p: WebpageEditorBodyProps) {
    const { activeTab, pageId, page, isOwner } = p;
    if (activeTab === 'data') {
        return (
            <WebpageDataTab
                webpageId={pageId}
                sources={p.sources}
                onSourcesChange={p.setSources}
                readOnly={!isOwner}
                // The Audience segment draws the same three internal rows as
                // the capsule in the header, with exactly the same write
                // actions. Passed down instead of duplicated: two paths to
                // `is_published` would sooner or later validate differently.
                page={page}
                orgGroups={p.visibleGroups}
                onSetPersonal={isOwner ? p.audience.onSetPersonal : null}
                onSetEntireOrg={isOwner ? p.audience.onSetEntireOrg : null}
                onToggleGroup={isOwner ? p.audience.onToggleGroup : null}
            />
        );
    }
    if (activeTab === 'history') {
        return <WebpageHistoryTab webpageId={pageId} onRestore={p.onRestoreVersion} onLoaded={p.onVersionsLoaded} />;
    }
    if (activeTab === 'usedby') return <WebpageUsedByTab page={page} />;
    if (activeTab === 'preview') {
        return (
            <WebpagePreview
                webpageId={pageId}
                html={p.content.html}
                css={p.content.css}
                js={p.content.js}
                extraFiles={p.extras.extraFiles}
                extraContents={p.extras.extraContents}
                isStreaming={p.chat.engine.isLoading}
                framework={page.settings?.framework}
                runtime={page.settings?.runtime}
            />
        );
    }
    return <IdePane {...p} />;
}
