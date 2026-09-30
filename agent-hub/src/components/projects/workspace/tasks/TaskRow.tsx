// One task in the list: a tick to finish it, its title, and what is on it
// (priority, labels, checklist progress, links, due date, people).

import { CalendarDays, Check, Circle, CircleDot, Link2, ListChecks } from 'lucide-react';
import React from 'react';
import type { ProjectTask, TaskStatus } from '../../../../api/queries/projectTasks';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { useChatPeople } from '../chat/chatPeople';
import { inkOf, washOf } from '../memberColors';
import { Avatar } from '../workspaceUi';
import DeleteTaskButton from './DeleteTaskButton';
import { LabelChip, PriorityMark } from './TaskFields';
import { checklistProgress, formatDue, isOverdue } from './taskText';

export function StatusButton({ task, canEdit, onChange }: { task: ProjectTask; canEdit: boolean; onChange: (s: TaskStatus) => void }) {
    const { t } = useTranslation();
    const done = task.status === 'done';
    const Icon = done ? Check : task.status === 'doing' ? CircleDot : Circle;
    return (
        <button type="button" disabled={!canEdit} onClick={(e) => { e.stopPropagation(); onChange(done ? 'todo' : 'done'); }}
            aria-label={done ? t('project_tasks.mark_open', 'Mark as not done') : t('project_tasks.mark_done', 'Mark as done')}
            title={done ? t('project_tasks.mark_open', 'Mark as not done') : t('project_tasks.mark_done', 'Mark as done')}
            className={`grid place-items-center w-5 h-5 rounded-full flex-shrink-0 border transition-colors ${done
                ? 'bg-[var(--accent-primary)] border-[var(--accent-primary)] text-[var(--accent-primary-fg)]'
                : 'border-[var(--border-strong,var(--border-default))] text-[var(--text-tertiary)] hover:border-[var(--accent-primary)]'}`}>
            <Icon className="w-3 h-3" aria-hidden="true" />
        </button>
    );
}

/** Who has a task, by name: the first person with their face, the rest as faces; "Not assigned" when nobody. */
export function Assignees({ ids, people, max = 3 }: { ids: string[]; people: ReturnType<typeof useChatPeople>; max?: number }) {
    const { t } = useTranslation();
    if (!ids.length) {
        return <span className="text-[12px] italic text-[var(--text-tertiary)]" data-testid="task-unassigned">{t('project_tasks.not_assigned', 'Not assigned')}</span>;
    }
    const names = ids.map(id => people.nameOf(id) || t('project_chat.someone', 'A member'));
    return (
        <span className="inline-flex items-center gap-1.5 min-w-0" data-testid="task-assignees" title={names.join(', ')}>
            <span className="flex -space-x-1.5">
                {ids.slice(0, max).map(id => <Avatar key={id} name={people.nameOf(id)} size="sm" picture={people.avatarOf(id)} color={people.colorOf(id)} />)}
            </span>
            <span className="text-[12px] font-medium truncate max-w-[9rem]" style={{ color: inkOf(people.colorOf(ids[0])) }}>
                {names[0]}{ids.length > 1 ? ` +${ids.length - 1}` : ''}
            </span>
        </span>
    );
}

/** The small facts shared by the list row and the board card. */
export function TaskFacts({ task, people, max = 3 }: { task: ProjectTask; people: ReturnType<typeof useChatPeople>; max?: number }) {
    const { t, locale } = useTranslation();
    const overdue = isOverdue(task.dueDate, task.status);
    const progress = checklistProgress(task.checklist);
    return (
        <>
            {progress && (
                <span className="inline-flex items-center gap-1 text-[12px] text-[var(--text-tertiary)]" title={t('project_tasks.checklist_progress', '{done} of {total} steps done', progress)}>
                    <ListChecks className="w-3.5 h-3.5" aria-hidden="true" />{progress.done}/{progress.total}
                </span>
            )}
            {task.links.length > 0 && (
                <span className="inline-flex items-center gap-1 text-[12px] text-[var(--text-tertiary)]" title={t('project_tasks.links_count', '{count} linked', { count: task.links.length })}>
                    <Link2 className="w-3.5 h-3.5" aria-hidden="true" />{task.links.length}
                </span>
            )}
            {task.dueDate && (
                <span className={`inline-flex items-center gap-1 text-[12px] whitespace-nowrap ${overdue ? 'text-[var(--error-ink)] font-medium' : 'text-[var(--text-tertiary)]'}`}>
                    <CalendarDays className="w-3.5 h-3.5" aria-hidden="true" />{formatDue(task.dueDate, locale)}
                </span>
            )}
            <Assignees ids={task.assigneeIds} people={people} max={max} />
        </>
    );
}

/** The quiet coloured edge of a task: the colour of the person who has it (none when nobody does). */
export function assigneeEdge(task: ProjectTask, people: ReturnType<typeof useChatPeople>): React.CSSProperties | undefined {
    return task.assigneeIds.length ? { borderLeftWidth: 3, borderLeftColor: washOf(people.colorOf(task.assigneeIds[0]), 60) } : undefined;
}

export default function TaskRow({ task, canEdit, people, onOpen, onStatus, onDelete }: {
    task: ProjectTask; canEdit: boolean; people: ReturnType<typeof useChatPeople>; onOpen: () => void; onStatus: (s: TaskStatus) => void;
    /** Present when the reader may delete this task. */
    onDelete?: (task: ProjectTask) => void;
}) {
    const { t } = useTranslation();
    const done = task.status === 'done';
    return (
        <li>
            <div role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
                data-testid={`project-task-${task.id}`} style={assigneeEdge(task, people)}
                className="flex items-center gap-3 px-3 py-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] cursor-pointer hover:border-[var(--border-default)] hover:bg-[var(--item-hover-bg)] transition-colors">
                <StatusButton task={task} canEdit={canEdit} onChange={onStatus} />
                <div className="flex-1 min-w-0">
                    <p className={`m-0 flex items-center gap-2 text-[13.5px] font-medium ${done ? 'line-through text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]'}`}>
                        <span className="truncate">{task.title || t('project_tasks.untitled', 'Untitled task')}</span>
                        <PriorityMark priority={task.priority} />
                    </p>
                    {task.labels.length > 0 && (
                        <span className="mt-1 flex flex-wrap gap-1">{task.labels.slice(0, 4).map(l => <LabelChip key={l} label={l} />)}</span>
                    )}
                </div>
                <TaskFacts task={task} people={people} />
                {onDelete && <DeleteTaskButton task={task} onDelete={onDelete} className="opacity-60 hover:opacity-100 focus-visible:opacity-100" />}
            </div>
        </li>
    );
}
