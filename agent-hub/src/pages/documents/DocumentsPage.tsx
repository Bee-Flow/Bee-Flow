// Studio → Documents: the library. Pages, notebooks, designed documents and
// presentations; templates and reusable sections in their own views; folders,
// categories, the archive with its way back; a gallery to start from; the
// house style. Opening one shows the editor for its kind (DocumentEditor), or,
// for a notebook, the notebook workspace (pages/documents/notebook/detail).
//
// The page follows Studio's overview language (the Agents and Automations
// overviews): an 18px title with its count and a one-line intro, the search
// box and the actions on the same row, pills for the views and the types.

import { Plus, Stamp, Upload } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Suspense, useEffect, useState } from 'react';
import PagerJs from '../../components/shared/Pager';
import useTranslation, { readingLocale } from '../../hooks/useTranslation';
import { lazy } from '../../utils/lazyWithReload';
import { projectRoutePath } from '../../utils/projectRoutes';
import { projectErrorText } from '../../components/projects/workspace/projectErrorText';
import DocumentEditor from './DocumentEditor';
import HouseStylePanel from './HouseStylePanel';
import { docKeys, useFolders, useLibrary, useSessionUser, type LibraryRow } from './documentQueries';
import FolderSidebar from './library/FolderSidebar';
import useTemplateFile from './library/useTemplateFile';
import { TEMPLATE_FILE_ACCEPT } from '@/api/templateFileApi';
import { BulkBar, LibraryFilterBar, LibrarySearch, LibraryViews } from './library/LibraryControls';
import LibraryList from './library/LibraryList';
import DocumentSharingDialog from './library/DocumentSharingDialog';
import EncryptionUnlock, { isKeyUnavailable } from './library/EncryptionUnlock';
import StarterGallery, { type NewChoice } from './library/StarterGallery';
import { addCategories } from './library/categoryFiling';
import { useLibraryTypesText } from './library/labels';
import { useTemplateCopy } from './library/useTemplateCopy';
import { useMyTemplatesQuery } from '@/api/queries/projectContent';
import { PAGE_SIZE, isNotebookRow, useLibraryActions, useLibraryFilters, type LibraryKind, type NewDocumentInput } from './library/useLibrary';
import { notebookIdOf, notebookRef } from './notebookRef';
import { messageOf } from '../../utils/caughtError';
import { isOrgAdminRole, isPlatformAdmin } from '@/utils/adminAccess';
import type { FilingResult } from './library/useLibrary';

const Pager = PagerJs;
// The notebook workspace carries the editor, the sources and the chat: loaded
// only when a notebook is opened.
const NotebookDetail = lazy(() => import('./notebook/detail/NotebookDetail'));

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

/** Whether the signed-in user administers the organisation (the server's org_admin permission). */
function isOrgAdminUser(user: unknown): boolean {
    if (!user || typeof user !== 'object') return false;
    const u = user as { isAdmin?: boolean | null; role?: string | null; orgRole?: string | null; permissions?: unknown };
    const perms = Array.isArray(u.permissions) ? u.permissions : [];
    return isPlatformAdmin(u) || isOrgAdminRole(u.orgRole) || perms.includes('org_admin') || perms.includes('all');
}

/** What a bulk filing that the server partly refused says; null when every row was filed. */
function filingNotice(result: FilingResult, what: 'move' | 'categorise', t: Translate): string | null {
    if (!result.failed.length) return null;
    const counts = { done: result.done.length, total: result.done.length + result.failed.length, failed: result.failed.length };
    return what === 'move'
        ? t('doc_library.bulk_moved_partial', 'Moved {done} of {total}; {failed} could not be moved.', counts)
        : t('doc_library.bulk_categorised_partial', 'Categorised {done} of {total}; {failed} could not be categorised.', counts);
}

