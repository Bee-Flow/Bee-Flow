// Studio → Documents: the library. Pages, notebooks, designed documents and
// presentations; templates and reusable sections in their own views; folders,
// categories, the archive with its way back; a gallery to start from; the
// house style. Opening one shows the editor for its kind (DocumentEditor), or,
// for a notebook, the notebook workspace (pages/documents/notebook/detail).
//
// The page follows Studio's overview language (the Agents and Automations
// overviews): an 18px title with its count and a one-line intro, the search
// box and the actions on the same row, pills for the views and the types.

import { Plus, Stamp } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import React, { Suspense, useEffect, useState } from 'react';
import PagerJs from '../../components/shared/Pager';
import useTranslation, { readingLocale } from '../../hooks/useTranslation';
import { lazy } from '../../utils/lazyWithReload';
import { projectRoutePath } from '../../utils/projectRoutes';
import { projectErrorText } from '../../components/projects/workspace/projectErrorText';
import DocumentEditor from './DocumentEditor';
import HouseStylePanel from './HouseStylePanel';
import { docKeys, useFolders, useLibrary, useSessionUser, type LibraryRow } from './documentQueries';
import FolderSidebar from './library/FolderSidebar';
import { BulkBar, LibraryFilterBar, LibrarySearch, LibraryViews } from './library/LibraryControls';
import LibraryList from './library/LibraryList';
import DocumentSharingDialog from './library/DocumentSharingDialog';
import EncryptionUnlock, { isKeyUnavailable } from './library/EncryptionUnlock';
import StarterGallery, { type NewChoice } from './library/StarterGallery';
import { PAGE_SIZE, isNotebookRow, useLibraryActions, useLibraryFilters, type LibraryKind, type NewDocumentInput } from './library/useLibrary';
import { notebookIdOf, notebookRef } from './notebookRef';

// The pager is plain JS (untyped props): typed here for what the library passes.
const Pager = PagerJs as unknown as React.ComponentType<{ offset: number; limit: number; total: number | null; onOffset: (offset: number) => void; testId?: string }>;
// The notebook workspace carries the editor, the sources and the chat: loaded
// only when a notebook is opened.
const NotebookDetail = lazy(() => import('./notebook/detail/NotebookDetail')) as unknown as React.ComponentType<{
    notebookId: string; user: unknown; onBack: () => void; onListChanged: () => void; onOpenProject: (projectId: string) => void;
}>;

export interface DocumentsPageProps {
    /** Studio exposes organisation management; the member workspace does not. */
    mode?: 'workspace' | 'studio';
    /** The open item: a document id, or `notebook/<id>` for a notebook (notebookRef). */
    initialDocumentId?: string | null;
    onDocumentChange?: (id: string | null) => void;
    /** The signed-in user as the app holds it (permissions, flags): what a notebook reads. */
    user?: unknown;
}

const SECONDARY = 'inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] border border-[var(--border-default)] text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-primary)]';
const PRIMARY = 'inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-xs font-semibold bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-primary)]';

type Translate = ReturnType<typeof useTranslation>['t'];

/** What a choice in the gallery creates, in the library view it was made from. */
export function newDocumentInput(choice: Exclude<NewChoice, { type: 'notebook' } | { type: 'spreadsheet' }>, view: LibraryKind, t: Translate): Omit<NewDocumentInput, 'locale' | 'folderId'> {
    // Own templates are offered in a project only; here one would be a copy by name.
    if (choice.type === 'template') return { name: choice.template.name, kind: view };
    if (choice.type === 'page') return { name: t('documents.untitled_page', 'Untitled page'), docType: 'page', kind: 'document' };
    // A presentation is never a reusable section.
    const deckKind: LibraryKind = view === 'section' ? 'document' : view;
    if (choice.starter) return { name: choice.starter.name, starterId: choice.starter.id, kind: choice.type === 'deck' ? deckKind : view };
    if (choice.type === 'deck') return { name: t('documents.untitled_deck', 'Untitled presentation'), docType: 'presentation', bodyHtml: '', css: '', kind: deckKind };
    return { name: t('documents.untitled', 'Untitled document'), kind: view };
}

/** Open a project inside the app (the app routes on the URL, like the back button). */
function openProjectInApp(projectId: string) {
    window.history.pushState({ page: 'projects' }, '', projectRoutePath(projectId, 'notebooks'));
    window.dispatchEvent(new PopStateEvent('popstate'));
}

