// Studio → Documents: the library. Pages, designed documents and
// presentations; templates and reusable sections in their own views; folders,
// categories, the archive with its way back; a gallery to start from; the
// house style. Opening one shows the editor for its kind (DocumentEditor).

import { Archive, Plus, Stamp } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import React, { useEffect, useState } from 'react';
import PagerJs from '../../components/shared/Pager';
import useTranslation from '../../hooks/useTranslation';
import { projectErrorText } from '../../components/projects/workspace/projectErrorText';
import DocumentEditor from './DocumentEditor';
import HouseStylePanel from './HouseStylePanel';
import { docKeys, useFolders, useLibrary, useSessionUser, type LibraryRow } from './documentQueries';
import FolderSidebar from './library/FolderSidebar';
import { BulkBar, LibraryFilterBar } from './library/LibraryControls';
import LibraryList from './library/LibraryList';
import StarterGallery, { type NewChoice } from './library/StarterGallery';
import { PAGE_SIZE, useLibraryActions, useLibraryFilters, type LibraryKind, type NewDocumentInput } from './library/useLibrary';

// The pager is plain JS (untyped props): typed here for what the library passes.
const Pager = PagerJs as unknown as React.ComponentType<{ offset: number; limit: number; total: number | null; onOffset: (offset: number) => void; testId?: string }>;

export interface DocumentsPageProps {
    initialDocumentId?: string | null;
    onDocumentChange?: (id: string | null) => void;
}

const BUTTON = 'inline-flex items-center gap-2 rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-sm text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)] disabled:opacity-50';
const VIEW = 'rounded-lg px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)]';

type Translate = ReturnType<typeof useTranslation>['t'];

/** What a choice in the gallery creates, in the library view it was made from. */
export function newDocumentInput(choice: NewChoice, view: LibraryKind, t: Translate): Omit<NewDocumentInput, 'locale' | 'folderId'> {
    if (choice.type === 'page') return { name: t('documents.untitled_page', 'Untitled page'), docType: 'page', kind: 'document' };
    // A presentation is never a reusable section.
    const deckKind: LibraryKind = view === 'section' ? 'document' : view;
    if (choice.starter) return { name: choice.starter.name, starterId: choice.starter.id, kind: choice.type === 'deck' ? deckKind : view };
    if (choice.type === 'deck') return { name: t('documents.untitled_deck', 'Untitled presentation'), docType: 'presentation', bodyHtml: '', css: '', kind: deckKind };
    return { name: t('documents.untitled', 'Untitled document'), kind: view };
}

function useLibraryPage() {
    const { t, locale } = useTranslation();
    const f = useLibraryFilters();
    const list = useLibrary(f.filters);
    const folders = useFolders();
    const actions = useLibraryActions();
    const me = useSessionUser(true);
    const [selection, setSelection] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);
    const fail = (e: unknown) => setError(projectErrorText(t, e as Error) || (e as Error)?.message || t('documents.library.action_failed', 'That did not work. Please try again.'));
    useEffect(() => { setSelection([]); }, [f.filters]);
    // The assistant made or changed a document in a chat: the list may be stale.
    const qc = useQueryClient();
    useEffect(() => {
        const refresh = () => { qc.invalidateQueries({ queryKey: docKeys.all }); };
        window.addEventListener('beeflow:document-updated', refresh);
        return () => window.removeEventListener('beeflow:document-updated', refresh);
    }, [qc]);
    return { t, locale, f, list, folders, actions, me, selection, setSelection, error, setError, fail };
}

function LibraryHeader({ onHouseStyle, onNew }: { onHouseStyle: () => void; onNew: () => void }) {
    const { t } = useTranslation();
    return (
        <header className="flex flex-wrap items-start gap-3">
            <div className="flex-1">
                <h1 className="text-2xl font-bold">{t('documents.title', 'Documents')}</h1>
                <p className="text-sm mt-1 text-[var(--text-tertiary)]">{t('documents.library.subtitle', 'Pages, designed documents and presentations. Design once, adapt to every customer.')}</p>
            </div>
            <button type="button" className={BUTTON} data-testid="documents-house-style" onClick={onHouseStyle}><Stamp size={16} aria-hidden="true" />{t('documents.style.button', 'House style')}</button>
            <button type="button" className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]" onClick={onNew} data-testid="documents-new">
                <Plus size={16} aria-hidden="true" />{t('documents.new_button', 'New document')}
            </button>
        </header>
    );
}

function LibraryViews({ kind, archived, onView }: { kind: LibraryKind; archived: boolean; onView: (kind: LibraryKind | null, archived: boolean) => void }) {
    const { t } = useTranslation();
    const views: Array<[LibraryKind, string]> = [['document', t('documents.library.documents', 'Documents')], ['template', t('documents.library.templates', 'Templates')], ['section', t('documents.library.sections', 'Reusable sections')]];
    const on = 'bg-[var(--bg-tertiary)] font-semibold text-[var(--text-primary)]';
    return (
        <nav className="flex flex-wrap gap-2 border-b border-[var(--border-subtle)] pb-3" aria-label={t('documents.library.views', 'Library views')}>
            {views.map(([key, label]) => (
                <button type="button" key={key} aria-pressed={!archived && kind === key} className={`${VIEW} ${!archived && kind === key ? on : ''}`} onClick={() => onView(key, false)}>{label}</button>
            ))}
            <button type="button" aria-pressed={archived} className={`${VIEW} ml-auto inline-flex items-center gap-1.5 ${archived ? on : ''}`} onClick={() => onView(null, !archived)} data-testid="documents-archived-view">
                <Archive size={14} aria-hidden="true" />{t('documents.library.archived', 'Archived')}
            </button>
        </nav>
    );
}

