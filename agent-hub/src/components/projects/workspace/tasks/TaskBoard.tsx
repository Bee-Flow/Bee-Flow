// The board: one column per status, cards you drag between and within them.
// Dropping on a card puts the task right before it; dropping on a column puts
// it at the end. Every card also has a "Move to" list, so the board works
// without a pointer.

import {
    DndContext, DragOverlay, KeyboardSensor, PointerSensor, pointerWithin, useDraggable, useDroppable, useSensor, useSensors,
    type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core';
import React, { useMemo, useState } from 'react';
import { TASK_STATUSES, type ProjectTask, type TaskStatus } from '../../../../api/queries/projectTasks';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { useChatPeople } from '../chat/chatPeople';
import { SELECT_CLASS } from '../workspaceUi';
import DeleteTaskButton from './DeleteTaskButton';
import { LabelChip, PriorityMark } from './TaskFields';
import { assigneeEdge, TaskFacts } from './TaskRow';
import { statusLabel } from './taskText';

type People = ReturnType<typeof useChatPeople>;

export interface TaskBoardProps {
    tasks: ProjectTask[];
    canEdit: boolean;
    people: People;
    onOpen: (task: ProjectTask) => void;
    /** `beforeId`: the task it now sits right before in `status`; null for the end of the column. */
    onMove: (task: ProjectTask, status: TaskStatus, beforeId: string | null) => void;
    /** Given for the tasks the reader may delete. */
    onDelete?: (task: ProjectTask) => void;
    mayDelete?: (task: ProjectTask) => boolean;
}

const COLUMN_PREFIX = 'column:';
const CARD_PREFIX = 'card:';

function Card({ task, canEdit, people, dragging, onOpen, onMove, onDelete }: {
    task: ProjectTask; canEdit: boolean; people: People; dragging?: boolean; onOpen: () => void; onMove: (status: TaskStatus) => void;
    onDelete?: (task: ProjectTask) => void;
}) {
    const { t } = useTranslation();
    const drag = useDraggable({ id: task.id, disabled: !canEdit });
    const drop = useDroppable({ id: `${CARD_PREFIX}${task.id}` });
    const done = task.status === 'done';
    return (
        <li ref={drop.setNodeRef}>
            <div ref={drag.setNodeRef} {...drag.attributes} {...drag.listeners}
                data-testid={`board-task-${task.id}`} style={assigneeEdge(task, people)}
                className={`group/card relative rounded-xl border bg-[var(--bg-card)] p-2.5 space-y-2 cursor-grab active:cursor-grabbing transition-colors ${drop.isOver ? 'border-[var(--accent-primary)]' : 'border-[var(--border-subtle)] hover:border-[var(--border-default)]'} ${drag.isDragging && !dragging ? 'opacity-40' : ''}`}>
                <button type="button" onClick={onOpen} className="block w-full text-left bg-transparent p-0 border-0 cursor-pointer">
                    <span className={`flex items-start gap-2 text-[13px] font-medium ${done ? 'line-through text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]'}`}>
                        <span className="flex-1 min-w-0 break-words">{task.title || t('project_tasks.untitled', 'Untitled task')}</span>
                        <PriorityMark priority={task.priority} />
                    </span>
                </button>
                {onDelete && <DeleteTaskButton task={task} onDelete={onDelete} className="absolute top-1.5 right-1.5 opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100" />}
                {task.labels.length > 0 && <span className="flex flex-wrap gap-1">{task.labels.slice(0, 3).map(l => <LabelChip key={l} label={l} />)}{task.labels.length > 3 && <span className="text-[11px] text-[var(--text-tertiary)]">+{task.labels.length - 3}</span>}</span>}
                <div className="flex items-center gap-2.5 flex-wrap"><TaskFacts task={task} people={people} max={2} /></div>
                {canEdit && (
                    <select value={task.status} onChange={e => onMove(e.target.value as TaskStatus)} onPointerDown={e => e.stopPropagation()}
                        aria-label={t('project_tasks.move_to', 'Move to')}
                        className={`${SELECT_CLASS} !h-7 w-full opacity-0 focus:opacity-100 group-hover/card:opacity-100 group-focus-within/card:opacity-100 transition-opacity`}>
                        {TASK_STATUSES.map(s => <option key={s} value={s}>{t('project_tasks.move_to_status', 'Move to: {status}', { status: statusLabel(t, s) })}</option>)}
                    </select>
                )}
            </div>
        </li>
    );
}

function Column({ status, tasks, ...rest }: { status: TaskStatus; tasks: ProjectTask[] } & Omit<React.ComponentProps<typeof Card>, 'task' | 'onOpen' | 'onMove'> & {
    onOpenTask: (t: ProjectTask) => void; onMoveTask: (t: ProjectTask, s: TaskStatus) => void;
    onDeleteTask?: (t: ProjectTask) => void; mayDelete?: (t: ProjectTask) => boolean;
}) {
    const { t } = useTranslation();
    const { setNodeRef, isOver } = useDroppable({ id: `${COLUMN_PREFIX}${status}` });
    const { onOpenTask, onMoveTask, onDeleteTask, mayDelete, ...card } = rest;
    return (
        <section ref={setNodeRef} aria-label={statusLabel(t, status)} data-testid={`board-column-${status}`}
            className={`flex flex-col min-h-[12rem] rounded-2xl border p-2.5 gap-2 bg-[var(--bg-secondary)]/50 ${isOver ? 'border-[var(--accent-primary)]' : 'border-[var(--border-subtle)]'}`}>
            <h3 className="m-0 px-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
                {statusLabel(t, status)}<span className="font-normal">{tasks.length}</span>
            </h3>
            <ul className="list-none m-0 p-0 space-y-2 flex-1">
                {tasks.map(task => <Card key={task.id} task={task} {...card} onOpen={() => onOpenTask(task)} onMove={s => onMoveTask(task, s)}
                    onDelete={onDeleteTask && (!mayDelete || mayDelete(task)) ? onDeleteTask : undefined} />)}
            </ul>
        </section>
    );
}

export default function TaskBoard({ tasks, canEdit, people, onOpen, onMove, onDelete, mayDelete }: TaskBoardProps) {
    const [active, setActive] = useState<ProjectTask | null>(null);
    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
        useSensor(KeyboardSensor),
    );
    const columns = useMemo(() => TASK_STATUSES.map(status => ({
        status, tasks: tasks.filter(t => t.status === status).sort((a, b) => a.sortOrder - b.sortOrder),
    })), [tasks]);

    const onDragStart = (e: DragStartEvent) => setActive(tasks.find(t => t.id === e.active.id) || null);
    const onDragEnd = (e: DragEndEvent) => {
        setActive(null);
        const task = tasks.find(t => t.id === e.active.id);
        const over = e.over ? String(e.over.id) : '';
        if (!task || !over) return;
        if (over.startsWith(COLUMN_PREFIX)) {
            const status = over.slice(COLUMN_PREFIX.length) as TaskStatus;
            // Dropped on its own column, out of any card: nothing to change.
            if (status !== task.status) onMove(task, status, null);
            return;
        }
        const target = tasks.find(t => t.id === over.slice(CARD_PREFIX.length));
        if (target && target.id !== task.id) onMove(task, target.status, target.id);
    };

    return (
        <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setActive(null)}>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-start" data-testid="project-task-board">
                {columns.map(c => (
                    <Column key={c.status} status={c.status} tasks={c.tasks} canEdit={canEdit} people={people}
                        onOpenTask={onOpen} onMoveTask={(task, status) => onMove(task, status, null)} onDeleteTask={onDelete} mayDelete={mayDelete} />
                ))}
            </div>
            <DragOverlay>
                {active && <div className="rounded-xl border border-[var(--accent-primary)] bg-[var(--bg-card)] p-2.5 text-[13px] font-medium shadow-lg text-[var(--text-primary)]">{active.title}</div>}
            </DragOverlay>
        </DndContext>
    );
}