function useLibraryPage() {
    const { t, locale: preferred, strings } = useTranslation();
    // Templates follow the language on screen, not the stored preference.
    const locale = readingLocale(preferred, strings, ['documents.new.title']);
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
    // Whether this reader may have notebooks: the server answers with the list.
    const notebooks = list.data?.notebooks === true;
    const spreadsheets = list.data?.spreadsheets === true;
    return { t, locale, f, list, folders, actions, me, selection, setSelection, error, setError, fail, notebooks, spreadsheets, refresh: () => qc.invalidateQueries({ queryKey: docKeys.all }) };
}

function LibraryHeader({ p, onHouseStyle, onNew }: { p: ReturnType<typeof useLibraryPage>; onHouseStyle?: () => void; onNew: () => void }) {
    const { t } = p;
    const total = p.list.data?.total;
    return (
        <header className="flex items-end gap-3 flex-wrap">
            <div className="flex-1 min-w-0">
                <h2 className="text-[18px] font-semibold text-[var(--text-primary)]">
                    {t('documents.title', 'Documents')}
                    {typeof total === 'number' && total > 0 && <span className="ml-2 font-medium text-[var(--text-tertiary)]" data-testid="documents-count">{total}</span>}
                </h2>
                <p className="text-sm mt-1 text-[var(--text-secondary)]">
                    {p.notebooks
                        ? t('documents.notebook.library_subtitle', 'Pages, notebooks, designed documents and presentations. Write with your sources at hand; design once, adapt to every customer.')
                        : t('documents.library.subtitle', 'Pages, designed documents and presentations. Design once, adapt to every customer.')}
                </p>
            </div>
            <LibrarySearch value={p.f.query} onChange={p.f.setQuery} />
            {onHouseStyle && <button type="button" className={SECONDARY} data-testid="documents-house-style" onClick={onHouseStyle}><Stamp size={14} aria-hidden="true" />{t('documents.style.button', 'House style')}</button>}
            <button type="button" className={PRIMARY} onClick={onNew} data-testid="documents-new">
                <Plus size={14} aria-hidden="true" />{t('documents.new_button', 'New document')}
            </button>
        </header>
    );
}

/** Which of the running actions is busy with which row. */
function busyRow(actions: ReturnType<typeof useLibraryActions>): string | null {
    for (const m of [actions.duplicate, actions.archive, actions.unarchive, actions.deleteNotebook]) if (m.isPending) return String(m.variables || '');
    return null;
}

/** The list column: bulk actions, the rows, the pager. */
function LibraryMain({ p, onOpen, onCreate }: { p: ReturnType<typeof useLibraryPage>; onOpen: (row: LibraryRow) => void; onCreate: () => void }) {
    const { f, list, actions } = p;
    const rows: LibraryRow[] = list.data?.documents || [];
    const [sharingRow, setSharingRow] = useState<LibraryRow | null>(null);
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
                onShare={setSharingRow} onOpen={onOpen} onRetry={() => list.refetch()} onCreate={onCreate}
                onDuplicate={(row) => actions.duplicate.mutate(row.id, { onSuccess: (doc) => onOpen({ ...row, id: doc.id }), onError: p.fail })}
                onArchive={(row) => (isNotebookRow(row) ? actions.deleteNotebook.mutateAsync(row.id) : actions.archive.mutateAsync(row.id)).catch(p.fail)}
                onUnarchive={(row) => actions.unarchive.mutate(row.id, { onError: p.fail })}
            />
            {sharingRow && <DocumentSharingDialog key={`${sharingRow.docType}:${sharingRow.id}`} row={sharingRow} onClose={() => setSharingRow(null)} />}
            <Pager offset={f.offset} limit={PAGE_SIZE} total={list.data?.total ?? null} onOffset={f.setOffset} testId="documents-pager" />
        </main>
    );
}

function OpeningNotebook() {
    const { t } = useTranslation();
    return <div className="h-full flex items-center justify-center text-sm text-[var(--text-tertiary)]" role="status">{t('documents.notebook.loading', 'Opening the notebook…')}</div>;
}

