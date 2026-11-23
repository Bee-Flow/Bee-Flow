// A designed document open for work: a letter, a report, a quote, or a
// presentation. The sheet is the sandboxed frame (DocumentCanvas), always
// editable for the people who may edit it (Viewing / Editing switch), saved as
// it is typed (useDocumentAutosave: merged with what others saved meanwhile,
// "compare and choose" when two people changed the same part), with who else
// is here and in which section, an outline, find, word and page counts,
// print, keyboard shortcuts, the version history and, in a project, comments.
//
// TWO PLACES, ONE EDITOR. `variant` is the only difference between the Studio
// page and the right-hand chat panel: the panel closes rather than going
// back, and offers a jump to the full screen.

import React, { useState } from 'react';
import { templateFillApi } from '@/api/templateFillApi';
import FilledPreview from '@/components/documents/fill/FilledPreview';
import { FILL_LINK } from '@/components/documents/fill/fillStyles';
import useAdjustOnChange from '@/hooks/useAdjustOnChange';
import useTranslation from '@/hooks/useTranslation';
import DocumentCanvas from '../DocumentCanvas';
import DeckOutlineEditor from '../DeckOutlineEditor';
import DocumentWorkspacePanelJs from '../DocumentWorkspacePanel';
import type { People, StudioDocument } from '../documentQueries';
import ConflictDialog from './ConflictDialog';
import DesignedToolbar from './DesignedToolbar';
import DocumentFindBar from './DocumentFindBar';
import DocumentShortcuts from './DocumentShortcuts';
import DocumentSidePanels from './DocumentSidePanels';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import EditorNotices, { readOnlyReasonOf } from './EditorNotices';
import EditorStatusBar from './EditorStatusBar';
import { slideAt } from './useDeckDraft';
import type { WorkspaceHandle } from './useDesignedDocument';
import useDesignedEditor, { type DesignedEditorState } from './useDesignedEditor';
import WorkspaceTabs from './WorkspaceTabs';

// The panel is plain JS (untyped props): typed here for what the editor passes.
const DocumentWorkspacePanel = DocumentWorkspacePanelJs as unknown as React.ComponentType<Record<string, unknown> & { ref?: React.Ref<WorkspaceHandle> }>;

export interface DesignedEditorProps {
    initial: StudioDocument;
    people: People;
    variant: 'page' | 'panel';
    currentUser: { id: string; name?: string } | null;
    onBack?: () => void;
    onRenamed?: (doc: StudioDocument) => void;
    onOpenInStudio?: (id: string) => void;
}

function DeckPane({ e, isPanel }: { e: DesignedEditorState; isPanel: boolean }) {
    const { s, deck, canvasRef } = e;
    return (
        <div className={`${isPanel ? 'h-2/5 w-full' : 'h-2/5 sm:h-auto sm:w-[38%]'} min-w-0 min-h-0 shrink-0 border-r border-b border-[var(--border-subtle)]`} data-testid="deck-outline-pane">
            <DeckOutlineEditor value={s.doc.bodyHtml} epoch={`${s.reloadKey}:${s.panelEpoch}`} disabled={s.readOnly}
                onChange={(text) => { s.autosave.markDirty(text); deck.previewDraft({ bodyHtml: text }); }}
                onCaret={(text, caret) => canvasRef.current?.goto(slideAt(text, caret))} />
        </div>
    );
}

/**
 * What the fill-in tab of a document shows where the sheet is: the document
 * with its values. The page is read again for every revision the form's saves
 * and the editor's own saves make, and follows the field the person is at.
 */
function useFilledView(s: DesignedEditorState['s']) {
    const [revision, setRevision] = useState(s.doc.versionId || '');
    const [spot, setSpot] = useState('');
    useAdjustOnChange([s.doc.versionId], () => setRevision(s.doc.versionId || ''));
    const onSynced = (out: { versionId?: string | null }) => {
        if (out.versionId) setRevision(out.versionId);
        s.fillSynced(out);
    };
    return { revision, spot, setSpot, onSynced };
}

/** Filling in a document shows it with its values; a template (sample data) and a deck (its own viewer) keep the sheet. */
const showsFilled = (e: DesignedEditorState): boolean => e.tab === 'preview' && e.s.doc.kind === 'document' && !e.s.isDeck;

