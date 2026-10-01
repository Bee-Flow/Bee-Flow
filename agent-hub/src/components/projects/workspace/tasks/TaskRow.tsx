// One task in the list: a single 40px line inside its status group's card. A tick to finish
// it, its type chip and title, at most two labels, then the quiet facts (checklist, links, points,
// due date, priority) and the people on it. Delete only shows on hover, focus or touch.

import { CalendarDays, Link2, ListChecks } from 'lucide-react';
import React from 'react';
import type { ProjectTask, TaskStatus } from '../../../../api/queries/projectTasks';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { useChatPeople } from '../chat/chatPeople';
import { Avatar } from '../workspaceUi';
import DeleteTaskButton from './DeleteTaskButton';
import { LabelChip, PriorityIcon, StatusMark, TypeChip } from './TaskFields';
import { checklistProgress, dueState, formatDue } from './taskText';
import { visibleLabels, workItemType, storyPoints } from './taskPlanning';

type People = ReturnType<typeof useChatPeople>;

/** Hover-revealed on a pointer, always there on touch, and visible whenever the row has focus. */
const REVEAL_ON_INTENT = 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity';

function StatusButton({ task, canEdit, onChange }: { task: ProjectTask; canEdit: boolean; onChange: (s: TaskStatus) => void }) {
    const { t } = useTranslation();
    const done = task.status === 'done';
    const label = done ? t('project_tasks.mark_open', 'Mark as not done') : t('project_tasks.mark_done', 'Mark as done');
    return (
        <button type="button" disabled={!canEdit} onClick={(e) => { e.stopPropagation(); onChange(done ? 'todo' : 'done'); }}
            aria-label={label} title={label}
            className="group/status grid place-items-center w-6 h-6 -m-1 rounded-full flex-shrink-0 disabled:cursor-default">
            {task.status === 'todo'
                ? <span className="w-4 h-4 rounded-full border-[1.5px] border-[var(--border-default)] transition-colors group-enabled/status:group-hover/status:border-[var(--text-tertiary)]" aria-hidden="true" />
                : <StatusMark status={task.status} />}
        </button>
    );
}

/**
 * Who has a task: their faces, with every name in the tooltip and for a screen reader.
 * `showName` adds the first name as text (the board card does this for a lone person).
 * Nobody: an invisible "Not assigned" for a screen reader, and an empty circle on hover.
 */
export function Assignees({ ids, people, max = 3, showName = false }: { ids: string[]; people: People; max?: number; showName?: boolean }) {
    const { t } = useTranslation();
    if (!ids.length) {
        return (
            <span className="inline-flex flex-none" data-testid="task-unassigned" title={t('project_tasks.not_assigned', 'Not assigned')}>
                <span className="w-6 h-6 rounded-full border border-dashed border-[var(--border-default)] opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity" aria-hidden="true" />
                <span className="sr-only">{t('project_tasks.not_assigned', 'Not assigned')}</span>
            </span>
        );
    }
    const names = ids.map(id => people.nameOf(id) || t('project_chat.someone', 'A member'));
    const summary = `${names[0]}${ids.length > 1 ? ` +${ids.length - 1}` : ''}`;
    const extra = ids.length - max;
    return (
        <span className="inline-flex items-center gap-1.5 min-w-0 flex-none" data-testid="task-assignees" title={names.join(', ')}>
            <span className="flex -space-x-1.5">
                {ids.slice(0, max).map(id => <Avatar key={id} name={people.nameOf(id)} size="sm" picture={people.avatarOf(id)} color={people.colorOf(id)} className="!ring-[var(--bg-card)]" />)}
                {extra > 0 && (
                    <span className="relative inline-grid place-items-center w-6 h-6 rounded-full bg-[var(--bg-secondary)] text-[10px] font-semibold text-[var(--text-secondary)] tabular-nums ring-2 ring-[var(--bg-card)]" aria-hidden="true">+{extra}</span>
                )}
            </span>
            {showName
                ? <span className="text-[12px] text-[var(--text-secondary)] truncate max-w-[9rem]">{summary}</span>
                : <span className="sr-only">{summary}</span>}
        </span>
    );
}

/**
 * The quiet facts of a task as one meta line: checklist, links, points, due date and the
 * priority glyph. Text only, 11.5px tertiary; colour appears only when a date is at risk.
 */