export default function DocumentsPage({ mode = 'workspace', initialDocumentId = null, onDocumentChange, user }: DocumentsPageProps) {
    const p = useLibraryPage();
    const { t, f, actions } = p;
    const [selectedId, setSelectedId] = useState<string | null>(initialDocumentId);
    const [showHouseStyle, setShowHouseStyle] = useState(false);
    const [galleryOpen, setGalleryOpen] = useState(false);
    // A choice the server refused for want of an encryption key: made again once unlocked.
    const [locked, setLocked] = useState<NewChoice | null>(null);
    useEffect(() => { setSelectedId(initialDocumentId); }, [initialDocumentId]);
    const select = (id: string | null) => { setSelectedId(id); onDocumentChange?.(id); };
    const open = (row: LibraryRow) => select(isNotebookRow(row) ? notebookRef(row.id) : row.id);

    const create = async (choice: NewChoice) => {
        if (choice.type === 'notebook') {
            const nb = await actions.createNotebook.mutateAsync({ name: t('documents.notebook.untitled', 'Untitled notebook'), folderId: f.folderId || undefined });
            setGalleryOpen(false);
            select(notebookRef(nb.id));
            return;
        }
        if (choice.type === 'spreadsheet') {
            const sheet = await actions.createSheet.mutateAsync({ name: t('documents.sheet.untitled', 'Untitled spreadsheet'), folderId: f.folderId || undefined });
            setGalleryOpen(false);
            select(sheet.id);
            return;
        }
        const doc = await actions.create.mutateAsync({ ...newDocumentInput(choice, f.kind, t), locale: p.locale, folderId: f.folderId || undefined });
        setGalleryOpen(false);
        select(doc.id);
    };
    const createFailure = actions.create.error || actions.createNotebook.error || actions.createSheet.error;
    // A missing key has its own prompt; it is no error to sit on top of the dialog.
    const createError = isKeyUnavailable(createFailure) ? null : createFailure;
    const choose = (choice: NewChoice) => {
        create(choice).catch((e) => { if (isKeyUnavailable(e)) setLocked(choice); });
    };

    if (mode === 'studio' && showHouseStyle) return <HouseStylePanel onBack={() => setShowHouseStyle(false)} />;
    const notebookId = notebookIdOf(selectedId);
    if (notebookId) {
        return (
            <Suspense fallback={<OpeningNotebook />}>
                <NotebookDetail key={notebookId} notebookId={notebookId} user={user || p.me.data || null}
                    onBack={() => { select(null); p.refresh(); }} onListChanged={p.refresh} onOpenProject={openProjectInApp} />
            </Suspense>
        );
    }
    if (selectedId) return <DocumentEditor key={selectedId} documentId={selectedId} onBack={() => select(null)} currentUser={p.me.data || null} />;

    return (
        <div className="h-full overflow-auto text-[var(--text-primary)] bg-[var(--bg-primary)]" data-testid="documents-library">
            <div className="max-w-[1100px] mx-auto px-6 py-8 space-y-4">
                <LibraryHeader p={p} onHouseStyle={mode === 'studio' ? () => setShowHouseStyle(true) : undefined} onNew={() => { actions.create.reset(); actions.createNotebook.reset(); actions.createSheet.reset(); setGalleryOpen(true); }} />
                <LibraryViews kind={f.kind} archived={f.archived} onView={(kind, archived) => { f.setArchived(archived); if (kind) f.setKind(kind); }} />
                <LibraryFilterBar f={f} notebooks={p.notebooks} spreadsheets={p.spreadsheets} />
                {p.error && <div role="alert" className="flex gap-3 p-3 rounded-xl text-sm border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--error)_10%,transparent)]"><span className="flex-1">{p.error}</span><button type="button" className="underline" onClick={() => p.setError(null)}>{t('documents.dismiss', 'Dismiss')}</button></div>}
                <div className="grid md:grid-cols-[200px_1fr] gap-6">
                    <FolderSidebar folders={p.folders.data || []} folderId={f.folderId} onFolder={f.setFolderId} busy={actions.createFolder.isPending}
                        onCreate={(name) => actions.createFolder.mutateAsync({ name, parentId: f.folderId || null }).catch((e) => { p.fail(e); throw e; })}
                        onDelete={(folder) => actions.deleteFolder.mutateAsync(folder.id).catch((e) => { p.fail(e); throw e; })} />
                    <LibraryMain p={p} onOpen={open} onCreate={() => { actions.create.reset(); actions.createNotebook.reset(); actions.createSheet.reset(); setGalleryOpen(true); }} />
                </div>
                <StarterGallery open={galleryOpen} busy={actions.create.isPending || actions.createNotebook.isPending || actions.createSheet.isPending} notebooks={p.notebooks} spreadsheets={p.spreadsheets} onClose={() => setGalleryOpen(false)}
                    error={createError ? projectErrorText(t, createError) || createError.message : null}
                    onChoose={choose} />
                <EncryptionUnlock open={!!locked} onClose={() => setLocked(null)}
                    onUnlocked={() => { const again = locked; setLocked(null); if (again) choose(again); }} />
            </div>
        </div>
    );
}
