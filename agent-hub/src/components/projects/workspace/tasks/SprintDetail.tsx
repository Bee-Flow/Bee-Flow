// The right pane of the Sprints view: the sprint's header, a stats strip, the
// items in the sprint and the backlog to add from, as two divided row lists.
// Membership is mirrored into `bf:sprint:*` labels so older clients still show it.

import { Plus, Search, X } from 'lucide-react';
import React, { useState } from 'react';
import { useUpdateTask, type ProjectTask } from '../../../../api/queries/projectTasks';
import { useAssignSprintItems, useUnassignSprintItem, type Sprint } from '../../../../api/queries/projectSprints';
import { useTranslation } from '../../../../hooks/useTranslation';
import { toast } from '../../../shared/Toast';
import type { useChatPeople } from '../chat/chatPeople';
import { projectErrorText } from '../projectErrorText';
import { GhostButton } from '../workspaceUi';
import { Faces } from './planningParts';
import SprintHeader from './SprintHeader';
import { TypeChip } from './TaskFields';
import { storyPoints, withPlanningMeta, workItemType } from './taskPlanning';
import { ICON_BUTTON, META, pointsText, ProgressBar, REVEAL, ROW_LIST, SECTION_LABEL, SMALL_INPUT, StatusDot } from './sprintUi';

type People = ReturnType<typeof useChatPeople>;
const ROW = 'group flex items-center gap-3 px-3 h-10 hover:bg-[var(--item-hover-bg)] transition-colors';
const ROW_TITLE = 'min-w-0 flex-1 truncate text-left text-[13px] font-medium text-[var(--text-primary)] rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]';
const EMPTY_LINE = 'py-6 text-center text-[12.5px] text-[var(--text-tertiary)]';

function ListLabel({ label, count, children }: { label: string; count: number; children?: React.ReactNode }) {
    return (
        <div className="flex h-7 items-center gap-2">
            <h4 className={SECTION_LABEL}>{label}<span className="ml-1.5 font-normal tabular-nums">{count}</span></h4>
            {children}
        </div>
    );
}

