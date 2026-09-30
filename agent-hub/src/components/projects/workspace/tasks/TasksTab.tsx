// The Tasks tab of a project: what needs doing, who has it, and what it is
// about — as a list (to do, in progress, done) or as a board you drag cards
// on. Filters by person, priority, label and lateness; a tick finishes a
// task; a dialog holds the rest. "From a meeting" turns the action items of a
// meeting note into tasks.

import { CheckSquare, Kanban, List, Mic } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import {
    TASK_PRIORITIES, TASK_STATUSES, useDeleteTask, useProjectTasksQuery, useUpdateTask, type ProjectTask, type TaskStatus,
} from '../../../../api/queries/projectTasks';
import { useTranslation } from '../../../../hooks/useTranslation';
import scopedStorage from '../../../../utils/scopedStorage';
import EmptyState from '../../../shared/EmptyState';
import useConfirm from '../../../shared/useConfirm';
import SegmentedControl from '../../../shared/SegmentedControl';
import { toast } from '../../../shared/Toast';
import { useChatPeople } from '../chat/chatPeople';
import { projectErrorText } from '../projectErrorText';
import { StudioSectionHeader } from '../studioParts';
import { canEditProject, type WorkspaceTabProps } from '../types';
import { GhostButton, LoadingRow, Notice, PrimaryButton, SecondaryButton, SELECT_CLASS } from '../workspaceUi';
import { mayDeleteTask } from './DeleteTaskButton';
import MeetingTasksDialog from './MeetingTasksDialog';
import TaskBoard from './TaskBoard';
import { allLabels, applyFilters, hasFilters, NO_FILTERS, sortTasks, type TaskFilters, type TaskSort } from './taskFilters';
import TaskRow from './TaskRow';
import { priorityLabel, statusLabel, todayKey } from './taskText';
import { useTaskDialog } from './useTaskDialog';

type View = 'list' | 'board';
const VIEW_KEY = 'projectTasksView';

function storedView(): View {
    try { return scopedStorage.getItem(VIEW_KEY) === 'board' ? 'board' : 'list'; } catch { return 'list'; }
}

function FilterBar({ filters, onChange, sort, onSort, view, people, me, labels }: {
    filters: TaskFilters; onChange: (f: TaskFilters) => void; sort: TaskSort; onSort: (s: TaskSort) => void; view: View;
    people: ReturnType<typeof useChatPeople>; me: string | null; labels: string[];
}) {
    const { t } = useTranslation();
    const set = (patch: Partial<TaskFilters>) => onChange({ ...filters, ...patch });
    return (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('project_tasks.filters', 'Filter tasks')}>
            <select className={SELECT_CLASS} value={filters.who} onChange={e => set({ who: e.target.value })} aria-label={t('project_tasks.show', 'Show')}>
                <option value="all">{t('project_tasks.who_all', 'All tasks')}</option>
                {me && <option value="me">{t('project_tasks.who_me', 'Given to me')}</option>}
                <option value="unassigned">{t('project_tasks.who_unassigned', 'Not given to anyone')}</option>
                {people.people.filter(p => p.id !== me).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <select className={SELECT_CLASS} value={filters.priority} onChange={e => set({ priority: e.target.value as TaskFilters['priority'] })} aria-label={t('project_tasks.priority_label', 'Priority')}>
                <option value="all">{t('project_tasks.priority_any', 'Any priority')}</option>
                {TASK_PRIORITIES.map(p => <option key={p} value={p}>{priorityLabel(t, p)}</option>)}
            </select>
            {labels.length > 0 && (
                <select className={SELECT_CLASS} value={filters.label} onChange={e => set({ label: e.target.value })} aria-label={t('project_tasks.labels', 'Labels')}>
                    <option value="">{t('project_tasks.label_any', 'Any label')}</option>
                    {labels.map(l => <option key={l} value={l}>{l}</option>)}
                </select>
            )}
            <label className="inline-flex items-center gap-1.5 text-[12.5px] text-[var(--text-secondary)] cursor-pointer">
                <input type="checkbox" checked={filters.overdueOnly} onChange={e => set({ overdueOnly: e.target.checked })} className="accent-[var(--accent-primary)]" />
                {t('project_tasks.overdue_only', 'Overdue')}
            </label>
            {view === 'list' && (
                <select className={`${SELECT_CLASS} ml-auto`} value={sort} onChange={e => onSort(e.target.value as TaskSort)} aria-label={t('project_tasks.sort', 'Sort by')}>
                    <option value="due">{t('project_tasks.sort_due', 'Sort: due date')}</option>
                    <option value="priority">{t('project_tasks.sort_priority', 'Sort: priority')}</option>
                    <option value="newest">{t('project_tasks.sort_newest', 'Sort: newest')}</option>
                </select>
            )}
            {hasFilters(filters) && <GhostButton onClick={() => onChange(NO_FILTERS)}>{t('project_tasks.clear_filters', 'Clear filters')}</GhostButton>}
        </div>
    );
}

