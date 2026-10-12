// The Tasks tab of a project: what needs doing, who has it, and what it is
// about — as a list (to do, in progress, done), a board you drag cards on, a
// plan (backlog, sprints, timeline, poker) or a tree of epics and stories.
// One header, one toolbar row (view, search, filter, sort, view-only tools),
// then the view. "From a meeting" turns the action items of a meeting note
// into tasks.

import { BookOpen, CheckSquare, ChevronDown, Layers3, Mic, Settings2, User } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useBoardActions, useProjectBoard } from '../../../../api/queries/projectBoard';
import {
    TASK_PRIORITIES, useDeleteTask, useProjectTasksQuery, useUpdateTask, type ProjectTask, type TaskStatus,
} from '../../../../api/queries/projectTasks';
import { useTranslation } from '../../../../hooks/useTranslation';
import scopedStorage from '../../../../utils/scopedStorage';
import EmptyState from '../../../shared/EmptyState';
import { toast } from '../../../shared/Toast';
import { useChatPeople } from '../chat/chatPeople';
import { projectErrorText } from '../projectErrorText';
import { StudioSectionHeader } from '../studioParts';
import { canEditProject, type WorkspaceTabProps } from '../types';
import { GhostButton, Notice, PrimaryButton } from '../workspaceUi';
import BoardSettings, { type BoardFocus } from './BoardSettings';
import { mayDeleteTask } from './DeleteTaskButton';
import HierarchyView from './HierarchyView';
import MeetingTasksDialog from './MeetingTasksDialog';
import TaskBoard from './TaskBoard';
import { allLabels, applyFilters, NO_FILTERS, type TaskFilters, type TaskSort } from './taskFilters';
import TaskList, { TasksSkeleton } from './TaskListView';
import TaskPlanning from './TaskPlanning';
import { childWorkItemType, workItemType, type WorkItemType } from './taskPlanning';
import { AnchoredMenu, ICON_BUTTON_CLASS, MENU_PANEL_CLASS, MenuItem, MenuSeparator } from './tasksMenu';
import TasksToolbar, { type TasksView } from './TasksToolbar';
import { todayKey } from './taskText';
import { useTaskDialog, type NewTaskPreset } from './useTaskDialog';
import './projectTasks.css';

type View = TasksView;
const VIEW_KEY = 'projectTasksView';

function storedView(): View {
    try { const saved = scopedStorage.getItem(VIEW_KEY); return saved === 'list' || saved === 'planning' || saved === 'hierarchy' ? saved : 'board'; } catch { return 'board'; }
}

function storedFilters(key: string): TaskFilters {
    try {
        const saved = JSON.parse(scopedStorage.getItem(key) || 'null');
        if (!saved || typeof saved !== 'object') return NO_FILTERS;
        return { who: typeof saved.who === 'string' ? saved.who : 'all',
            priority: ['all', ...TASK_PRIORITIES].includes(saved.priority) ? saved.priority : 'all',
            label: typeof saved.label === 'string' ? saved.label : '', overdueOnly: saved.overdueOnly === true,
            search: typeof saved.search === 'string' ? saved.search : '' };
    } catch { return NO_FILTERS; }
}

