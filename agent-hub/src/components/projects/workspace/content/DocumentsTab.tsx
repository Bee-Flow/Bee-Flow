// Documents tab of the project workspace: the documents filed in the project
// (a dot on the ones somebody else changed since the reader looked), "New
// document" straight into it (the same "Start a document" gallery as the
// Studio: every document type, a notebook, a spreadsheet, the starters and the
// reader's own templates), "Add existing" from the caller's own, and the
// document itself opened in place (sub = document id).

import { useQueryClient } from '@tanstack/react-query';
import { FilePlus2, FileText, Plus } from 'lucide-react';
import React, { Suspense, useMemo, useState } from 'react';
import {
    useCreateProjectDocument, useCreateProjectNotebook, useMyTemplatesQuery, useProjectSection, type NewDocumentVars, type ProjectDocument,
} from '../../../../api/queries/projectContent';
import { projectKeys } from '../../../../api/queries/projects';
import useTranslation, { readingLocale } from '../../../../hooks/useTranslation';
import StarterGallery, { type NewChoice } from '../../../../pages/documents/library/StarterGallery';
import { projectErrorText } from '../projectErrorText';
import { lazy } from '../../../../utils/lazyWithReload';
import EmptyState from '../../../shared/EmptyState';
import { ContentColumn, ContentToolbar, PaneLoading, PrimaryButton, ReadOnlyNote, SecondaryButton, SectionError } from './contentUi';
import DocumentsTable, { type DocumentsTableProps } from './DocumentsTable';
import { DocumentPicker } from './pickers';
import { canEditContent, canRemoveItem, type ContentTabProps } from './types';
import { useMemberNames, useRemoveFromProject } from './useContentActions';
import { useMarkSeenWhenOpen, useProjectUnread } from '../useProjectUnread';

const DocumentEditor = lazy(() => import('../../../../pages/documents/DocumentEditor'));

/** One document, full width, with its own Back; marked seen once it has been open a moment. */
function DocumentPane({ projectId, documentId, onOpenSub, currentUser }: { projectId: string; documentId: string; onOpenSub: ContentTabProps['onOpenSub']; currentUser: ContentTabProps['currentUser'] }) {
    const { t } = useTranslation();
    const qc = useQueryClient();
    const unread = useProjectUnread(projectId);
    useMarkSeenWhenOpen(unread, { type: 'document', id: documentId });
    const refresh = () => { qc.invalidateQueries({ queryKey: projectKeys.resources(projectId) }); };
    return (
        <div className="h-full min-h-0" data-testid="project-document-pane">
            <Suspense fallback={<PaneLoading label={t('project_content.document_loading', 'Opening the document…')} />}>
                <DocumentEditor
                    key={documentId}
                    documentId={documentId}
                    variant="page"
                    onBack={() => { refresh(); onOpenSub(null); }}
                    onRenamed={refresh}
                    currentUser={currentUser ? { id: currentUser.id, name: currentUser.name } : null}
                />
            </Suspense>
        </div>
    );
}

type Translate = ReturnType<typeof useTranslation>['t'];

/** What a choice in the gallery files into the project; a notebook is made elsewhere. */
function documentVars(choice: Exclude<NewChoice, { type: 'notebook' }>, t: Translate, locale: string): NewDocumentVars {
    switch (choice.type) {
        case 'page': return { name: t('documents.untitled_page', 'Untitled page'), docType: 'page' };
        case 'spreadsheet': return { name: t('documents.sheet.untitled', 'Untitled spreadsheet'), docType: 'spreadsheet' };
        case 'template': return { name: choice.template.name, templateId: choice.template.id };
        case 'deck':
            return choice.starter
                ? { name: choice.starter.name, starterId: choice.starter.id, locale }
                : { name: t('documents.untitled_deck', 'Untitled presentation'), docType: 'presentation' };
        default:
            return choice.starter
                ? { name: choice.starter.name, starterId: choice.starter.id, locale }
                : { name: t('documents.untitled', 'Untitled document'), docType: 'document' };
    }
}

function useDocumentCreate(projectId: string, onCreated: (doc: ProjectDocument) => void, onOpenTab: ContentTabProps['onOpenTab']) {
    const { t, locale: preferred, strings } = useTranslation();
    const locale = readingLocale(preferred, strings, ['documents.new.title']) || 'en';
    const create = useCreateProjectDocument(projectId);
    const createNotebook = useCreateProjectNotebook(projectId);
    const failure = create.error || createNotebook.error;
    const choose = (choice: NewChoice) => {
        if (choice.type === 'notebook') {
            createNotebook.mutate({ name: t('documents.notebook.untitled', 'Untitled notebook') }, { onSuccess: (nb) => onOpenTab?.('notebooks', nb.id) });
            return;
        }
        create.mutate(documentVars(choice, t, locale), { onSuccess: onCreated });
    };
    return {
        choose, busy: create.isPending || createNotebook.isPending,
        error: failure ? projectErrorText(t, failure) : null,
        reset: () => { create.reset(); createNotebook.reset(); },
    };
}

type TableHandlers = Pick<DocumentsTableProps, 'ownerName' | 'mayRemove' | 'removingId' | 'onOpen' | 'onRemove' | 'isUnread'>;