/** The document with its values, over the sheet (which stays as it is underneath, unsaved typing included). */
function FilledView({ e, view }: { e: DesignedEditorState; view: ReturnType<typeof useFilledView> }) {
    const { t } = useTranslation();
    const { s } = e;
    return (
        <div className="absolute inset-0 z-10 bg-[var(--bg-tertiary)]" data-testid="document-filled-view">
            <FilledPreview documentId={s.doc.id} revision={view.revision} load={templateFillApi.preview} spot={view.spot}
                actions={(
                    <button type="button" onClick={e.leaving.attempt(() => e.setTab(null), 'switch')} className={FILL_LINK} data-testid="document-filled-view-close">
                        {s.readOnly ? t('chat_templates.preview_show_text', 'Show the text') : t('chat_templates.preview_edit_text', 'Edit the text')}
                    </button>
                )} />
        </div>
    );
}

function Body({ e, isPanel, currentUser }: { e: DesignedEditorState; isPanel: boolean; currentUser: DesignedEditorProps['currentUser'] }) {
    const { s, frame, canvasRef } = e;
    const isDeck = s.isDeck;
    const view = useFilledView(s);
    const filled = showsFilled(e);
    return (
        <div className={`flex-1 min-h-0 flex ${isPanel && isDeck ? 'flex-col' : 'flex-col sm:flex-row'}`}>
            {isDeck && e.editing && <DeckPane e={e} isPanel={isPanel} />}
            <div className="relative flex-1 min-w-0 min-h-0">
                <div className="h-full w-full" inert={filled}>
                <DocumentCanvas
                    ref={canvasRef} documentId={s.doc.id} editing={e.editing && !isDeck} reloadKey={s.reloadKey} peers={frame.framePeers}
                    onDirty={s.autosave.markDirty} onError={(m) => s.setError(m)} onDeckReady={e.setSlideCount}
                    onCaret={frame.setCaretSection} onOutline={frame.setOutline} onStats={frame.setStats}
                    onSelection={(a) => { frame.selection.current = a; }} onFound={(result) => e.setFind((f) => ({ ...f, result }))} onKey={e.onKey}
                />
                </div>
                {filled && <FilledView e={e} view={view} />}
            </div>
            {e.tab && (
                <DocumentWorkspacePanel ref={e.workspaceRef} key={`${s.doc.id}:${s.panelEpoch}`} doc={s.doc} tab={e.tab} onSave={s.savePatch}
                    onPreviewDraft={isDeck ? e.deck.previewDraft : undefined}
                    onInsert={(key: string) => { e.setMode('editing'); canvasRef.current?.insert(key); }}
                    onSection={(id: string) => canvasRef.current?.section(id)} onBeforeAction={s.flushEditor}
                    onRefresh={e.guarded(s.reload)} onFillSynced={view.onSynced} onFillSpot={view.setSpot} wide={!isPanel && filled} />
            )}
            <DocumentSidePanels
                side={e.side} onClose={() => e.setSide(null)} doc={s.doc} canEdit={!s.readOnly} currentUser={currentUser} people={frame.people}
                outline={{ items: frame.outline, activeSection: frame.caretSection, busySections: frame.busySections, onGo: (item) => canvasRef.current?.scrollTo(item.index) }}
                onRestored={e.onRestored}
                comments={{
                    getSelectionAnchor: () => frame.selection.current,
                    highlightAnchors: (list, activeId) => canvasRef.current?.setAnchors(list, activeId),
                    scrollToAnchor: (anchor) => { canvasRef.current?.reveal(anchor); return true; },
                    getDocumentText: () => frame.stats?.text || '',
                }}
            />
        </div>
    );
}

function Dialogs({ e }: { e: DesignedEditorState }) {
    const { s, conflicts } = e;
    return (
        <>
            {s.autosave.conflict && (
                <ConflictDialog open={conflicts.open} conflict={s.autosave.conflict} busy={conflicts.busy} onSave={conflicts.resolve}
                    onDiscardMine={conflicts.discardMine} onClose={() => conflicts.setOpen(false)} />
            )}
            {conflicts.draftCompare && (
                <ConflictDialog open conflict={conflicts.draftCompare} onSave={conflicts.saveDraftChoice}
                    onDiscardMine={() => { s.discardDraft(); conflicts.closeDraft(); }} onClose={conflicts.closeDraft} />
            )}
            <DocumentShortcuts open={e.shortcutsOpen} onClose={() => e.setShortcutsOpen(false)} />
            <UnsavedLeaveDialog e={e} />
        </>
    );
}

/** A save failed on the way out: leave without it, or stay and fix it. */
function UnsavedLeaveDialog({ e }: { e: DesignedEditorState }) {
    const { t } = useTranslation();
    const pending = e.leaving.pending;
    return (
        <ConfirmDialog open={!!pending} destructive
            title={t('doc_editor.unsaved_title', 'Your latest changes could not be saved')}
            description={t('doc_editor.unsaved_reason', 'The reason: {reason}', { reason: pending?.reason || '' })}
            confirmLabel={pending?.kind === 'switch' ? t('doc_editor.switch_without_saving', 'Continue without saving') : t('doc_editor.leave_without_saving', 'Leave without saving')}
            cancelLabel={t('doc_editor.stay', 'Stay')}
            onConfirm={e.leaving.leaveAnyway} onCancel={e.leaving.stay} />
    );
}

