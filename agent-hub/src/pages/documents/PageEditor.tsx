// A PAGE: a document written in the rich-text editor (BeeEditor), with the
// house style when printed. Filed in a project it is written together, live
// (useCollab: everybody's carets and names, per-person undo, no saving to
// wait for); on its own, or when live editing is switched off, it is saved by
// revision like any document (merged with what others saved meanwhile).
//
// Around the text: who is here, the outline of its headings, find, words,
// comments (in a project), the version history, print and PDF. Viewers read;
// nothing here interrupts typing.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import RichTextEditorJs from '../../editor/react/RichTextEditor';
import type { CommentAnchor } from '../../api/queries/comments';
import { useDocumentSuggestions } from '../../api/queries/suggestions';
import useTranslation from '../../hooks/useTranslation';
import type { OutlineItem } from './canvasBridge';
import type { People, StudioDocument } from './documentQueries';
import type { Conflict } from './useDocumentAutosave';
import ConflictDialog from './editor/ConflictDialog';
import DocumentSidePanels from './editor/DocumentSidePanels';
import type { SidePanel } from './editor/DesignedToolbar';
import EditorNotices from './editor/EditorNotices';
import EditorStatusBar from './editor/EditorStatusBar';
import PageToolbar from './editor/PageToolbar';
import usePageDocument from './editor/usePageDocument';
import { useSaveUnsent } from './editor/usePageRecovery';

export interface PageEditorProps {
    initial: StudioDocument;
    people: People;
    variant: 'page' | 'panel';
    currentUser: { id: string; name?: string } | null;
    onBack?: () => void;
    onRenamed?: (doc: StudioDocument) => void;
    onOpenInStudio?: (id: string) => void;
}

/** The part of the rich-text editor's imperative API a page uses (editor/react/BeeEditor.jsx). */
interface EditorApi {
    flush?: () => string | null;
    setContent?: (html: string) => void;
    replaceDocument?: (html: string) => void;
    openFind?: () => void;
    scrollToHeading?: (index: number) => void;
    getSelectionAnchor?: () => CommentAnchor | null;
    highlightAnchors?: (list: Array<{ id: string; anchor: CommentAnchor }>, activeId?: string | null) => void;
    scrollToAnchor?: (anchor: CommentAnchor) => boolean;
    highlightSuggestions?: (list: Array<{ id: string; anchor: CommentAnchor }>, activeId?: string | null) => void;
    suggestionAtPoint?: (x: number, y: number) => string | null;
    getEditor?: () => { getText?: () => string; getHTML?: () => string } | null;
}
interface TocEntry { textContent: string; level: number; itemIndex: number }

// The editor is plain JS (untyped props): typed here for what a page passes.
const RichTextEditor = RichTextEditorJs as unknown as React.ComponentType<Record<string, unknown> & { ref?: React.Ref<EditorApi> }>;

/**
 * The lines under the toolbar, and "compare" for a kept draft: the draft
 * against the page as it is saved now, the choice saved like a late save.
 */
function PageNotices({ p, onOpenConflict, onOpenHistory }: { p: ReturnType<typeof usePageDocument>; onOpenConflict: () => void; onOpenHistory: () => void }) {
    const [draftCompare, setDraftCompare] = useState<Conflict | null>(null);
    const compare = () => p.draft && setDraftCompare({
        currentVersionId: p.doc.versionId, mine: p.draft.html,
        parts: [{ kind: 'conflict', key: 'draft', label: p.doc.name, base: '', mine: p.draft.html, theirs: p.doc.bodyHtml }],
    });
    return (
        <>
            <EditorNotices
                readOnly={p.readOnly} error={p.error} onDismissError={p.clearError}
                draft={p.draft} onRestoreDraft={() => { p.restoreDraft().catch(() => undefined); }} onCompareDraft={compare} onDiscardDraft={p.discardDraft}
                conflict={!!p.autosave.conflict} onOpenConflict={onOpenConflict} sharing={null}
                merged={p.mergedUnseen} onShowMerged={() => { p.showLatest().catch(() => undefined); }} onDismissMerged={p.dismissMerged}
                keptLive={p.keptLive ? { onOpen: () => { onOpenHistory(); p.dismissKeptLive(); }, onDismiss: p.dismissKeptLive } : null}
            />
            {draftCompare && (
                <ConflictDialog open conflict={draftCompare} onClose={() => setDraftCompare(null)}
                    onSave={async (choices) => { setDraftCompare(null); if (choices.draft === 'theirs') p.discardDraft(); else await p.restoreDraft(); }}
                    onDiscardMine={() => { p.discardDraft(); setDraftCompare(null); }} />
            )}
        </>
    );
}

/**
 * The AI's proposals for this page: the open count for the toolbar, the
 * focused one, and the drawer opening by itself when a NEW batch arrives
 * (batches already waiting when the page was opened do not).
 */
function usePageSuggestions(documentId: string, side: SidePanel, setSide: (s: SidePanel) => void) {
    const query = useDocumentSuggestions(documentId);
    const [focusedId, setFocusedId] = useState<string | null>(null);
    const seen = useRef<Set<string> | null>(null);
    const sideRef = useRef(side);
    sideRef.current = side;
    useEffect(() => {
        if (!query.data) return;
        const ids = new Set(query.data.suggestions.filter(s => s.status === 'open').map(s => s.batchId));
        const before = seen.current;
        seen.current = ids;
        if (before && [...ids].some(id => !before.has(id)) && sideRef.current !== 'suggestions') setSide('suggestions');
    }, [query.data, setSide]);
    return { open: query.data?.open ?? 0, focusedId, setFocusedId };
}

