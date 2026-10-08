import { useNotebookDetail } from '../../../../pages/documents/notebook/notebookQueries';
// Notebooks tab of the project workspace: the notebooks filed in the project
// as a card grid, "New notebook" straight into it, and "Add existing" from
// the caller's own. A notebook opens in the notebook editor itself.
//
// A reader who may not use notebooks (plan, role, operator switch: the same
// answer the app gives everywhere else) still sees what is filed here, but
// is offered no way to make, add or open one — the editor would refuse it —
// and is told why once, above the grid.

import { BookOpen, BookPlus, Lock, Plus } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import React, { lazy, Suspense, useMemo, useState } from 'react';
import {
    useCreateProjectNotebook, useProjectSection, type ProjectNotebook,
} from '../../../../api/queries/projectContent';
import { projectKeys } from '../../../../api/queries/projects';
import useTranslation from '../../../../hooks/useTranslation';
import { projectErrorText } from '../projectErrorText';
import { Notice } from '../workspaceUi';
import EmptyState from '../../../shared/EmptyState';
import { ContentColumn, ContentToolbar, PrimaryButton, ReadOnlyNote, SecondaryButton, SectionError } from './contentUi';
import NewItemDialog, { type NewItemValues } from './NewItemDialog';
import { NotebookPicker } from './pickers';
import ProjectNotebookCard from './ProjectNotebookCard';
import { useMarkSeenWhenOpen, useProjectUnread } from '../useProjectUnread';
import { canEditContent, canRemoveItem, type ContentTabProps } from './types';
import { useMemberNames, useRemoveFromProject } from './useContentActions';

const NotebookDetail = lazy(() => import('../../../../pages/documents/notebook/detail/NotebookDetail'));

/** One notebook, full width inside the project, with its own Back to the grid. */
function NotebookPane({ projectId, notebookId, currentUser, onOpenSub }: {
    projectId: string; notebookId: string; currentUser: ContentTabProps['currentUser']; onOpenSub: ContentTabProps['onOpenSub'];
}) {
    const { t } = useTranslation();
    const qc = useQueryClient();
    const unread = useProjectUnread(projectId);
    const detail = useNotebookDetail(notebookId);
    useMarkSeenWhenOpen(unread, detail.isSuccess && detail.data?.notebook?.id ? { type: 'notebook', id: notebookId } : null);
    const refresh = () => { qc.invalidateQueries({ queryKey: projectKeys.resources(projectId) }); };
    return (
        <div className="h-full min-h-0" data-testid="project-notebook-pane">
            <Suspense fallback={<div className="p-6 text-sm text-[var(--text-tertiary)]" role="status">{t('project_content.notebook_loading', 'Opening the notebook…')}</div>}>
                <NotebookDetail
                    key={notebookId}
                    notebookId={notebookId}
                    user={currentUser}
                    onBack={() => { refresh(); onOpenSub(null); }}
                    onListChanged={refresh}
                    // The notebook is already open inside its project.
                    onOpenProject={() => { refresh(); onOpenSub(null); }}
                />
            </Suspense>
        </div>
    );
}

const GRID = 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3';

function NotebookSkeletons() {
    return (
        <div className={GRID} aria-hidden="true" data-testid="project-notebooks-loading">
            {[0, 1, 2].map(i => (
                <div key={i} className="h-[132px] rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-3.5 animate-pulse">
                    <div className="h-9 w-9 rounded-lg bg-[var(--bg-tertiary)] mb-3" />
                    <div className="h-2.5 w-3/4 rounded bg-[var(--bg-tertiary)] mb-2" />
                    <div className="h-2.5 w-1/2 rounded bg-[var(--bg-tertiary)]" />
                </div>
            ))}
        </div>
    );
}

interface GridProps {
    notebooks: ProjectNotebook[];
    ownerName: (userId: string | null | undefined) => string;
    isUnread: (id: string) => boolean;
    mayRemove: (nb: ProjectNotebook) => boolean;
    removingId: string | null;
    onOpen: (nb: ProjectNotebook) => void;
    onRemove: (nb: ProjectNotebook) => void;
    openable: boolean;
}

function NotebookGrid({ notebooks, ownerName, isUnread, mayRemove, removingId, onOpen, onRemove, openable }: GridProps) {
    return (
        <div className={GRID} data-testid="project-notebooks-grid">
            {notebooks.map(nb => (
                <ProjectNotebookCard
                    key={nb.id}
                    notebook={nb}
                    ownerName={ownerName(nb.userId)}
                    editorName={nb.lastEditedBy ? ownerName(nb.lastEditedBy) : ''}
                    unread={isUnread(nb.id)}
                    canRemove={mayRemove(nb)}
                    removing={removingId === nb.id}
                    onOpen={() => onOpen(nb)}
                    onRemove={() => onRemove(nb)}
                    openable={openable}
                />
            ))}
        </div>
    );
}

function NotebooksBody({ status, onRetry, onCreate, grid }: {
    status: 'loading' | 'error' | 'ok'; onRetry: () => void; onCreate: (() => void) | null; grid: GridProps;
}) {
    const { t } = useTranslation();
    if (status === 'loading') return <NotebookSkeletons />;
    if (status === 'error') return <SectionError message={t('project_content.notebooks_error', 'The notebooks of this project could not be loaded.')} onRetry={onRetry} />;
    if (grid.notebooks.length === 0) {
        return (
            <EmptyState
                icon={<BookOpen className="w-10 h-10" />}
                title={t('project_content.notebooks_empty_title', 'No notebooks yet')}
                description={t('project_content.notebooks_empty_desc', 'A notebook gathers sources and notes around one question, with an AI that answers from those sources. Everyone in the project can read it; editors can write in it.')}
                action={onCreate ? { label: t('project_content.notebooks_new', 'New notebook'), onClick: onCreate } : undefined}
            />
        );
    }
    return <NotebookGrid {...grid} />;
}

