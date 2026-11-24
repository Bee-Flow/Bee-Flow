/**
 * NotebookEditorView — one open notebook: the shared Studio header (name with
 * inline rename, "View only", "In project X", who else is here, save status), the sources on the left,
 * the document in the middle, the private AI chat on the right, and on
 * demand the outline, the comments and the version history.
 *
 * Role-aware throughout: a viewer reads, previews sources, chats privately
 * and comments are read-only; nothing that would change the notebook is
 * offered. While the notebook is co-edited the page sends no saves of its
 * own: the live session is the save.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState , useLayoutEffect } from 'react';
import { BookOpen, History, ListTree, Maximize2, MessagesSquare } from 'lucide-react';
import RichTextEditorJs from '@/editor/react/RichTextEditor.jsx';
import CollabPresence from '@/editor/react/CollabPresence';
import VersionHistoryPanel from '@/components/versions/VersionHistoryPanel';
import CommentsPanel from '@/components/comments/CommentsPanel';
import useTranslation from '@/hooks/useTranslation';
import useRelativeTime from '@/hooks/useRelativeTime';
import useViewport from '@/hooks/useViewport';
import useModelTiers from '../hooks/useModelTiers';
import useExportTargets from '../hooks/useExportTargets';
import useSourcesPolling, { type NotebookSource } from '../hooks/useSourcesPolling';
import NotebookWorkspaceJs from '../NotebookWorkspace';
import NotebookTOCJs from '../NotebookTOC';
import ExportMenu from '../ExportMenu';
import { canEditNotebook, useRenameNotebook, type NotebookDetailData } from '../notebookQueries';
import NotebookHeaderStatus from './NotebookHeaderStatus';
import NotebookSaveStatus from './NotebookSaveStatus';
import NotebookConflictPanel from './NotebookConflictPanel';
import NotebookStarters from './NotebookStarters';
import NotebookNotice, { type NoticeWithAction } from './NotebookNotice';
import SessionEndedNotice from './SessionEndedNotice';
import { NotebookChatPanel, NotebookOverlays, NotebookSourcesPanel } from './NotebookPanels';
import useNotebookDocument from './useNotebookDocument';
import useNotebookChat, { type EditorRunOutcome } from './useNotebookChat';
import useNotebookExports from './useNotebookExports';
import useAiFill from './useAiFill';
import { isEmptyDocument, useMarkNotebookSeen, useNotebookShortcuts } from './notebookBehaviour';
import { useImportFile } from './useImportFile';
import type { NotebookEditorHandle } from './editorHandle';
import { errorMessage } from '@/utils/caughtError';
import { logger } from '@/utils/logger';

export interface NotebookEditorViewProps {
    data: NotebookDetailData;
    user: any;
    onBack: () => void;
    onListChanged: () => void;
    onOpenProject: (projectId: string) => void;
    onReload: () => void;
    /**
     * 'page' (Studio, a project) | 'panel' (beside the main chat). In the panel
     * the chat next to it is the AI: no sources drawer and no notebook chat.
     * The editor's AI actions still work there: they change the selected text
     * in place, the editor is veiled while they run, and an answer that changed
     * nothing is shown in the notice bar (there is no notebook chat to read it in).
     */
    variant?: 'page' | 'panel';
    /** Panel only: hand the notebook over to its full page. */
    onOpenInStudio?: () => void;
}

const TOC_AUTO_OPEN_AT = 3;
/** How much of an AI answer the panel's notice bar shows. */
const ANSWER_NOTICE_CHARS = 500;
// Untyped JS components: their props are documented where they are defined (NotebookTOC is typed).
const NotebookWorkspace = NotebookWorkspaceJs as unknown as React.ComponentType<any>;
const RichTextEditor = RichTextEditorJs;
const NotebookTOC = NotebookTOCJs;