function TaskList({ tasks, sort, canEdit, people, onOpen, onStatus, onDelete, mayDelete }: {
    tasks: ProjectTask[]; sort: TaskSort; canEdit: boolean; people: ReturnType<typeof useChatPeople>;
    onOpen: (t: ProjectTask) => void; onStatus: (t: ProjectTask, s: TaskStatus) => void;
    onDelete: (t: ProjectTask) => void; mayDelete: (t: ProjectTask) => boolean;
}) {
    const { t } = useTranslation();
    return (
        <>
            {TASK_STATUSES.map((status) => {
                const list = sortTasks(tasks.filter(x => x.status === status), status === 'done' ? 'newest' : sort);
                if (!list.length) return null;
                return (
                    <section key={status} aria-label={statusLabel(t, status)}>
                        <h3 className="m-0 mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
                            {statusLabel(t, status)}<span className="font-normal">{list.length}</span>
                        </h3>
                        <ul className="list-none m-0 p-0 space-y-1.5">
                            {list.map(task => <TaskRow key={task.id} task={task} canEdit={canEdit} people={people} onOpen={() => onOpen(task)} onStatus={s => onStatus(task, s)} onDelete={mayDelete(task) ? onDelete : undefined} />)}
                        </ul>
                    </section>
                );
            })}
        </>
    );
}

/** The task a link or a notification points at (`sub`), opened once the list has it. */
function useOpenFromRoute(sub: string | null, tasks: ProjectTask[] | undefined, open: (t: ProjectTask) => void) {
    const [opened, setOpened] = useState<string | null>(null);
    useEffect(() => {
        if (!sub || !tasks || opened === sub) return;
        const task = tasks.find(x => x.id === sub);
        if (task) { setOpened(sub); open(task); }
    }, [sub, tasks, opened, open]);
}