/** Which of the running actions is busy with which row. */
function busyRow(actions: ReturnType<typeof useLibraryActions>): string | null {
    for (const m of [actions.duplicate, actions.archive, actions.unarchive]) if (m.isPending) return String(m.variables || '');
    return null;
}

/** The list column: bulk actions, the rows, the pager. */
function LibraryMain({ p, onOpen, onCreate }: { p: ReturnType<typeof useLibraryPage>; onOpen: (id: string) => void; onCreate: () => void }) {
    const { f, list, actions } = p;
    const rows: LibraryRow[] = list.data?.documents || [];
    const selectedRows = rows.filter((r) => p.selection.includes(r.id));
    const filtered = !!(f.query || f.category || f.visibility || f.format || f.folderId !== undefined);
    const status = list.isError && !list.data ? 'error' : list.isPending ? 'loading' : 'ok';
    return (
        <main className="space-y-3 min-w-0">
            <BulkBar count={selectedRows.length} folders={p.folders.data || []} busy={actions.bulk.isPending} onClear={() => p.setSelection([])}
                onMove={(folderId) => actions.bulk.mutate({ rows: selectedRows, patch: { folderId } }, { onError: p.fail })}
                onCategorise={(categories) => actions.bulk.mutate({ rows: selectedRows, patch: { categories } }, { onError: p.fail })} />
            <LibraryList
                rows={rows} people={list.data?.people || {}} currentUserId={p.me.data?.id || null}
                status={status} refreshing={list.isFetching && !list.isPending}
                archivedView={f.archived} filtered={filtered} selection={p.selection} onSelect={p.setSelection} busyId={busyRow(actions)}
                onOpen={(row) => onOpen(row.id)} onRetry={() => list.refetch()} onCreate={onCreate}
                onDuplicate={(row) => actions.duplicate.mutate(row.id, { onSuccess: (doc) => onOpen(doc.id), onError: p.fail })}
                onArchive={(row) => actions.archive.mutateAsync(row.id).catch(p.fail)}
                onUnarchive={(row) => actions.unarchive.mutate(row.id, { onError: p.fail })}
            />
            <Pager offset={f.offset} limit={PAGE_SIZE} total={list.data?.total ?? null} onOffset={f.setOffset} testId="documents-pager" />
        </main>
    );
}

export default function DocumentsPage({ initialDocumentId = null, onDocumentChange }: DocumentsPageProps) {
    const p = useLibraryPage();
    const { t, f, actions } = p;
    const [selectedId, setSelectedId] = useState<string | null>(initialDocumentId);
    const [showHouseStyle, setShowHouseStyle] = useState(false);
    const [galleryOpen, setGalleryOpen] = useState(false);
    useEffect(() => { setSelectedId(initialDocumentId); }, [initialDocumentId]);
    const select = (id: string | null) => { setSelectedId(id); onDocumentChange?.(id); };

    const create = async (choice: NewChoice) => {
        const doc = await actions.create.mutateAsync({ ...newDocumentInput(choice, f.kind, t), locale: p.locale, folderId: f.folderId || undefined });
        setGalleryOpen(false);
        select(doc.id);
    };

    if (showHouseStyle) return <HouseStylePanel onBack={() => setShowHouseStyle(false)} />;
    if (selectedId) return <DocumentEditor key={selectedId} documentId={selectedId} onBack={() => select(null)} currentUser={p.me.data || null} />;

    return (
        <div className="h-full overflow-auto text-[var(--text-primary)] bg-[var(--bg-primary)]" data-testid="documents-library">
            <div className="max-w-7xl mx-auto p-5 md:p-8 space-y-5">
                <LibraryHeader onHouseStyle={() => setShowHouseStyle(true)} onNew={() => { actions.create.reset(); setGalleryOpen(true); }} />
                <LibraryViews kind={f.kind} archived={f.archived} onView={(kind, archived) => { f.setArchived(archived); if (kind) f.setKind(kind); }} />
                <LibraryFilterBar f={f} />
                {p.error && <div role="alert" className="flex gap-3 p-3 rounded-lg text-sm bg-[var(--error)]/10"><span className="flex-1">{p.error}</span><button type="button" className="underline" onClick={() => p.setError(null)}>{t('documents.dismiss', 'Dismiss')}</button></div>}
                <div className="grid md:grid-cols-[220px_1fr] gap-6">
                    <FolderSidebar folders={p.folders.data || []} folderId={f.folderId} onFolder={f.setFolderId} busy={actions.createFolder.isPending}
                        onCreate={(name) => actions.createFolder.mutateAsync({ name, parentId: f.folderId || null }).catch((e) => { p.fail(e); throw e; })}
                        onDelete={(folder) => actions.deleteFolder.mutateAsync(folder.id).catch((e) => { p.fail(e); throw e; })} />
                    <LibraryMain p={p} onOpen={select} onCreate={() => setGalleryOpen(true)} />
                </div>
                <StarterGallery open={galleryOpen} busy={actions.create.isPending} onClose={() => setGalleryOpen(false)}
                    error={actions.create.error ? projectErrorText(t, actions.create.error) || actions.create.error.message : null}
                    onChoose={(choice) => { create(choice).catch(() => undefined); }} />
            </div>
        </div>
    );
}