/** What a choice in the gallery creates, in the library view it was made from (an own template is copied instead, useTemplateCopy). */
function newDocumentInput(choice: Exclude<NewChoice, { type: 'notebook' } | { type: 'spreadsheet' } | { type: 'template' }>, view: LibraryKind, t: Translate): Omit<NewDocumentInput, 'locale' | 'folderId'> {
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

function useLibraryPage(user: unknown) {
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
    const fail = (e: unknown) => setError(projectErrorText(t, e) || messageOf(e, t('documents.library.action_failed', 'That did not work. Please try again.')));
    const [prevFilters, setPrevFilters] = useState(f.filters);
    if (prevFilters !== f.filters) {
        setPrevFilters(f.filters);
        setSelection([]);
    }
    // A page that emptied (its last row archived, moved or deleted) steps back
    // to the last page that still has rows, rather than saying the library is empty.
    const settled = list.data && !list.isPlaceholderData ? list.data : null;
    if (settled && !settled.documents.length && f.offset > 0) {
        const last = Math.max(0, Math.floor((settled.total - 1) / PAGE_SIZE) * PAGE_SIZE);
        if (last < f.offset) f.setOffset(last);
    }
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
    return { t, locale, orgAdmin: isOrgAdminUser(user), f, list, folders, actions, me, selection, setSelection, error, setError, fail, notebooks, spreadsheets, refresh: () => qc.invalidateQueries({ queryKey: docKeys.all }) };
}

function LibraryHeader({ p, onHouseStyle, onNew, onImport, importing }: { p: ReturnType<typeof useLibraryPage>; onHouseStyle?: () => void; onNew: () => void; onImport: () => void; importing: boolean }) {
    const { t } = p;
    const typesText = useLibraryTypesText();
    const total = p.list.data?.total;
    return (
        <header className="flex items-end gap-3 flex-wrap">
            <div className="flex-1 min-w-0">
                <h2 className="text-[18px] font-semibold text-[var(--text-primary)]">
                    {t('documents.title', 'Documents')}
                    {typeof total === 'number' && total > 0 && <span className="ml-2 font-medium text-[var(--text-tertiary)]" data-testid="documents-count">{total}</span>}
                </h2>
                <p className="text-sm mt-1 text-[var(--text-secondary)]">
                    {typesText({ notebooks: p.notebooks, spreadsheets: p.spreadsheets })}
                </p>
            </div>
            <LibrarySearch value={p.f.query} onChange={p.f.setQuery} />
            {onHouseStyle && <button type="button" className={SECONDARY} data-testid="documents-house-style" onClick={onHouseStyle}><Stamp size={14} aria-hidden="true" />{t('documents.style.button', 'House style')}</button>}
            <button type="button" className={SECONDARY} onClick={onImport} disabled={importing} data-testid="documents-import-template"
                title={t('doc_template_file.import_hint', 'Import a .bftemplate file as a new template')}>
                <Upload size={14} aria-hidden="true" />{t('doc_template_file.import', 'Import template')}
            </button>
            <button type="button" className={PRIMARY} onClick={onNew} data-testid="documents-new">
                <Plus size={14} aria-hidden="true" />{t('documents.new_button', 'New document')}
            </button>
        </header>
    );
}

/** Which of the running actions is busy with which row. */
function busyRow(actions: ReturnType<typeof useLibraryActions>): string | null {
    for (const m of [actions.duplicate, actions.archive, actions.unarchive, actions.archiveNotebook, actions.unarchiveNotebook, actions.deleteNotebook]) if (m.isPending) return String(m.variables || '');
    return null;
}

/** The list column: bulk actions, the rows, the pager. */
function LibraryMain({ p, onOpen, onCreate, onExport }: { p: ReturnType<typeof useLibraryPage>; onOpen: (row: LibraryRow) => void; onCreate: () => void; onExport: (row: LibraryRow) => void }) {
    const { f, list, actions } = p;
    const rows: LibraryRow[] = list.data?.documents || [];
    const [sharingRow, setSharingRow] = useState<LibraryRow | null>(null);
    const selectedRows = rows.filter((r) => p.selection.includes(r.id));
    const filed = (what: 'move' | 'categorise') => (result: FilingResult) => { p.setSelection(result.failed); p.setError(filingNotice(result, what, p.t)); };
    const file = (patch: { folderId?: string | null; categories?: string[] }, what: 'move' | 'categorise') => actions.bulk.mutate({ rows: selectedRows, patch }, {
        onSuccess: filed(what),
        onError: p.fail,
    });
    // Each row keeps its own categories and gets the new ones too.
    const addTo = (added: string[]) => { addCategories(selectedRows, added, (input) => actions.bulk.mutateAsync(input)).then(filed('categorise'), p.fail); };
    const filtered = !!(f.query || f.category || f.visibility || f.format || f.folderId !== undefined);
    const status = list.isError && !list.data ? 'error' : list.isPending ? 'loading' : 'ok';
    return (
        <main className="space-y-3 min-w-0">
            <BulkBar count={selectedRows.length} folders={p.folders.data || []} busy={actions.bulk.isPending} onClear={() => p.setSelection([])}
                onMove={(folderId) => file({ folderId }, 'move')} onAddCategories={addTo} onClearCategories={() => file({ categories: [] }, 'categorise')} />
            <LibraryList
                rows={rows} people={list.data?.people || {}} currentUserId={p.me.data?.id || null} spreadsheets={p.spreadsheets} orgAdmin={p.orgAdmin}
                status={status} refreshing={list.isFetching && !list.isPending}
                archivedView={f.archived} filtered={filtered} selection={p.selection} onSelect={p.setSelection} busyId={busyRow(actions)}
                onShare={setSharingRow} onOpen={onOpen} onRetry={() => list.refetch()} onCreate={onCreate} onExport={onExport}
                onDuplicate={(row) => actions.duplicate.mutate(row.id, { onSuccess: (doc) => onOpen({ ...row, id: doc.id }), onError: p.fail })}
                onArchive={(row) => (isNotebookRow(row) ? actions.archiveNotebook : actions.archive).mutateAsync(row.id).catch(p.fail)}
                onUnarchive={(row) => (isNotebookRow(row) ? actions.unarchiveNotebook : actions.unarchive).mutate(row.id, { onError: p.fail })}
                onDeleteForGood={(row) => actions.deleteNotebook.mutateAsync(row.id).catch(p.fail)}
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
    const p = useLibraryPage(user);
    const { t, f, actions } = p;
    const [selectedId, setSelectedId] = useState<string | null>(initialDocumentId);
    const [showHouseStyle, setShowHouseStyle] = useState(false);
    const [galleryOpen, setGalleryOpen] = useState(false);
    // A choice the server refused for want of an encryption key: made again once unlocked.
    const [locked, setLocked] = useState<NewChoice | null>(null);
    const fromTemplate = useTemplateCopy();
    // The reader's own templates, offered in the documents view once the gallery is open.
    const ownTemplates = useMyTemplatesQuery(galleryOpen && f.kind === 'document');
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
        if (choice.type === 'template') {
            const copy = await fromTemplate.mutateAsync({ template: choice.template, folderId: f.folderId || undefined });
            setGalleryOpen(false);
            select(copy.id);
            return;
        }
        const doc = await actions.create.mutateAsync({ ...newDocumentInput(choice, f.kind, t), locale: p.locale, folderId: f.folderId || undefined });
        setGalleryOpen(false);
        select(doc.id);
    };
    const createFailure = actions.create.error || actions.createNotebook.error || actions.createSheet.error || fromTemplate.error;
    // A missing key has its own prompt; it is no error to sit on top of the dialog.
    const createError = isKeyUnavailable(createFailure) ? null : createFailure;
    const choose = (choice: NewChoice) => {
        create(choice).catch((e) => { if (isKeyUnavailable(e)) setLocked(choice); });
    };

    const { inputRef: importInputRef, importing, pick: pickTemplateFile, exportRow, importFile } = useTemplateFile({ folderId: f.folderId || undefined, onImported: (id) => { p.refresh(); select(id); }, onMessage: p.setError });
    const openGallery = () => { actions.create.reset(); actions.createNotebook.reset(); actions.createSheet.reset(); fromTemplate.reset(); setGalleryOpen(true); };

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
                <LibraryHeader p={p} onHouseStyle={mode === 'studio' ? () => setShowHouseStyle(true) : undefined} onNew={openGallery}
                    onImport={pickTemplateFile} importing={importing} />
                <input ref={importInputRef} type="file" accept={TEMPLATE_FILE_ACCEPT} className="hidden" data-testid="documents-import-input"
                    onChange={(e) => { void importFile(e.target.files?.[0]); }} />
                <LibraryViews kind={f.kind} archived={f.archived} onView={(kind, archived) => { f.setArchived(archived); if (kind) f.setKind(kind); }} />
                <LibraryFilterBar f={f} notebooks={p.notebooks} spreadsheets={p.spreadsheets} />
                {p.error && <div role="alert" className="flex gap-3 p-3 rounded-xl text-sm border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--error)_10%,transparent)]"><span className="flex-1">{p.error}</span><button type="button" className="underline" onClick={() => p.setError(null)}>{t('documents.dismiss', 'Dismiss')}</button></div>}
                <div className="grid md:grid-cols-[200px_1fr] gap-6">
                    <FolderSidebar folders={p.folders.data || []} folderId={f.folderId} onFolder={f.setFolderId} busy={actions.createFolder.isPending}
                        onCreate={(name) => actions.createFolder.mutateAsync({ name, parentId: f.folderId || null }).catch((e) => { p.fail(e); throw e; })}
                        onDelete={(folder) => actions.deleteFolder.mutateAsync(folder.id).catch((e) => { p.fail(e); throw e; })} />
                    <LibraryMain p={p} onOpen={open} onCreate={openGallery} onExport={(row) => { void exportRow(row); }} />
                </div>
                <StarterGallery open={galleryOpen} busy={actions.create.isPending || actions.createNotebook.isPending || actions.createSheet.isPending || fromTemplate.isPending}
                    notebooks={p.notebooks} spreadsheets={p.spreadsheets} view={f.kind} templates={f.kind === 'document' ? ownTemplates.data?.templates : undefined} onClose={() => setGalleryOpen(false)}
                    error={createError ? projectErrorText(t, createError) || createError.message : null}
                    onChoose={choose} />
                <EncryptionUnlock open={!!locked} onClose={() => setLocked(null)}
                    onUnlocked={() => { const again = locked; setLocked(null); if (again) choose(again); }} />
            </div>
        </div>
    );
}