/** Loading, could-not-load, nothing-yet, or the table: four different things. */
function DocumentsBody({ status, documents, total, onRetry, onCreate, table }: {
    status: 'loading' | 'error' | 'ok'; documents: ProjectDocument[]; total: number; onRetry: () => void;
    onCreate: (() => void) | null; table: TableHandlers;
}) {
    const { t } = useTranslation();
    if (status === 'error') return <SectionError message={t('project_content.documents_error', 'The documents of this project could not be loaded.')} onRetry={onRetry} />;
    if (status === 'ok' && total === 0) {
        return (
            <EmptyState
                icon={<FileText className="w-10 h-10" />}
                title={t('project_content.documents_empty_title', 'No documents yet')}
                description={t('project_content.documents_empty_desc', 'Write proposals, reports and presentations together. Everyone in the project can read them; editors can write in them.')}
                action={onCreate ? { label: t('project_content.documents_new', 'New document'), onClick: onCreate } : undefined}
            />
        );
    }
    return (
        <DocumentsTable
            documents={documents}
            loading={status === 'loading'}
            empty={<p className="text-sm text-[var(--text-tertiary)]">{t('project_content.no_matches', 'Nothing matches your search.')}</p>}
            {...table}
        />
    );
}

function DocumentsList({ projectId, role, currentUser, onOpenSub, onOpenTab, intent, notebooksEnabled }: ContentTabProps) {
    const { t } = useTranslation();
    const canEdit = canEditContent(role);
    const me = currentUser?.id || null;
    const [search, setSearch] = useState('');
    const [createOpen, setCreateOpen] = useState(() => canEdit && intent === 'create');
    const [pickerOpen, setPickerOpen] = useState(() => canEdit && intent === 'add');
    const section = useProjectSection<ProjectDocument>(projectId, 'documents');
    const unread = useProjectUnread(projectId);
    const ownerName = useMemberNames(projectId, me);
    const removal = useRemoveFromProject(projectId, 'document');
    const create = useDocumentCreate(projectId, (doc) => { setCreateOpen(false); onOpenSub(doc.id); }, onOpenTab);
    // Own templates, and whether the reader may make a spreadsheet, are asked only once the gallery is open.
    const mine = useMyTemplatesQuery(createOpen);
    const inProject = useMemo(() => new Set(section.items.map(d => d.id)), [section.items]);
    const visible = useMemo(() => {
        const q = search.trim().toLowerCase();
        return q ? section.items.filter(d => (d.name || '').toLowerCase().includes(q)) : section.items;
    }, [section.items, search]);
    const openCreate = () => { create.reset(); setCreateOpen(true); };

    const onRemove = (doc: ProjectDocument) => removal.remove(doc.id, {
        title: t('project_content.document_remove_title', 'Remove this document from the project?'),
        description: t('project_content.document_remove_desc', '"{name}" stays with its owner. Members of this project will no longer see it.', { name: doc.name }),
        confirmLabel: t('project_content.remove_from_project', 'Remove from project'),
    });

    const actions = canEdit ? (
        <>
            <SecondaryButton icon={Plus} onClick={() => setPickerOpen(true)} testId="documents-add-existing">{t('project_content.add_existing', 'Add existing')}</SecondaryButton>
            <PrimaryButton icon={FilePlus2} onClick={openCreate} testId="documents-new">{t('project_content.documents_new', 'New document')}</PrimaryButton>
        </>
    ) : null;

    const emptyProject = section.status === 'ok' && section.items.length === 0;
    return (
        <ContentColumn testId="project-documents-tab">
            <ContentToolbar
                title={t('project_content.documents_title', 'Documents')}
                count={section.status === 'ok' ? section.items.length : null}
                search={search} onSearch={emptyProject ? undefined : setSearch}
                searchLabel={t('project_content.documents_search', 'Search documents')}
                actions={actions}
            />
            {!canEdit && <ReadOnlyNote>{t('project_content.documents_viewer_note', 'You can read the documents in this project. Ask the owner for editor access to add or change them.')}</ReadOnlyNote>}
            <DocumentsBody
                status={section.status} documents={visible} total={section.items.length} onRetry={section.refetch}
                onCreate={canEdit ? openCreate : null}
                table={{
                    ownerName,
                    mayRemove: (doc) => canRemoveItem(role, doc.userId, me),
                    removingId: removal.pendingId,
                    onOpen: (doc) => onOpenSub(doc.id),
                    onRemove,
                    isUnread: (doc) => unread.isUnread('document', doc.id),
                }}
            />
            <StarterGallery
                open={createOpen} busy={create.busy} error={create.error}
                notebooks={notebooksEnabled !== false} spreadsheets={mine.data?.spreadsheets === true} templates={mine.data?.templates}
                onChoose={create.choose} onClose={() => setCreateOpen(false)}
            />
            {pickerOpen && <DocumentPicker projectId={projectId} open onClose={() => setPickerOpen(false)} inProject={inProject} currentUserId={me} />}
            {removal.confirmDialog}
        </ContentColumn>
    );
}

export default function DocumentsTab(props: ContentTabProps) {
    if (props.sub) return <DocumentPane projectId={props.projectId} documentId={props.sub} onOpenSub={props.onOpenSub} currentUser={props.currentUser} />;
    return <DocumentsList {...props} />;
}