/** The primary "New task" button: a small menu of the work item types, and "From a meeting". */
function NewItemMenu({ onPick, onFromMeeting }: { onPick: (preset: NewTaskPreset) => void; onFromMeeting: () => void }) {
    const { t } = useTranslation();
    const anchorRef = useRef<HTMLSpanElement>(null);
    const [open, setOpen] = useState(false);
    const icon = 'w-3.5 h-3.5';
    const items: [WorkItemType | undefined, string, React.ReactNode][] = [
        [undefined, t('project_tasks.new', 'New task'), <CheckSquare key="t" className={icon} />],
        ['user-story', t('project_tasks.new_user_story', 'New user story'), <User key="u" className={icon} />],
        ['story', t('project_tasks.new_story', 'New story'), <BookOpen key="s" className={icon} />],
        ['epic', t('project_tasks.new_epic', 'New epic'), <Layers3 key="e" className={icon} />],
    ];
    return (
        <span ref={anchorRef} className="inline-flex">
            <PrimaryButton onClick={() => setOpen(v => !v)} aria-expanded={open} aria-haspopup="menu" data-testid="new-item-menu">
                {t('project_tasks.new', 'New task')}<ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
            </PrimaryButton>
            <AnchoredMenu open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} role="menu" align="right" width={224}
                className={MENU_PANEL_CLASS} aria-label={t('project_tasks.new_menu', 'Choose what to create')}>
                {items.map(([type, label, glyph]) => (
                    <MenuItem key={label} data-testid={type ? `new-item-${type}` : 'new-item-task'} icon={glyph}
                        onClick={() => { setOpen(false); onPick({ itemType: type }); }}>
                        {label}
                    </MenuItem>
                ))}
                <MenuSeparator />
                <MenuItem data-testid="tasks-from-meeting" icon={<Mic className={icon} />} onClick={() => { setOpen(false); onFromMeeting(); }}>
                    {t('project_tasks.from_meeting_button', 'From a meeting')}
                </MenuItem>
            </AnchoredMenu>
        </span>
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
    const board = useProjectBoard(projectId);
    const boardActions = useBoardActions(projectId);
    // false: closed; true: open; a focus: open at that column's field (from a lane menu).
    const [configure, setConfigure] = useState<boolean | BoardFocus>(false);
    const update = useUpdateTask(projectId);
    const people = useChatPeople(projectId, currentUser);
    // Tasks deleted but still undoable: gone from the views at once, the real DELETE waits for the toast to expire.
    const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
    const all = useMemo(() => (query.data?.tasks || []).filter(task => !removed.has(task.id)), [query.data, removed]);
    const labels = useMemo(() => allLabels(all).filter(label => !label.startsWith('bf:')), [all]);
    const onError = (e: Error) => toast.error(projectErrorText(t, e));
    const remove = useDeleteTask(projectId);
    const mayDelete = (task: ProjectTask) => mayDeleteTask(task, me, role === 'owner', canEdit);
    const setRemovedId = (id: string, gone: boolean) => setRemoved((prev) => {
        const next = new Set(prev);
        if (gone) next.add(id); else next.delete(id);
        return next;
    });
    const deleteTask = (task: ProjectTask) => {
        setRemovedId(task.id, true);
        toast.undoable({
            message: t('project_home.task_deleted', 'Task "{name}" deleted', { name: task.title || t('project_tasks.untitled', 'Untitled task') }),
            undoLabel: t('project_home.undo', 'Undo'),
            onUndo: () => setRemovedId(task.id, false),
            onExpire: () => remove.mutate(task.id, {
                onError: (e) => { setRemovedId(task.id, false); onError(e); },
            }),
        });
    };
    const { openNew, openTask, dialog } = useTaskDialog(props, labels, deleteTask);
    const [view, setView] = useState<View>(storedView);
    const filterKey = `projectTaskFilters:${projectId}:${me || ''}`;
    const [filters, setFilters] = useState<TaskFilters>(() => storedFilters(filterKey));
    useEffect(() => { try { scopedStorage.setItem(filterKey, JSON.stringify(filters)); } catch { /* optional preference */ } }, [filterKey, filters]);
    const [sort, setSort] = useState<TaskSort>('due');
    const [fromMeeting, setFromMeeting] = useState(false);
    useOpenFromRoute(props.sub, query.data?.tasks, openTask);

    const shown = useMemo(() => applyFilters(all, filters, me, todayKey()).filter(task => !filters.search?.trim() || `${task.title} ${task.description || ''}`.toLocaleLowerCase().includes(filters.search.trim().toLocaleLowerCase())), [all, filters, me]);
    const setStatus = (task: ProjectTask, status: TaskStatus) => update.mutate({ id: task.id, patch: { status } }, { onError });
    const move = (task: ProjectTask, status: TaskStatus, beforeId: string | null, columnId?: string) => {
        if (columnId) boardActions.move.mutate({ taskId: task.id, columnId, beforeId }, { onError });
        else update.mutate({ id: task.id, patch: { status, beforeId } }, { onError });
    };
    const quickCreate = async (columnId: string, title: string) => {
        try { await boardActions.create.mutateAsync({ columnId, title }); } catch (e) { onError(e as Error); throw e; }
    };
    const changeView = (next: View) => { setView(next); try { scopedStorage.setItem(VIEW_KEY, next); } catch { /* the choice just does not outlive the page */ } };
    const open = all.filter(x => x.status !== 'done').length;

    // One state at a time under the toolbar: error, loading, empty project, no match, or the view.
    // An empty project gets the shared empty state only in the list: the board's empty lanes keep
    // their quick-add, the hierarchy has its own "Create an epic", and planning (sprints, poker)
    // works without tasks. Planning also keeps its content when a filter matches nothing.
    const loading = query.isPending || (view === 'board' && board.isPending);
    const emptyProject = !!query.data && all.length === 0 && view === 'list';
    const noMatch = !!query.data && all.length > 0 && shown.length === 0 && view !== 'planning';
    const ready = !!query.data && !emptyProject && !noMatch;
    // List and hierarchy read best in a centred column; board and planning use the full width.
    // The toolbar shares the frame so its left edge always lines up with the content.
    const frame = view === 'board' || view === 'planning' ? 'w-full' : 'max-w-5xl mx-auto';

    return (
        <div className="h-full flex flex-col min-h-0" data-testid="project-tasks-tab">
            <StudioSectionHeader icon={CheckSquare} title={t('project_tasks.title', 'Tasks')}
                statusChip={query.data ? t('project_tasks.open_count', '{count} open', { count: open }) : null}
                primary={canEdit ? <NewItemMenu onPick={(preset) => openNew(undefined, undefined, undefined, preset)} onFromMeeting={() => setFromMeeting(true)} /> : undefined} />
            <div className={`flex-none ${frame} px-4 sm:px-6 pt-3 pb-1`}>
                <TasksToolbar view={view} onView={changeView} showFilters={all.length > 0} filters={filters} onFilters={setFilters}
                    sort={sort} onSort={setSort} people={people} me={me} labels={labels}
                    trailing={canEdit && view === 'board' ? (
                        <button type="button" className={ICON_BUTTON_CLASS} onClick={() => setConfigure(true)} disabled={!board.data} aria-haspopup="dialog" aria-expanded={!!configure}
                            aria-label={t('project_tasks.configure_board', 'Configure board')} title={t('project_tasks.configure_board', 'Configure board')}>
                            <Settings2 className="w-4 h-4" aria-hidden="true" />
                        </button>
                    ) : undefined} />
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                <div className={`${frame} px-4 sm:px-6 py-3 space-y-4 min-w-0`}>
                    {query.isError ? (
                        <Notice tone="error" role="alert" action={<GhostButton onClick={() => query.refetch()}>{t('project_chat.retry', 'Try again')}</GhostButton>}>
                            {t('project_tasks.load_failed', 'Could not load the tasks of this project.')}
                        </Notice>
                    ) : view === 'board' && board.isError && (
                        <Notice tone="error" role="alert" action={<GhostButton onClick={() => board.refetch()}>{t('project_chat.retry', 'Try again')}</GhostButton>}>
                            {t('project_tasks.board_failed', 'Could not load the board columns.')}
                        </Notice>
                    )}
                    {loading && !query.isError && <TasksSkeleton />}
                    {emptyProject && (
                        <EmptyState icon={<CheckSquare className="w-8 h-8" />}
                            title={t('project_tasks.empty_title', 'No tasks yet')}
                            description={<span className="text-[12.5px]">{t('project_tasks.empty_hint', "Write down what needs doing, or turn a meeting's action items into tasks.")}</span>}
                            action={canEdit ? { label: t('project_tasks.new', 'New task'), onClick: () => openNew(), variant: 'secondary' } : undefined} />
                    )}
                    {noMatch && (
                        <div className="py-10 flex flex-col items-center gap-2 text-center" data-testid="tasks-no-match">
                            <p className="m-0 text-[13px] text-[var(--text-secondary)]">{t('project_tasks.no_matches', 'No tasks match this filter.')}</p>
                            <GhostButton onClick={() => setFilters(NO_FILTERS)}>{t('project_tasks.clear_filters', 'Clear filters')}</GhostButton>
                        </div>
                    )}
                    {ready && view === 'list' && <TaskList projectId={projectId} tasks={shown} sort={sort} canEdit={canEdit} people={people} onOpen={openTask} onStatus={setStatus} onDelete={deleteTask} mayDelete={mayDelete} onAdd={canEdit ? () => openNew() : undefined} />}
                    {ready && view === 'hierarchy' && <HierarchyView projectId={projectId} tasks={shown} canEdit={canEdit} people={people} onOpen={openTask}
                        onAddChild={(parent) => openNew(undefined, undefined, undefined, { itemType: childWorkItemType(workItemType(parent)) || undefined, parentTaskId: parent.id })}
                        onNewEpic={canEdit ? () => openNew(undefined, undefined, undefined, { itemType: 'epic' }) : undefined} />}
                    {query.data && view === 'planning' && <TaskPlanning projectId={projectId} tasks={shown} canEdit={canEdit} busy={update.isPending} people={people} onOpen={openTask} onDependency={(task, predecessor) => update.mutate({ id: task.id, patch: { links: [...task.links.filter(link => !(link.kind === 'task' && link.id === predecessor.id)), { kind: 'task', id: predecessor.id, relation: 'depends_on' }] } }, { onError })} onDates={(task, dates) => update.mutate({ id: task.id, patch: dates }, { onError })} />}
                    {ready && board.data && view === 'board' && <TaskBoard allTasks={all} columns={board.data.columns} assignments={board.data.assignments} onCreate={quickCreate} onConfigure={canEdit ? (focus) => setConfigure(focus || true) : undefined} busy={boardActions.move.isPending} tasks={shown} canEdit={canEdit} people={people} onOpen={openTask} onMove={move} onDelete={deleteTask} mayDelete={mayDelete} />}
                </div>
            </div>
            {configure && board.data && <BoardSettings projectId={projectId} board={board.data} focus={configure === true ? undefined : configure} onClose={() => setConfigure(false)} />}
            {dialog}
            {fromMeeting && <MeetingTasksDialog projectId={projectId} currentUser={currentUser} onClose={() => setFromMeeting(false)} />}
        </div>
    );
}
