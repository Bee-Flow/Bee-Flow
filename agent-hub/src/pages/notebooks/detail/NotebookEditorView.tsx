/**
 * NotebookEditorView — one open notebook: the header (title, "View only",
 * "In project X", who else is here, save status), the sources on the left,
 * the document in the middle, the private AI chat on the right, and on
 * demand the outline, the comments and the version history.
 *
 * Role-aware throughout: a viewer reads, previews sources, chats privately
 * and comments are read-only; nothing that would change the notebook is
 * offered. While the notebook is co-edited the page sends no saves of its
 * own: the live session is the save.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, History, ListTree, MessagesSquare } from 'lucide-react';
import RichTextEditorJs from '../../../editor/react/RichTextEditor.jsx';
import CollabPresence from '../../../editor/react/CollabPresence';
import VersionHistoryPanel from '../../../components/versions/VersionHistoryPanel';
import CommentsPanel from '../../../components/comments/CommentsPanel';
import useTranslation from '../../../hooks/useTranslation';
import useRelativeTime from '../../../hooks/useRelativeTime';
import useModelTiers from '../hooks/useModelTiers';
import useExportTargets from '../hooks/useExportTargets';
import useSourcesPolling, { type NotebookSource } from '../hooks/useSourcesPolling';
import NotebookWorkspaceJs from '../NotebookWorkspace';
import NotebookTOCJs from '../NotebookTOC';
import ExportMenu from '../ExportMenu';
import { canEditNotebook, useRenameNotebook, type NotebookDetailData } from '../notebookQueries';
import NotebookTitle from './NotebookTitle';
import NotebookSaveStatus from './NotebookSaveStatus';
import NotebookConflictPanel from './NotebookConflictPanel';
import NotebookStarters from './NotebookStarters';
import NotebookNotice, { type NoticeWithAction } from './NotebookNotice';
import SessionEndedNotice from './SessionEndedNotice';
import { NotebookChatPanel, NotebookOverlays, NotebookSourcesPanel } from './NotebookPanels';
import useNotebookDocument from './useNotebookDocument';
import useNotebookChat from './useNotebookChat';
import useNotebookExports from './useNotebookExports';
import useAiFill from './useAiFill';
import { isEmptyDocument, useMarkNotebookSeen, useNotebookShortcuts } from './notebookBehaviour';
import { useImportFile } from './useImportFile';
import type { NotebookEditorHandle } from './editorHandle';

export interface NotebookEditorViewProps {
    data: NotebookDetailData;
    user: any;
    onBack: () => void;
    onListChanged: () => void;
    onOpenProject: (projectId: string) => void;
    onReload: () => void;
}

const TOC_AUTO_OPEN_AT = 3;
// Untyped JS components: their props are documented where they are defined.
const NotebookWorkspace = NotebookWorkspaceJs as unknown as React.ComponentType<any>;
const RichTextEditor = RichTextEditorJs as unknown as React.ComponentType<any>;
const NotebookTOC = NotebookTOCJs as unknown as React.ComponentType<any>;

export default function NotebookEditorView({ data, user, onBack, onListChanged, onOpenProject, onReload }: NotebookEditorViewProps) {
    const { t, locale } = useTranslation();
    const rel = useRelativeTime();
    const nb = data.notebook;
    const project = data.project;
    const readOnly = !canEditNotebook(nb.role);
    const me = user?.id ? { id: String(user.id), name: user.name || user.displayName || undefined, email: user.email || undefined } : null;

    const [notice, setNotice] = useState<NoticeWithAction | null>(null);
    const showError = useCallback((message: string) => setNotice({ kind: 'error', message }), []);
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
    const editorRef = doc.editorRef as React.MutableRefObject<NotebookEditorHandle | null>;
    const bound = doc.collab.bound;

    const sources = useSourcesPolling({ entityId: nb.id, onError: showError, onChanged: onListChanged });
    const { seedSources } = sources;
    // The sources came with the notebook: they count as an answer at once.
    useEffect(() => { seedSources(data.sources); }, [seedSources, data.sources]);

    const { modelTiers, selectedTier, setSelectedTier } = useModelTiers();
    const { signRequestConfigured, nextcloudConfigured } = useExportTargets();
    const docRef = useRef(doc.autosave.documentContent);
    docRef.current = doc.autosave.documentContent;

    const chat = useNotebookChat({
        notebookId: nb.id,
        selectedTier,
        editorRef,
        getDocument: () => docRef.current,
        getDocVersion: () => doc.autosave.getKnownVersion(),
        bound,
        onDocUpdate: doc.onAiDocUpdate,
        onSourceAdded: (source) => sources.setSources((prev) => [...prev, source as NotebookSource]),
    });
    const exportsApi = useNotebookExports({ notebookId: nb.id, title: nb.name, getContent: () => docRef.current, onNotice: setNotice });
    const aiFill = useAiFill({
        notebookId: nb.id, modelTier: selectedTier, editorRef, onError: showError,
        onApplied: (html) => { if (!bound) void doc.autosave.handleDocSave(html); },
    });
    const importer = useImportFile(nb.id, editorRef, showError);
    const rename = useRenameNotebook(nb.id);
    useMarkNotebookSeen(nb.projectId, nb.id);

    const openVersions = useCallback(() => {
        // Typing inside the save debounce becomes a save first, so the
        // history (and a restore) starts from what is on screen.
        try { editorRef.current?.flush?.(); } catch { /* the save path reports */ }
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

    const onToc = useCallback((items: any[]) => {
        setTocItems(items || []);
        if (!tocTouched.current && (items || []).length >= TOC_AUTO_OPEN_AT) { tocTouched.current = true; setTocOpen(true); }
    }, []);

    const empty = isEmptyDocument(doc.autosave.documentContent);
    const hasExportContent = !empty;
    const showMeetingNotes = user?.featureFlags?.meeting_notes !== false
        && (user?.isAdmin || user?.permissions?.includes('all') || (Array.isArray(user?.betaFeatures) && user.betaFeatures.includes('meeting_notes')));
    const meta = t('notebooks.detail_meta', '{sources} sources · {words} words · Created {when}', {
        sources: sources.sources.length, words: docWords.toLocaleString(locale), when: rel(nb.createdAt),
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
        onNewChat: () => { void chat.newChat(); },
        onRename: readOnly ? undefined : () => setRenameSignal((n) => n + 1),
        onImport: readOnly ? undefined : importer.open,
        onFind: () => editorRef.current?.openFind?.(),
        onShortcuts: () => editorRef.current?.openShortcuts?.(),
    }), [editorRef, readOnly, exportsApi.handleExport, exportsApi.handleNextcloudExport, hasExportContent, signRequestConfigured,
        nextcloudConfigured, openVersions, project, toggleComments, tocItems.length, toggleToc, chat, importer.open]);

    const headerExtras = [
        {
            id: 'toc', icon: ListTree, active: tocOpen, disabled: tocItems.length === 0, onClick: toggleToc,
            label: tocItems.length > 0 ? t('notebooks.toggle_toc', 'Toggle Table of Contents') : t('notebooks.toc_hint', 'Add headings to enable Table of Contents'),
        },
        { id: 'versions', icon: History, label: t('notebooks.version_history', 'Version history'), active: panel === 'versions', onClick: openVersions },
        ...(project ? [{ id: 'comments', icon: MessagesSquare, label: t('notebooks.toggle_comments', 'Comments'), active: panel === 'comments', onClick: toggleComments }] : []),
    ];

    const banners = (
        <>
            <NotebookNotice notice={notice} onDismiss={() => setNotice(null)} />
            {doc.collab.slow && (
                <NotebookNotice
                    notice={{
                        kind: 'info',
                        message: t('notebooks.collab_slow', 'Joining the live session is taking longer than usual. You can wait, or edit on your own; your saves are then checked against everyone else\'s.'),
                        action: { label: t('notebooks.collab_go_solo', 'Edit on my own'), onClick: doc.collab.goSolo },
                    }}
                    onDismiss={doc.collab.goSolo}
                />
            )}
            <SessionEndedNotice notebookId={nb.id} collab={doc.collab} editorRef={editorRef} onReload={onReload} />
            {doc.conflict && (
                <NotebookConflictPanel
                    notebookId={nb.id}
                    conflictVersionId={doc.conflict.conflictVersionId}
                    busy={doc.conflictBusy}
                    error={doc.conflictError}
                    onKeepMine={() => { void doc.keepMine(); }}
                    onUseTheirs={() => { void doc.takeSaved(); }}
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
            <input type="file" ref={importer.inputRef} className="hidden" onChange={importer.onChange} accept=".pdf,.doc,.docx,.txt,.md,.csv,.xlsx" aria-hidden="true" tabIndex={-1} />
            <NotebookWorkspace
                variant="notebook"
                icon={BookOpen}
                title={(
                    <NotebookTitle
                        name={nb.name}
                        canRename={!readOnly}
                        readOnly={readOnly}
                        project={project}
                        editSignal={renameSignal}
                        presence={doc.collab.handle ? <CollabPresence handle={doc.collab.handle} /> : null}
                        onRename={async (name) => { await rename.mutateAsync(name); onListChanged(); }}
                        onOpenProject={onOpenProject}
                    />
                )}
                meta={meta}
                onBack={onBack}
                saveStatus={<NotebookSaveStatus mode={doc.saveMode} lastSavedAt={doc.autosave.lastSavedAt} onRetry={doc.autosave.retrySave} />}
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
                leftDrawer={{
                    label: t('notebooks.sources', 'Sources'),
                    node: <NotebookSourcesPanel sources={sources} readOnly={readOnly} showMeetingNotes={!!showMeetingNotes} />,
                }}
                secondaryLeft={tocOpen && tocItems.length > 0 && (
                    <div className="w-[200px] shrink-0 border-r border-[var(--border-subtle)] bg-[var(--bg-secondary)] flex flex-col overflow-hidden">
                        <NotebookTOC items={tocItems} onClose={toggleToc} onSelect={(index: number) => editorRef.current?.scrollToHeading?.(index)} />
                    </div>
                )}
                secondaryRight={sidePanel}
                rightDrawer={{
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
                                onRestored={doc.onRestored}
                                onClose={() => setPanel(null)}
                                projectId={nb.projectId}
                                currentUserId={me?.id || null}
                                expectedVersion={bound ? null : doc.autosave.getKnownVersion()}
                                title={nb.name}
                            />
                        ) : null}
                    />
                )}
            >
                {!readOnly && empty && !doc.collab.slow && (
                    <NotebookStarters
                        readySourceCount={sources.readySources.length}
                        onDraft={chat.send}
                        onImport={importer.open}
                        onTemplate={(md) => editorRef.current?.insertContent?.(md)}
                    />
                )}
                <RichTextEditor
                    ref={editorRef}
                    onImportClick={readOnly ? undefined : importer.open}
                    content={doc.autosave.documentContent}
                    editable={!readOnly}
                    collab={doc.collab.handle}
                    onChange={doc.onEditorChange}
                    onSave={doc.autosave.handleDocSave}
                    onAIAction={readOnly ? undefined : chat.onEditorAIAction}
                    onAIFill={readOnly ? undefined : aiFill.handleAIFill}
                    aiFilling={aiFill.aiFilling}
                    saving={doc.autosave.docSaving}
                    onTocUpdate={onToc}
                    onWordCountChange={setDocWords}
                    notebookId={nb.id}
                />
            </NotebookWorkspace>
        </>
    );
}