function useNotebookCreate(projectId: string, onCreated: (nb: ProjectNotebook) => void) {
    const { t } = useTranslation();
    const create = useCreateProjectNotebook(projectId);
    const submit = (values: NewItemValues) => {
        create.mutate({ name: values.name, ...(values.description ? { description: values.description } : {}) }, { onSuccess: onCreated });
    };
    return { submit, busy: create.isPending, error: create.error ? projectErrorText(t, create.error) : null, reset: create.reset };
}

function NotebooksUnavailable() {
    const { t } = useTranslation();
    return (
        <Notice icon={Lock} testId="project-notebooks-unavailable">
            {t('project_content.notebooks_unavailable', 'Notebooks are not available to you: your plan or your role does not include them. You can see which notebooks are in this project, but you cannot open or add them. Ask an administrator if you need them.')}
        </Notice>
    );
}

function NotebooksList({ projectId, role, currentUser, onOpenSub, intent, notebooksEnabled = true }: ContentTabProps) {
    const { t } = useTranslation();
    const canEdit = canEditContent(role) && notebooksEnabled;
    const me = currentUser?.id || null;
    const [createOpen, setCreateOpen] = useState(() => canEdit && intent === 'create');
    const [search, setSearch] = useState('');
    const [pickerOpen, setPickerOpen] = useState(() => canEdit && intent === 'add');
    const section = useProjectSection<ProjectNotebook>(projectId, 'notebooks');
    const ownerName = useMemberNames(projectId, me);
    const unread = useProjectUnread(projectId);
    const removal = useRemoveFromProject(projectId, 'notebook');
    const open = (nb: ProjectNotebook) => onOpenSub(nb.id);
    const create = useNotebookCreate(projectId, (nb) => { setCreateOpen(false); open(nb); });
    const inProject = useMemo(() => new Set(section.items.map(n => n.id)), [section.items]);
    const openCreate = () => { create.reset(); setCreateOpen(true); };

    const onRemove = (nb: ProjectNotebook) => removal.remove(nb.id, {
        title: t('project_content.notebook_remove_title', 'Remove this notebook from the project?'),
        description: t('project_content.notebook_remove_desc', '"{name}" stays with its owner. Members of this project will no longer see it.', { name: nb.name }),
        confirmLabel: t('project_content.remove_from_project', 'Remove from project'),
    });

    const actions = canEdit ? (
        <>
            <SecondaryButton icon={Plus} onClick={() => setPickerOpen(true)} testId="notebooks-add-existing">{t('project_content.add_existing', 'Add existing')}</SecondaryButton>
            <PrimaryButton icon={BookPlus} onClick={openCreate} testId="notebooks-new">{t('project_content.notebooks_new', 'New notebook')}</PrimaryButton>
        </>
    ) : null;

    return (
        <ContentColumn testId="project-notebooks-tab">
            <ContentToolbar
                title={t('project_content.notebooks_title', 'Notebooks')}
                search={search} onSearch={setSearch} searchLabel={t('project_content.notebooks_search', 'Search notebooks')}
                count={section.status === 'ok' ? section.items.length : null}
                actions={actions}
            />
            {!notebooksEnabled && <NotebooksUnavailable />}
            {notebooksEnabled && !canEdit && <ReadOnlyNote>{t('project_content.notebooks_viewer_note', 'You can read the notebooks in this project. Ask the owner for editor access to add or change them.')}</ReadOnlyNote>}
            {search.trim() && section.status === 'ok' && !section.items.some(n => `${n.name} ${n.description || ''}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) ? <p className="text-sm text-[var(--text-secondary)]">{t('project_content.no_matches', 'Nothing matches your search.')}</p> : <NotebooksBody
                status={section.status} onRetry={section.refetch} onCreate={canEdit ? openCreate : null}
                grid={{
                    notebooks: section.items.filter(n => `${n.name} ${n.description || ''}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())), ownerName, removingId: removal.pendingId, onOpen: open, onRemove,
                    isUnread: (id) => unread.isUnread('notebook', id),
                    mayRemove: (nb) => canRemoveItem(role, nb.userId, me),
                    openable: notebooksEnabled,
                }}
            />
            }
            {createOpen && (
                <NewItemDialog
                    open onClose={() => setCreateOpen(false)}
                    title={t('project_content.notebooks_new_title', 'New notebook')}
                    nameLabel={t('project_content.name', 'Name')}
                    namePlaceholder={t('project_content.notebooks_name_placeholder', 'For example: Market research')}
                    submitLabel={t('project_content.create_and_open', 'Create and open')}
                    withDescription
                    busy={create.busy} error={create.error} onSubmit={create.submit}
                />
            )}
            {pickerOpen && <NotebookPicker projectId={projectId} open onClose={() => setPickerOpen(false)} inProject={inProject} />}
            {removal.confirmDialog}
        </ContentColumn>
    );
}

export default function NotebooksTab(props: ContentTabProps) {
    // A notebook is opened inside the project, as a document is: `sub` is its id.
    if (props.sub && props.notebooksEnabled !== false) {
        return <NotebookPane projectId={props.projectId} notebookId={props.sub} currentUser={props.currentUser} onOpenSub={props.onOpenSub} />;
    }
    return <NotebooksList {...props} />;
}