function StatsStrip({ items, capacity }: { items: ProjectTask[]; capacity: number }) {
    const { t } = useTranslation();
    const points = items.reduce((sum, task) => sum + (storyPoints(task) || 0), 0);
    const doneItems = items.filter(task => task.status === 'done');
    const done = doneItems.length;
    const pointsDone = doneItems.reduce((sum, task) => sum + (storyPoints(task) || 0), 0);
    const over = capacity > 0 && points > capacity;
    return (
        <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 tabular-nums ${META}`} data-testid="sprint-stats">
            <span>{t('project_tasks.sprint_done_short', '{done}/{total} done', { done, total: items.length })}</span>
            {pointsDone > 0 && <><span aria-hidden="true">·</span><span>{t('project_tasks.sprint_points_finished', '{points} pts finished', { points: pointsDone })}</span></>}
            <span aria-hidden="true">·</span>
            <span className={over ? 'text-[var(--warning-ink)]' : ''}>
                {capacity ? t('project_tasks.sprint_capacity_short', '{points}/{capacity} pts', { points, capacity }) : t('project_tasks.points_short', '{points} pts', { points })}
            </span>
            {capacity > 0 && <ProgressBar value={points} max={capacity} tone={over ? 'warning' : 'accent'} className="ml-1 w-32"
                label={t('project_tasks.sprint_capacity_used', '{points} of {capacity} points planned', { points, capacity })} />}
        </div>
    );
}

function SprintItems({ projectId, sprint, items, canEdit, people, onOpen }: {
    projectId: string; sprint: Sprint; items: ProjectTask[]; canEdit: boolean; people?: People; onOpen: (task: ProjectTask) => void;
}) {
    const { t } = useTranslation();
    const unassign = useUnassignSprintItem(projectId);
    const updateTask = useUpdateTask(projectId);
    const onError = (e: Error) => toast.error(projectErrorText(t, e));
    const removeFrom = (task: ProjectTask) => {
        if (task.sprintId === sprint.id) unassign.mutate({ sprintId: sprint.id, taskId: task.id }, { onSuccess: () => toast.success(t('project_tasks.sprint_item_removed', 'Removed from the sprint')), onError });
        updateTask.mutate({ id: task.id, patch: { labels: withPlanningMeta(task.labels, { sprint: null }) } }, { onError });
    };
    return (
        <section className="min-w-0 space-y-2" aria-label={t('project_tasks.sprint_items', 'In this sprint')}>
            <ListLabel label={t('project_tasks.sprint_items', 'In this sprint')} count={items.length} />
            <ul className={ROW_LIST}>
                {items.length ? items.map(task => (
                    <li key={task.id} className={ROW}>
                        <StatusDot status={task.status} />
                        <TypeChip type={workItemType(task)} />
                        <button type="button" className={ROW_TITLE} onClick={() => onOpen(task)}>{task.title}</button>
                        <span className={`${META} flex-none tabular-nums`}>{pointsText(t, storyPoints(task))}</span>
                        {people && <Faces ids={task.assigneeIds} people={people} />}
                        {canEdit && (
                            <button type="button" className={`${ICON_BUTTON} ${REVEAL} hover:!text-[var(--error-ink)]`} onClick={() => removeFrom(task)}
                                aria-label={t('project_tasks.sprint_remove_item', 'Remove {title} from the sprint', { title: task.title })}
                                title={t('project_tasks.sprint_remove', 'Remove from sprint')}>
                                <X className="w-3.5 h-3.5" aria-hidden="true" />
                            </button>
                        )}
                    </li>
                )) : <li className={EMPTY_LINE}>{t('project_tasks.sprint_empty', 'No work added yet.')}</li>}
            </ul>
        </section>
    );
}

function SprintBacklog({ projectId, sprint, backlog, canEdit, onOpen }: {
    projectId: string; sprint: Sprint; backlog: ProjectTask[]; canEdit: boolean; onOpen: (task: ProjectTask) => void;
}) {
    const { t } = useTranslation();
    const assign = useAssignSprintItems(projectId);
    const updateTask = useUpdateTask(projectId);
    const [query, setQuery] = useState('');
    const onError = (e: Error) => toast.error(projectErrorText(t, e));
    const addTo = (task: ProjectTask) => {
        assign.mutate({ sprintId: sprint.id, taskIds: [task.id] }, { onSuccess: () => toast.success(t('project_tasks.sprint_item_added', 'Added to the sprint')), onError });
        // The legacy mirror: older clients read membership from the labels.
        updateTask.mutate({ id: task.id, patch: { labels: withPlanningMeta(task.labels, { sprint: sprint.name, sprintStart: sprint.startDate || undefined, sprintEnd: sprint.endDate || undefined }) } }, { onError });
    };
    const needle = query.trim().toLowerCase();
    const shown = needle ? backlog.filter(task => task.title.toLowerCase().includes(needle)) : backlog;
    return (
        <section className="min-w-0 space-y-2" aria-label={t('project_tasks.sprint_add_from_backlog', 'Add from backlog')}>
            <ListLabel label={t('project_tasks.backlog', 'Backlog')} count={backlog.length}>
                {backlog.length > 0 && (
                    <label className="relative ml-auto">
                        <Search className="pointer-events-none absolute left-2 top-1/2 w-3.5 h-3.5 -translate-y-1/2 text-[var(--text-tertiary)]" aria-hidden="true" />
                        <input type="search" value={query} onChange={e => setQuery(e.target.value)} className={`${SMALL_INPUT} !h-7 !w-44 pl-7 !text-[12.5px]`}
                            aria-label={t('project_tasks.backlog_search', 'Search the backlog')} placeholder={t('project_tasks.backlog_search_short', 'Filter backlog')} />
                    </label>
                )}
            </ListLabel>
            <ul className={ROW_LIST}>
                {shown.length ? shown.map(task => (
                    <li key={task.id} className={ROW}>
                        <StatusDot status={task.status} />
                        <TypeChip type={workItemType(task)} />
                        <button type="button" className={ROW_TITLE} onClick={() => onOpen(task)}>{task.title}</button>
                        <span className={`${META} flex-none tabular-nums`}>{pointsText(t, storyPoints(task))}</span>
                        {canEdit && (
                            <GhostButton className={`${REVEAL} flex-none`} onClick={() => addTo(task)} title={t('project_tasks.sprint_add_item_to', 'Add to {name}', { name: sprint.name })}>
                                <Plus className="w-3.5 h-3.5" aria-hidden="true" />{t('project_tasks.sprint_add_item', 'Add')}
                            </GhostButton>
                        )}
                    </li>
                )) : <li className={EMPTY_LINE}>{backlog.length ? t('project_tasks.backlog_no_match', 'Nothing in the backlog matches.') : t('project_tasks.backlog_clear', 'Backlog is clear.')}</li>}
            </ul>
        </section>
    );
}

export default function SprintDetail({ projectId, sprint, items, backlog, canEdit, people, onOpen, onDeleted }: {
    projectId: string; sprint: Sprint; items: ProjectTask[]; backlog: ProjectTask[]; canEdit: boolean;
    people?: People; onOpen: (task: ProjectTask) => void; onDeleted: () => void;
}) {
    return (
        <section className="min-w-0 space-y-4" data-testid="sprint-detail" aria-label={sprint.name}>
            <div className="space-y-2">
                <SprintHeader projectId={projectId} sprint={sprint} items={items} canEdit={canEdit} onDeleted={onDeleted} />
                <StatsStrip items={items} capacity={sprint.capacityPoints || 0} />
            </div>
            <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
                <SprintItems projectId={projectId} sprint={sprint} items={items} canEdit={canEdit} people={people} onOpen={onOpen} />
                {sprint.status !== 'closed' && <SprintBacklog projectId={projectId} sprint={sprint} backlog={backlog} canEdit={canEdit} onOpen={onOpen} />}
            </div>
        </section>
    );
}
