import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import './vscode-theme.css';
import ActivityBar from './ActivityBar';
import IdeCenter from './ide/IdeCenter';
import IdeChatPanel from './ide/IdeChatPanel';
import { resolveActiveView, statusActiveFile } from './ide/ideFiles';
import type { WebpageIDEProps } from './ide/ideProps';
import IdeSidebar from './ide/IdeSidebar';
import IdeTopBar from './ide/IdeTopBar';
import { useDevMode, useOpenFiles, useResponsiveChat } from './ide/useIdeState';
import { useDragResize } from './ide/resizeHooks';
import StatusBar from './StatusBar';
import { useBfMarks } from './WebpageCodeStrip';
import type { ExtraContents, ExtraFileMeta } from './webpageEditorTypes';

export type { WebpageIDEProps } from './ide/ideProps';

const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 400;
const CHAT_MIN = 240;
const CHAT_MAX = 520;
// Night mode removed — the webpages IDE is light-only (blends with the host
// app's light theme; Monaco uses 'vs').
const THEME = 'light';
const NO_EXTRA_FILES: ExtraFileMeta[] = [];
const NO_EXTRA_CONTENTS: ExtraContents = {};

/**
 * The webpage IDE: a slim top bar, the developer view's activity bar and
 * sidebar, the editor + preview column and the builder chat. Without the
 * developer view it is the simplified surface: preview + chat + upload.
 */
export default function WebpageIDE(props: WebpageIDEProps) {
    const {
        selected, html, css, js, user, managed = null, hideHoistedActions = false,
        extraFiles = NO_EXTRA_FILES, extraContents = NO_EXTRA_CONTENTS, onUploadAsset,
    } = props;
    const { devMode, toggleDevMode } = useDevMode(props.devMode, props.onDevModeChange);

    // Owner gate — only the page owner can mutate files / upload assets. Viewers
    // (org-shared pages) get a read-only explorer and no upload affordances.
    const isOwner = !!(selected && user && selected.userId === user.id) && !managed;

    // Top-bar "Add image" upload (reachable in the simplified surface where the
    // file explorer is hidden).
    const topUploadRef = useRef<HTMLInputElement | null>(null);
    const onTopUploadPicked = (e: ChangeEvent<HTMLInputElement>) => {
        Array.from(e.target.files || []).forEach(f => onUploadAsset?.(f, 'assets'));
        e.target.value = '';
    };

    // Active pane in sidebar — starts null so the sidebar is collapsed and the
    // preview takes full width. Clicking an activity-bar icon expands; clicking
    // the same icon again collapses.
    const [sidebarPane, setSidebarPane] = useState<string | null>(null);
    const files = useOpenFiles(props.focusFile);
    const { activeKey } = files;
    const [cursor, setCursor] = useState({ line: 1, col: 1 });

    /* The marks of the Code tab: one reading, two users — the strip draws its
     * legend with it and Monaco its decorations. The source is
     * GET /:id/bindings, which is owner-only, so a viewer does not ask for it
     * (the strip shows them the owner-only sentence instead). `lastSavedAt`
     * is the reload key: the server reads the SAVED copy, so after every
     * successful save the line numbers are right again. */
    const bfMarks = useBfMarks(selected?.id, { enabled: devMode && isOwner, reloadKey: props.lastSavedAt });

    const [sidebarWidth, onSidebarDrag, onSidebarKey] = useDragResize(220, SIDEBAR_MIN, SIDEBAR_MAX);
    const [chatWidth, onChatDrag, onChatKey] = useDragResize(340, CHAT_MIN, CHAT_MAX);
    const { rootRef, chatOpen: chatOpenState, setChatOpen } = useResponsiveChat();
    const chatOpen = chatOpenState && !managed;

    // Per-tab dirty dots, keyed by tab id with truthy values for unsaved.
    const dirtyFiles = props.dirtyFiles || {};
    const { onHtmlChange, onCssChange, onJsChange, onExtraChange } = props;
    const activeView = useMemo(() => resolveActiveView(activeKey, {
        content: { html, css, js }, extraFiles, extraContents, onExtraChange,
        onPrimaryChange: { html: onHtmlChange, css: onCssChange, js: onJsChange },
    }), [activeKey, html, css, js, extraFiles, extraContents, onHtmlChange, onCssChange, onJsChange, onExtraChange]);
    // Status-bar file size for the active text file. Binary/db are 0.
    const fileSize = activeView?.kind === 'text' ? new Blob([activeView.value]).size : 0;

    return (
        <div ref={rootRef} data-vscode-theme={THEME} className="flex flex-col" style={{ height: '100%', width: '100%', overflow: 'hidden' }}>
            <input ref={topUploadRef} type="file" multiple accept="image/*,.svg,.woff,.woff2,.ttf,.otf,.ico,.mp3,.mp4,.webm" style={{ display: 'none' }} onChange={onTopUploadPicked} />
            <IdeTopBar
                devMode={devMode} toggleDevMode={toggleDevMode} hideHoistedActions={hideHoistedActions}
                isOwner={isOwner} chatOpen={chatOpen} managed={managed}
                saveState={props.saveState} lastSavedAt={props.lastSavedAt} onRetrySave={props.onRetrySave}
                onUploadAsset={onUploadAsset} onDownload={props.onDownload} onVersionsClick={props.onVersionsClick}
                onOpenChat={() => setChatOpen(true)} onPickUpload={() => topUploadRef.current?.click()}
            />
            {/* Main body: activity bar + sidebar + center + chat */}
            <div className="flex flex-1 min-h-0">
                {devMode && <ActivityBar active={sidebarPane} onSelect={(id: string) => setSidebarPane(prev => (prev === id ? null : id))} />}
                {devMode && sidebarPane !== null && (
                    <IdeSidebar
                        {...props} extraFiles={extraFiles} pane={sidebarPane} width={sidebarWidth} isOwner={isOwner}
                        activeKey={activeKey} dirtyFiles={dirtyFiles} openFile={files.openFile}
                        onResizeMouseDown={onSidebarDrag} onResizeKey={onSidebarKey}
                    />
                )}
                <IdeCenter
                    selected={selected} html={html} css={css} js={js} devMode={devMode} isOwner={isOwner}
                    extraFiles={extraFiles} extraContents={extraContents} dirtyFiles={dirtyFiles} bfMarks={bfMarks}
                    files={files} activeView={activeView} onCursorChange={setCursor}
                    onSelectionAttach={props.onSelectionAttach} chatLoading={props.chatLoading}
                />
                {/* Chat resize handle + panel — collapsible on narrow layouts. */}
                {chatOpen && <IdeChatPanel {...props} width={chatWidth} onResizeMouseDown={onChatDrag} onResizeKey={onChatKey} />}
            </div>
            {/* Status bar — developer view only (its controls live in the top
                bar in the simplified surface). */}
            {devMode && (
                <StatusBar
                    activeFile={statusActiveFile(activeKey)}
                    cursor={cursor}
                    fileSize={fileSize}
                    saveState={props.saveState}
                    lastSavedAt={props.lastSavedAt}
                    onRetrySave={props.onRetrySave}
                    onDownload={props.onDownload}
                    onVersions={props.onVersionsClick}
                />
            )}
        </div>
    );
}