export function TaskMeta({ task, showPoints = true, showPriority = true }: { task: ProjectTask; showPoints?: boolean; showPriority?: boolean }) {
    const { t, locale } = useTranslation();
    const progress = checklistProgress(task.checklist);
    const points = showPoints ? storyPoints(task) : null;
    const due = dueState(task.dueDate, task.status);
    return (
        <>
            {progress && (
                <span className={`inline-flex items-center gap-1 ${progress.done === progress.total ? 'text-[var(--success-ink)]' : ''}`} title={t('project_tasks.checklist_progress', '{done} of {total} steps done', progress)}>
                    <ListChecks className="w-3.5 h-3.5" aria-hidden="true" />{progress.done}/{progress.total}
                </span>
            )}
            {task.links.length > 0 && (
                <span className="inline-flex items-center gap-1" title={t('project_tasks.links_count', '{count} linked', { count: task.links.length })}>
                    <Link2 className="w-3.5 h-3.5" aria-hidden="true" />{task.links.length}
                </span>
            )}
            {!!points && <span className="whitespace-nowrap">{t('project_tasks.points_short', '{points} pts', { points })}</span>}
            {task.dueDate && (
                <span title={t('project_tasks.due_label', 'Due date')}
                    className={`inline-flex items-center gap-1 whitespace-nowrap ${due === 'overdue' ? 'text-[var(--error-ink)] font-medium' : due === 'soon' ? 'text-[var(--warning-ink)]' : ''}`}>
                    <CalendarDays className="w-3.5 h-3.5" aria-hidden="true" />{formatDue(task.dueDate, locale)}
                </span>
            )}
            {showPriority && <PriorityIcon priority={task.priority} />}
        </>
    );
}

export default function TaskRow({ task, canEdit, people, onOpen, onStatus, onDelete }: {
    task: ProjectTask; canEdit: boolean; people: People; onOpen: () => void; onStatus: (s: TaskStatus) => void;
    /** Present when the reader may delete this task. */
    onDelete?: (task: ProjectTask) => void;
}) {
    const { t } = useTranslation();
    const done = task.status === 'done';
    const title = task.title || t('project_tasks.untitled', 'Untitled task');
    const labels = visibleLabels(task.labels);
    return (
        <li>
            <div role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(); } }}
                data-testid={`project-task-${task.id}`}
                className="group flex flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-1 px-3 py-2 sm:py-0 min-h-10 sm:h-10 cursor-pointer outline-none transition-colors hover:bg-[var(--item-hover-bg)] focus-visible:bg-[var(--item-hover-bg)] focus-visible:shadow-[inset_0_0_0_2px_var(--accent-primary)]">
                <div className="flex items-center gap-3 min-w-0 basis-full sm:basis-auto">
                    <StatusButton task={task} canEdit={canEdit} onChange={onStatus} />
                    <TypeChip type={workItemType(task)} />
                    <span title={title} className={`min-w-0 truncate text-[13px] font-medium ${done ? 'line-through text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]'}`}>
                        {title}
                    </span>
                </div>
                {labels.length > 0 && (
                    <span className="flex items-center gap-1 flex-none pl-7 sm:pl-0">
                        {labels.slice(0, 2).map(l => <LabelChip key={l} label={l} />)}
                        {labels.length > 2 && <span className="text-[11px] text-[var(--text-tertiary)] tabular-nums" title={labels.slice(2).join(', ')}>+{labels.length - 2}</span>}
                    </span>
                )}
                <div className="ml-auto flex flex-wrap sm:flex-nowrap items-center justify-end gap-x-3 gap-y-1 min-w-0 sm:flex-none">
                    <span className="flex flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-1 text-[11.5px] text-[var(--text-tertiary)] tabular-nums">
                        <TaskMeta task={task} />
                    </span>
                    <Assignees ids={task.assigneeIds} people={people} />
                    {onDelete
                        ? <DeleteTaskButton task={task} onDelete={onDelete} className={`-mr-1.5 ${REVEAL_ON_INTENT}`} />
                        : canEdit && <span className="hidden sm:block w-7 -mr-1.5" aria-hidden="true" />}
                </div>
            </div>
        </li>
    );
}