export default function TasksTab(props: WorkspaceTabProps) {
    const { projectId, role, currentUser } = props;
    const { t } = useTranslation();
    const canEdit = canEditProject(role);
    const me = currentUser?.id || null;
    const query = useProjectTasksQuery(projectId);
    const update = useUpdateTask(projectId);
    const people = useChatPeople(projectId, currentUser);
    const all = useMemo(() => query.data?.tasks || [], [query.data]);
    const labels = useMemo(() => allLabels(all), [all]);
    const { openNew, openTask, dialog } = useTaskDialog(props, labels);
    const onError = (e: Error) => toast.error(projectErrorText(t, e));
    const remove = useDeleteTask(projectId);
    const { confirm, confirmDialog } = useConfirm();
    const mayDelete = (task: ProjectTask) => mayDeleteTask(task, me, role === 'owner', canEdit);
    const deleteTask = async (task: ProjectTask) => {
        const ok = await confirm({
            title: t('project_tasks.delete_title', 'Delete this task?'),
            description: t('project_tasks.delete_named', '"{name}" disappears for everyone in the project.', { name: task.title || t('project_tasks.untitled', 'Untitled task') }),
            confirmLabel: t('project_tasks.delete', 'Delete'),
            cancelLabel: t('project_content.cancel', 'Cancel'),
            destructive: true,
        });
        if (!ok) return;
        remove.mutate(task.id, {
            onSuccess: () => toast.success(t('project_tasks.deleted', 'Task deleted')),
            onError,
        });
    };
    const [view, setView] = useState<View>(storedView);
    const [filters, setFilters] = useState<TaskFilters>(NO_FILTERS);
    const [sort, setSort] = useState<TaskSort>('due');
    const [fromMeeting, setFromMeeting] = useState(false);
    useOpenFromRoute(props.sub, query.data?.tasks, openTask);

    const shown = useMemo(() => applyFilters(all, filters, me, todayKey()), [all, filters, me]);
    const setStatus = (task: ProjectTask, status: TaskStatus) => update.mutate({ id: task.id, patch: { status } }, { onError });
    const move = (task: ProjectTask, status: TaskStatus, beforeId: string | null) => update.mutate({ id: task.id, patch: { status, beforeId } }, { onError });
    const changeView = (next: View) => { setView(next); try { scopedStorage.setItem(VIEW_KEY, next); } catch { /* the choice just does not outlive the page */ } };
    const open = all.filter(x => x.status !== 'done').length;

    return (
        <div className="h-full flex flex-col min-h-0" data-testid="project-tasks-tab">
            <StudioSectionHeader icon={CheckSquare} title={t('project_tasks.title', 'Tasks')}
                statusChip={query.data ? t('project_tasks.open_count', '{count} open', { count: open }) : null}
                primary={canEdit ? <PrimaryButton onClick={() => openNew()}>{t('project_tasks.new', 'New task')}</PrimaryButton> : undefined} />
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                <div className={`${view === 'board' ? 'max-w-6xl' : 'max-w-3xl'} mx-auto px-6 py-5 space-y-5`}>
                    <div className="flex flex-wrap items-center gap-2 justify-between">
                        <SegmentedControl size="sm" value={view} onChange={changeView} ariaLabel={t('project_tasks.view', 'View')}
                            options={[
                                { value: 'list', label: t('project_tasks.view_list', 'List'), icon: <List className="w-3.5 h-3.5" aria-hidden="true" /> },
                                { value: 'board', label: t('project_tasks.view_board', 'Board'), icon: <Kanban className="w-3.5 h-3.5" aria-hidden="true" /> },
                            ]} />
                        {canEdit && (
                            <SecondaryButton onClick={() => setFromMeeting(true)} data-testid="tasks-from-meeting">
                                <Mic className="w-3.5 h-3.5" aria-hidden="true" />{t('project_tasks.from_meeting_button', 'From a meeting')}
                            </SecondaryButton>
                        )}
                    </div>
                    {all.length > 0 && <FilterBar filters={filters} onChange={setFilters} sort={sort} onSort={setSort} view={view} people={people} me={me} labels={labels} />}
                    {query.isPending && <LoadingRow label={t('project_tasks.loading', 'Loading tasks…')} />}
                    {query.isError && (
                        <Notice tone="error" role="alert" action={<GhostButton onClick={() => query.refetch()}>{t('project_chat.retry', 'Try again')}</GhostButton>}>
                            {t('project_tasks.load_failed', 'Could not load the tasks of this project.')}
                        </Notice>
                    )}
                    {query.data && all.length === 0 && (
                        <EmptyState icon={<CheckSquare className="w-10 h-10" />}
                            title={t('project_tasks.empty_title', 'No tasks yet')}
                            description={t('project_tasks.empty_desc', 'Write down what needs doing, give it to someone, and link the documents, notebooks and chats it is about. Or make tasks from the action items of a meeting.')}
                            action={canEdit ? { label: t('project_tasks.new', 'New task'), onClick: () => openNew() } : undefined} />
                    )}
                    {query.data && all.length > 0 && shown.length === 0 && (
                        <p className="text-sm text-[var(--text-tertiary)]">{t('project_tasks.no_matches', 'No tasks match this filter.')}</p>
                    )}
                    {shown.length > 0 && view === 'list' && <TaskList tasks={shown} sort={sort} canEdit={canEdit} people={people} onOpen={openTask} onStatus={setStatus} onDelete={deleteTask} mayDelete={mayDelete} />}
                    {shown.length > 0 && view === 'board' && <TaskBoard tasks={shown} canEdit={canEdit} people={people} onOpen={openTask} onMove={move} onDelete={deleteTask} mayDelete={mayDelete} />}
                </div>
            </div>
            {dialog}
            {confirmDialog}
            {fromMeeting && <MeetingTasksDialog projectId={projectId} currentUser={currentUser} onClose={() => setFromMeeting(false)} />}
        </div>
    );
}