export default function NotebookEditorView({ data, user, onBack, onListChanged, onOpenProject, onReload, variant = 'page', onOpenInStudio }: NotebookEditorViewProps) {
    const inPanel = variant === 'panel';
    const { t, resolvedLocale } = useTranslation();
    const rel = useRelativeTime();
    const { isDesktop } = useViewport();
    const nb = data.notebook;
    const project = data.project;
    const readOnly = !canEditNotebook(nb.role);
    const me = user?.id ? { id: String(user.id), name: user.name || user.displayName || undefined, email: user.email || undefined } : null;

    const [notice, setNotice] = useState<NoticeWithAction | null>(null);
    const showError = useCallback((message: string | undefined) => setNotice({ kind: 'error', message }), []);
    const [panel, setPanel] = useState<'versions' | 'comments' | null>(null);
    const [tocItems, setTocItems] = useState<any[]>([]);
    const [tocOpen, setTocOpen] = useState(false);
    const tocTouched = useRef(false);
    const [docWords, setDocWords] = useState(0);
    const [citationSource, setCitationSource] = useState<unknown>(null);
    const [signOpen, setSignOpen] = useState(false);
    const [renameSignal, setRenameSignal] = useState(0);

    const openHistory = useCallback(() => setPanel('versions'), []);
    const doc = useNotebookDocument({ data, user: me, readOnly, onNotice: setNotice, onShowHistory: openHistory });
    // editorRef is split off so the rest of the document state reads as plain
    // values: the compiler treats an object holding a ref as a ref.
    const { editorRef: docEditorRef, ...docState } = doc;
    const editorRef = docEditorRef as React.MutableRefObject<NotebookEditorHandle | null>;
    const bound = docState.collab.bound;

    const sources = useSourcesPolling({ entityId: nb.id, onError: showError, onChanged: onListChanged });
    const { seedSources } = sources;
    // The sources came with the notebook: they count as an answer at once.
    useEffect(() => { seedSources(data.sources); }, [seedSources, data.sources]);

    const { modelTiers, selectedTier, setSelectedTier } = useModelTiers();
    const { signRequestConfigured, nextcloudConfigured } = useExportTargets();
    const docRef = useRef(docState.autosave.documentContent);
    useLayoutEffect(() => {
        docRef.current = docState.autosave.documentContent;
    });

    // Beside the main chat: what an editor AI action came to, in the notice bar.
    const onPanelRunEnd = useCallback(({ docUpdated, answer, failed }: EditorRunOutcome) => {
        if (failed) {
            showError(answer || t('doc_notebook_panel.failed', 'The AI could not finish this. Try again.'));
            return;
        }
        if (docUpdated || !answer) return;
        const cut = answer.length > ANSWER_NOTICE_CHARS;
        setNotice({
            kind: 'info',
            message: cut ? `${answer.slice(0, ANSWER_NOTICE_CHARS).trimEnd()}…` : answer,
            action: cut && onOpenInStudio ? { label: t('doc_notebook_panel.read_in_studio', 'Read it all in Studio'), onClick: onOpenInStudio } : null,
        });
    }, [showError, t, onOpenInStudio]);

    const chat = useNotebookChat({
        notebookId: nb.id,
        selectedTier,
        editorRef,
        getDocument: () => docRef.current,
        getDocVersion: () => docState.autosave.getKnownVersion(),
        bound,
        onDocUpdate: docState.onAiDocUpdate,
        onSourceAdded: (source) => sources.setSources((prev) => [...prev, source as NotebookSource]),
        askInPlace: inPanel,
        onEditorRunEnd: inPanel ? onPanelRunEnd : undefined,
    });
    const busyLabels: Record<string, string> = {
        rewrite: t('doc_notebook_panel.busy_rewrite', 'Rewriting…'),
        shorten: t('doc_notebook_panel.busy_shorten', 'Shortening…'),
        expand: t('doc_notebook_panel.busy_expand', 'Expanding…'),
        ask: t('doc_notebook_panel.busy_ask', 'Working on your question…'),
    };
    // In Studio the notebook chat shows the run; in the panel the editor is veiled instead.
    const aiBusyLabel = inPanel && chat.editorBusy ? busyLabels[chat.editorBusy] ?? busyLabels.ask : undefined;
    const exportsApi = useNotebookExports({ notebookId: nb.id, title: nb.name, getContent: () => docRef.current, onNotice: setNotice });
    const aiFill = useAiFill({
        notebookId: nb.id, modelTier: selectedTier, editorRef, onError: showError,
        onApplied: (html) => { if (!bound) void docState.autosave.handleDocSave(html); },
    });
    const { inputRef: importInputRef, open: openImport, onChange: onImportChange } = useImportFile(nb.id, editorRef, showError);
    const rename = useRenameNotebook(nb.id);
    // The header's inline rename is fire-and-forget: a failure says so in the
    // notice bar (the name snaps back to the saved one) instead of vanishing.
    const renameNotebook = useCallback((name: string) => {
        const next = name.replace(/\s+/g, ' ').trim().slice(0, 500);
        if (!next || next === nb.name) return;
        rename.mutateAsync(next).then(
            () => onListChanged(),
            (e: unknown) => showError(t('notebooks.rename_failed', 'The name could not be saved: {message}', { message: errorMessage(e) })),
        );
    }, [rename, nb.name, onListChanged, showError, t]);
    useMarkNotebookSeen(nb.projectId, nb.id);

    const openVersions = useCallback(() => {
        // Typing inside the save debounce becomes a save first, so the
        // history (and a restore) starts from what is on screen.
        try { editorRef.current?.flush?.(); } catch (err) { logger.debug('the save path reports', err); }
        setPanel((p) => (p === 'versions' ? null : 'versions'));
    }, [editorRef]);
    const toggleComments = useCallback(() => {
        if (!project) return;
        setPanel((p) => {
            if (p === 'comments') editorRef.current?.highlightAnchors?.([]);
            return p === 'comments' ? null : 'comments';
        });
    }, [project, editorRef]);
    const toggleToc = useCallback(() => { tocTouched.current = true; setTocOpen((o) => !o); }, []);
    useNotebookShortcuts({ onHistory: openVersions, onComments: project ? toggleComments : undefined });

    const onToc = useCallback((items: unknown[]) => {
        setTocItems(items || []);
        // Below desktop the outline would cover the editor: it opens only on request there.
        if (isDesktop && !tocTouched.current && (items || []).length >= TOC_AUTO_OPEN_AT) { tocTouched.current = true; setTocOpen(true); }
    }, [isDesktop]);

    const empty = isEmptyDocument(docState.autosave.documentContent);
    const hasExportContent = !empty;
    const showMeetingNotes = user?.featureFlags?.meeting_notes !== false
        && (user?.isAdmin || user?.permissions?.includes('all') || (Array.isArray(user?.betaFeatures) && user.betaFeatures.includes('meeting_notes')));
    const sourceCount = sources.sources.length;
    const wordCount = docWords.toLocaleString(resolvedLocale);
    const meta = t('notebooks.detail_meta_counts', '{sources} · {words} · Created {when}', {
        sources: sourceCount === 1 ? t('notebooks.n_sources_one', '{count} source', { count: sourceCount }) : t('notebooks.n_sources', '{count} sources', { count: sourceCount }),
        words: docWords === 1 ? t('notebooks.n_words_one', '{count} word', { count: wordCount }) : t('notebooks.n_words', '{count} words', { count: wordCount }),
        when: rel(nb.createdAt),
    });

    const commandContext = useMemo(() => ({
        editorRef,
        readOnly,
        onExport: exportsApi.handleExport,
        hasExportContent,
        signRequestConfigured,
        onSign: () => setSignOpen(true),
        nextcloudConfigured,
        onNextcloud: exportsApi.handleNextcloudExport,
        onVersions: openVersions,
        onComments: project ? toggleComments : undefined,
        onToggleToc: tocItems.length ? toggleToc : undefined,
        onNewChat: inPanel ? undefined : () => { void chat.newChat(); },
        onRename: readOnly ? undefined : () => setRenameSignal((n) => n + 1),
        onImport: readOnly ? undefined : openImport,
        onFind: () => editorRef.current?.openFind?.(),
        onShortcuts: () => editorRef.current?.openShortcuts?.(),
    }), [editorRef, readOnly, exportsApi.handleExport, exportsApi.handleNextcloudExport, hasExportContent, signRequestConfigured,
        nextcloudConfigured, openVersions, project, toggleComments, tocItems.length, toggleToc, chat, openImport, inPanel]);

    const headerExtras = [
        {
            id: 'toc', icon: ListTree, active: tocOpen, disabled: tocItems.length === 0, onClick: toggleToc,
            label: tocItems.length > 0 ? t('notebooks.toggle_toc', 'Toggle Table of Contents') : t('notebooks.toc_hint', 'Add headings to enable Table of Contents'),
        },
        { id: 'versions', icon: History, label: t('notebooks.version_history', 'Version history'), active: panel === 'versions', onClick: openVersions },
        ...(project ? [{ id: 'comments', icon: MessagesSquare, label: t('notebooks.toggle_comments', 'Comments'), active: panel === 'comments', onClick: toggleComments }] : []),
        ...(inPanel && onOpenInStudio ? [{ id: 'studio', icon: Maximize2, label: t('documents.open_in_studio', 'Open in Studio'), active: false, onClick: onOpenInStudio }] : []),
    ];

    const banners = (
        <>
            <NotebookNotice notice={notice} onDismiss={() => setNotice(null)} />
            {docState.collab.slow && (
                <NotebookNotice
                    notice={{
                        kind: 'info',
                        message: t('notebooks.collab_slow', 'Joining the live session is taking longer than usual. You can wait, or edit on your own; your saves are then checked against everyone else\'s.'),
                        action: { label: t('notebooks.collab_go_solo', 'Edit on my own'), onClick: docState.collab.goSolo },
                    }}
                    onDismiss={docState.collab.goSolo}
                />
            )}
            <SessionEndedNotice notebookId={nb.id} collab={docState.collab} editorRef={editorRef} onReload={onReload} />
            {docState.conflict && (
                <NotebookConflictPanel
                    notebookId={nb.id}
                    conflictVersionId={docState.conflict.conflictVersionId}
                    busy={docState.conflictBusy}
                    error={docState.conflictError}
                    onKeepMine={() => { void docState.keepMine(); }}
                    onUseTheirs={() => { void docState.takeSaved(); }}
                />
            )}
        </>
    );

    const sidePanel = panel === 'comments' && project ? (
        <div className="w-[320px] shrink-0 border-l border-[var(--border-subtle)] flex flex-col min-h-0">
            <CommentsPanel
                projectId={project.id}
                targetType="notebook"
                targetId={nb.id}
                role={project.role}
                currentUser={me}
                getSelectionAnchor={() => editorRef.current?.getSelectionAnchor?.() ?? null}
                highlightAnchors={(list, activeId) => editorRef.current?.highlightAnchors?.(list, activeId)}
                scrollToAnchor={(anchor) => editorRef.current?.scrollToAnchor?.(anchor) ?? false}
                getDocumentText={() => editorRef.current?.getEditor?.()?.getText?.() ?? ''}
                onClose={toggleComments}
            />
        </div>
    ) : null;

    return (
        <>
            <input type="file" ref={importInputRef} className="hidden" onChange={onImportChange} accept=".pdf,.doc,.docx,.txt,.md,.csv,.xlsx" aria-hidden="true" tabIndex={-1} />
            <NotebookWorkspace
                variant={inPanel ? 'notebook-panel' : 'notebook'}
                kind="document"
                // The notebook glyph, as its row in the Documents library shows it.
                icon={BookOpen}
                title={nb.name}
                onRename={readOnly ? undefined : renameNotebook}
                renameRequest={renameSignal}
                statusChip={(
                    <NotebookHeaderStatus
                        readOnly={readOnly}
                        project={project}
                        meta={meta}
                        presence={docState.collab.handle ? <CollabPresence handle={docState.collab.handle} /> : null}
                        saveStatus={<NotebookSaveStatus mode={docState.saveMode} lastSavedAt={docState.autosave.lastSavedAt} onRetry={docState.autosave.retrySave} />}
                        onOpenProject={onOpenProject}
                    />
                )}
                onBack={onBack}
                backLabel={inPanel ? t('documents.close', 'Close') : t('notebooks.back_to_documents', 'Documents')}
                headerExtras={headerExtras}
                headerActions={(
                    <ExportMenu
                        onExport={exportsApi.handleExport}
                        exporting={exportsApi.exporting}
                        hasContent={hasExportContent}
                        signRequestConfigured={signRequestConfigured}
                        onSignRequest={() => setSignOpen(true)}
                        nextcloudConfigured={nextcloudConfigured}
                        onNextcloudExport={exportsApi.handleNextcloudExport}
                        nextcloudExporting={exportsApi.nextcloudExporting}
                    />
                )}
                leftDrawer={inPanel ? null : {
                    label: t('notebooks.sources', 'Sources'),
                    node: <NotebookSourcesPanel sources={sources} readOnly={readOnly} showMeetingNotes={!!showMeetingNotes} />,
                }}
                secondaryLeft={tocOpen && tocItems.length > 0 && (
                    <div className="w-[200px] shrink-0 border-r border-[var(--border-subtle)] bg-[var(--bg-secondary)] flex flex-col overflow-hidden">
                        <NotebookTOC items={tocItems} onClose={toggleToc} onSelect={(index: number) => editorRef.current?.scrollToHeading?.(index)} />
                    </div>
                )}
                secondaryRight={sidePanel}
                rightDrawer={inPanel ? null : {
                    label: t('notebooks.ai_chat', 'AI Chat'),
                    node: (
                        <NotebookChatPanel
                            chat={chat}
                            modelTiers={modelTiers}
                            selectedTier={selectedTier}
                            onTierChange={setSelectedTier}
                            readOnly={readOnly}
                            privateHint={!!project}
                            sourceCount={sources.sourcesKnown ? sources.readySources.length : null}
                            onCitationClick={setCitationSource}
                        />
                    ),
                }}
                commandContext={commandContext}
                banners={banners}
                overlays={(
                    <NotebookOverlays
                        citationSource={citationSource}
                        onCloseCitation={() => setCitationSource(null)}
                        signOpen={signOpen}
                        onCloseSign={() => setSignOpen(false)}
                        exportsApi={exportsApi}
                        title={nb.name}
                        versions={panel === 'versions' ? (
                            <VersionHistoryPanel
                                baseUrl={`/api/notebooks/${nb.id}`}
                                canEdit={!readOnly}
                                managed={nb.managed}
                                onRestored={docState.onRestored}
                                onClose={() => setPanel(null)}
                                projectId={nb.projectId}
                                currentUserId={me?.id || null}
                                expectedVersion={bound ? null : docState.autosave.getKnownVersion()}
                                title={nb.name}
                            />
                        ) : null}
                    />
                )}
            >
                {!readOnly && !inPanel && empty && !docState.collab.slow && (
                    <NotebookStarters
                        readySourceCount={sources.readySources.length}
                        onDraft={chat.send}
                        onImport={openImport}
                        onTemplate={(md) => editorRef.current?.insertContent?.(md)}
                    />
                )}
                <RichTextEditor
                    ref={editorRef}
                    onImportClick={readOnly ? undefined : openImport}
                    content={docState.autosave.documentContent}
                    editable={!readOnly}
                    collab={docState.collab.handle}
                    onChange={docState.onEditorChange}
                    onSave={docState.autosave.handleDocSave}
                    onAIAction={readOnly ? undefined : chat.onEditorAIAction}
                    askAiEnabled={!readOnly}
                    generatingLabel={aiBusyLabel}
                    onAIFill={readOnly ? undefined : aiFill.handleAIFill}
                    aiFilling={aiFill.aiFilling}
                    saving={docState.autosave.docSaving}
                    onTocUpdate={onToc}
                    onWordCountChange={setDocWords}
                    notebookId={nb.id}
                />
            </NotebookWorkspace>
        </>
    );
}