function Header({ e, isPanel, onBack, onOpenInStudio }: { e: DesignedEditorState; isPanel: boolean; onBack?: () => void; onOpenInStudio?: (id: string) => void }) {
    const { s, frame, conflicts, leaving } = e;
    return (
        <>
            <DesignedToolbar
                doc={s.doc} isPanel={isPanel} readOnly={s.readOnly} mode={e.editing ? 'editing' : 'viewing'} onMode={e.setMode}
                save={{ state: s.autosave.saveState, lastSavedAt: s.autosave.lastSavedAt, onRetry: e.guarded(s.autosave.flush), onResolve: () => conflicts.setOpen(true) }}
                presence={{ peers: frame.presence.peers, people: frame.people, sectionLabel: frame.sectionLabel }}
                side={e.side} onSide={e.setSide} canComment={e.canComment} findOpen={e.find.open} onFind={e.openFind} onShortcuts={() => e.setShortcutsOpen(true)}
                downloading={s.downloading} onLeave={leaving.attempt(() => onBack?.())} onRename={s.rename} nameKey={s.nameKey} onToggleHouseStyle={s.toggleHouseStyle}
                onOpenInStudio={onOpenInStudio ? leaving.attempt(() => onOpenInStudio(s.doc.id)) : undefined}
                onPrint={s.print} onDownload={s.download}
            />
            <WorkspaceTabs isDeck={s.isDeck} tab={e.tab} slideCount={e.slideCount} onTab={(next) => { leaving.attempt(() => e.setTab(next), 'switch')(); }} />
            <EditorNotices
                readOnly={s.readOnly} readOnlyReason={readOnlyReasonOf(s.doc)} error={s.error} onDismissError={s.clearError}
                inputNeeded={s.inputNeeded ? { reason: s.inputNeeded, onFill: () => { s.clearInputNeeded(); e.setTab('preview'); }, onDismiss: s.clearInputNeeded } : null}
                draft={s.draft} onRestoreDraft={s.restoreDraft} onCompareDraft={conflicts.compareDraft} onDiscardDraft={s.discardDraft}
                conflict={!!s.autosave.conflict} onOpenConflict={() => conflicts.setOpen(true)}
                sharing={frame.sharing} merged={s.mergedUnseen} onShowMerged={e.guarded(s.reload)} onDismissMerged={s.dismissMerged}
            />
            {s.notice && <p className="px-4 py-2 text-xs border-b border-[var(--border-subtle)] bg-[var(--warning)]/10 text-[var(--text-primary)]" role="status">{s.notice}</p>}
            {e.find.open && !s.isDeck && <DocumentFindBar result={e.find.result} focusSignal={e.find.focus} onFind={e.onFind} onClose={e.closeFind} />}
            {s.isDeck && e.editing && e.deck.previewError && <p className="px-4 py-1.5 text-xs text-[var(--error)]" data-testid="document-preview-error">{e.deck.previewError}</p>}
        </>
    );
}

export default function DesignedEditor({ initial, people, variant, currentUser, onBack, onRenamed, onOpenInStudio }: DesignedEditorProps) {
    const { t } = useTranslation();
    const isPanel = variant === 'panel';
    const e = useDesignedEditor({ initial, people, currentUserId: currentUser?.id || null, onRenamed, fullScreen: !isPanel });
    const { s, frame } = e;
    const words = s.isDeck ? null : frame.stats?.words ?? null;
    // While the document is shown with its values the sheet is covered: nothing is typed in it.
    const typing = e.editing && !showsFilled(e);
    return (
        <div className="flex flex-col h-full bg-[var(--bg-primary)]" data-testid="designed-editor">
            <Header e={e} isPanel={isPanel} onBack={onBack} onOpenInStudio={onOpenInStudio} />
            <Body e={e} isPanel={isPanel} currentUser={currentUser} />
            <EditorStatusBar words={words} pages={s.isDeck ? null : frame.stats?.pages ?? null} slides={s.isDeck ? e.slideCount : null}
                where={typing ? frame.sectionLabel(frame.caretSection) : null}
                extra={typing && !s.isDeck ? <span>{t('documents.edit_hint_short', 'Pasted text arrives as plain text, so the layout survives.')}</span> : null} />
            <Dialogs e={e} />
        </div>
    );
}