export default function PageEditor({ initial, people, variant, currentUser, onBack, onRenamed, onOpenInStudio }: PageEditorProps) {
    const { t } = useTranslation();
    const editorRef = useRef<EditorApi>(null);
    const p = usePageDocument({ initial, currentUser, editorRef, onRenamed });
    useSaveUnsent(p.collab, p.autosave, useCallback(() => editorRef.current?.getEditor?.()?.getHTML?.() ?? null, []));
    const [side, setSide] = useState<SidePanel>(null);
    const [outline, setOutline] = useState<OutlineItem[]>([]);
    const [words, setWords] = useState<number | null>(null);
    const [conflictOpen, setConflictOpen] = useState(false);
    const sug = usePageSuggestions(initial.id, side, setSide);
    const [canComment, isPanel] = [!!initial.projectId, variant === 'panel'];

    const leave = async () => {
        editorRef.current?.flush?.();
        await p.autosave.flush().catch(() => undefined);
        onBack?.();
    };
    const onToc = (items: TocEntry[]) => setOutline(items.map((it) => ({ index: it.itemIndex, level: Math.min(3, it.level), text: it.textContent, sectionId: null })));
    const resolve = async (choices: Record<string, 'mine' | 'theirs'>) => {
        const saved = await p.autosave.resolveConflict(choices);
        if (saved) { setConflictOpen(false); editorRef.current?.setContent?.(saved.bodyHtml); }
    };

    return (
        <div className="flex flex-col h-full bg-[var(--bg-primary)]" data-testid="page-editor" data-live={p.live ? 'true' : 'false'}>
            <PageToolbar
                doc={p.doc} isPanel={isPanel} readOnly={p.readOnly} live={p.live ? p.collab : null}
                save={{ state: p.autosave.saveState, lastSavedAt: p.autosave.lastSavedAt, onRetry: () => { p.autosave.flush().catch(() => undefined); }, onResolve: () => setConflictOpen(true) }}
                side={side} onSide={setSide} canComment={canComment} openSuggestions={sug.open} downloading={p.downloading}
                onLeave={leave} onRename={p.rename} onFind={() => editorRef.current?.openFind?.()} onPrint={p.print} onDownload={p.download}
                onOpenInStudio={onOpenInStudio ? () => { leave().then(() => onOpenInStudio(initial.id)); } : undefined}
            />
            <PageNotices p={p} onOpenConflict={() => setConflictOpen(true)} onOpenHistory={() => setSide('history')} />
            <div className="flex-1 min-h-0 flex">
                <div className="flex-1 min-w-0 min-h-0 overflow-auto" data-testid="page-body"
                    onClick={(e) => {
                        // A click on a passage the AI proposes to change focuses its suggestion.
                        const id = editorRef.current?.suggestionAtPoint?.(e.clientX, e.clientY);
                        if (id) { sug.setFocusedId(id); setSide('suggestions'); }
                    }}>
                    <div className="max-w-3xl mx-auto h-full">
                        <RichTextEditor
                            ref={editorRef}
                            content={initial.bodyHtml}
                            editable={!p.readOnly}
                            collab={p.live ? p.collab : null}
                            onSave={p.onSave}
                            onTocUpdate={onToc}
                            onWordCountChange={setWords}
                            onUploadImage={p.uploadImage}
                            askAiEnabled={false}
                            placeholder={t('documents.page.placeholder', 'Start writing. Type # and a space for a heading, - for a list.')}
                        />
                    </div>
                </div>
                <DocumentSidePanels
                    side={side} onClose={() => setSide(null)} doc={p.doc} canEdit={!p.readOnly} currentUser={currentUser} people={people}
                    outline={{ items: outline, activeSection: null, busySections: {}, onGo: (item) => editorRef.current?.scrollToHeading?.(item.index) }}
                    onRestored={p.onRestored}
                    expectedVersion={p.live ? null : p.doc.versionId}
                    suggestions={{
                        focusedId: sug.focusedId, onFocus: sug.setFocusedId,
                        highlight: (list, activeId) => editorRef.current?.highlightSuggestions?.(list, activeId),
                        scrollToAnchor: (anchor) => !!editorRef.current?.scrollToAnchor?.(anchor),
                        // A live page follows the accepted edit by itself; a stored one is read again.
                        onAccepted: () => { if (!p.live) p.showLatest().catch(() => undefined); },
                    }}
                    comments={{
                        getSelectionAnchor: () => editorRef.current?.getSelectionAnchor?.() || null,
                        highlightAnchors: (list, activeId) => editorRef.current?.highlightAnchors?.(list, activeId),
                        scrollToAnchor: (anchor) => !!editorRef.current?.scrollToAnchor?.(anchor),
                        getDocumentText: () => editorRef.current?.getEditor?.()?.getText?.() || '',
                    }}
                />
            </div>
            <EditorStatusBar words={words} extra={p.live ? <span>{t('documents.page.live_hint', 'Everyone in the project sees changes as they are typed.')}</span> : null} />
            {p.autosave.conflict && (
                <ConflictDialog open={conflictOpen} conflict={p.autosave.conflict} onSave={resolve}
                    onDiscardMine={async () => { const latest = await p.autosave.discardMine(); setConflictOpen(false); if (latest) editorRef.current?.setContent?.(latest.bodyHtml); }}
                    onClose={() => setConflictOpen(false)} />
            )}
        </div>
    );
}
