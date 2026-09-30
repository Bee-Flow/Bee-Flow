// The board: one column per status, cards you drag between and within them.
// Dropping on a card puts the task right before it; dropping on a column puts
// it at the end. Every card also has a "Move to" list, so the board works
// without a pointer.

import {
    closestCorners, DndContext, DragOverlay, KeyboardSensor, MouseSensor, pointerWithin, TouchSensor, useDraggable, useDroppable, useSensor, useSensors,
    type CollisionDetection, type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core';
import React, { useMemo, useState } from 'react';
import { GripVertical, MoreHorizontal, Plus } from 'lucide-react';
import { DEFAULT_COLUMNS, taskColumn, type BoardColumn } from '../../../../api/queries/projectBoard';
import { type ProjectTask, type TaskStatus } from '../../../../api/queries/projectTasks';
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
    onMove: (task: ProjectTask, status: TaskStatus, beforeId: string | null, columnId?: string) => void;
    columns?: BoardColumn[];
    allTasks?: ProjectTask[];
    assignments?: Record<string, string>;
    onCreate?: (columnId: string, title: string) => Promise<void>;
    busy?: boolean;
    /** Given for the tasks the reader may delete. */
    onDelete?: (task: ProjectTask) => void;
    mayDelete?: (task: ProjectTask) => boolean;
}

const COLUMN_PREFIX = 'column:';
const CARD_PREFIX = 'card:';

/** With a pointer, the column or card under it; with the keyboard (no pointer), the nearest other card or column. */
export const boardCollisions: CollisionDetection = (args) => {
    if (args.pointerCoordinates) {
        const hits = pointerWithin(args);
        const cards = hits.filter(hit => String(hit.id).startsWith(CARD_PREFIX));
        return cards.length ? cards : hits;
    }
    return closestCorners({ ...args, droppableContainers: args.droppableContainers.filter(c => c.id !== `${CARD_PREFIX}${args.active.id}`) });
};

function Card({ task, canEdit, people, dragging, onOpen, onMove, onDelete, columns, columnId }: {
    task: ProjectTask; canEdit: boolean; people: People; columns: BoardColumn[]; columnId: string; dragging?: boolean; onOpen: () => void; onMove: (columnId: string) => void;
    onDelete?: (task: ProjectTask) => void;
}) {
    const { t } = useTranslation();
    const drag = useDraggable({ id: task.id, disabled: !canEdit });
    const drop = useDroppable({ id: `${CARD_PREFIX}${task.id}` });
    const done = task.status === 'done';
    return (
        <li ref={drop.setNodeRef}>
            {/* The drag handle keeps opening, moving and editing separate keyboard actions. */}
            <div ref={drag.setNodeRef}
                data-testid={`board-task-${task.id}`} style={assigneeEdge(task, people)}
                className={`group/card relative rounded-xl border bg-[var(--bg-card)] p-3.5 space-y-3 shadow-sm hover:shadow-md transition-colors ${drop.isOver ? 'border-[var(--accent-primary)]' : 'border-[var(--border-subtle)] hover:border-[var(--border-default)]'} ${drag.isDragging && !dragging ? 'opacity-40' : ''}`}>
                <button type="button" onClick={onOpen} className="block w-full pr-8 text-left bg-transparent p-0 border-0 cursor-pointer">
                    <span className={`flex items-start gap-2 text-[14px] leading-snug font-medium ${done ? 'line-through text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]'}`}>
                        <span className="flex-1 min-w-0 break-words">{task.title || t('project_tasks.untitled', 'Untitled task')}</span>
                        <PriorityMark priority={task.priority} />
                    </span>
                </button>
                {task.labels.length > 0 && <span className="flex flex-wrap gap-1">{task.labels.slice(0, 3).map(l => <LabelChip key={l} label={l} />)}{task.labels.length > 3 && <span className="text-[11px] text-[var(--text-tertiary)]">+{task.labels.length - 3}</span>}</span>}
                <div className="flex items-center gap-2.5 flex-wrap border-t border-[var(--border-subtle)] pt-2">{canEdit && <button type="button" ref={drag.setActivatorNodeRef} {...drag.attributes} {...drag.listeners} aria-label={t('project_tasks.drag_task', 'Drag task: {title}', { title: task.title })} className="p-1 -ml-1 cursor-grab active:cursor-grabbing touch-none rounded text-[var(--text-tertiary)] hover:bg-[var(--item-hover-bg)]"><GripVertical className="w-4 h-4" aria-hidden="true" /></button>}<TaskFacts task={task} people={people} max={2} /></div>
                {canEdit && (
                    <details className="absolute right-2 top-2" onPointerDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
                    <summary aria-label={t('project_tasks.card_actions', 'Task actions')} className="list-none cursor-pointer p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]"><MoreHorizontal className="w-4 h-4" /></summary><div className="relative z-10 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] shadow-lg p-2 min-w-40">
                    <select value={columnId} onChange={e => onMove(e.target.value)} onPointerDown={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()} onTouchStart={e => e.stopPropagation()}
                        aria-label={t('project_tasks.move_to', 'Move to')}
                        className={`${SELECT_CLASS} !h-7 w-full mt-1`}>
                        {columns.map(c => <option key={c.id} value={c.id}>{t('project_tasks.move_to_status', 'Move to: {status}', { status: c.title || statusLabel(t, c.status) })}</option>)}
                    </select>
                    {onDelete && <DeleteTaskButton task={task} onDelete={onDelete} />}
                    </div></details>
                )}
            </div>
        </li>
    );
}

function QuickAdd({ columnId, onCreate }: { columnId: string; onCreate: (id: string, title: string) => Promise<void> }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [title, setTitle] = useState('');
    const [busy, setBusy] = useState(false);
    const submit = async (e: React.FormEvent) => {
        e.preventDefault(); if (!title.trim() || busy) return;
        setBusy(true);
        try { await onCreate(columnId, title.trim()); setTitle(''); } catch { /* parent displays the error, keep the draft */ }
        finally { setBusy(false); }
    };
    return open ? <form onSubmit={submit} className="p-2 rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] space-y-2">
        <input autoFocus value={title} maxLength={200} onChange={e => setTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }} className="w-full bg-transparent p-2 text-sm outline-none text-[var(--text-primary)]" placeholder={t('project_tasks.task_title', 'What needs doing?')} aria-label={t('project_tasks.title_label', 'Title')} />
        <div className="flex gap-2"><button type="submit" disabled={!title.trim() || busy} className="text-xs font-semibold px-3 py-2 rounded-lg bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] disabled:opacity-50">{t('project_tasks.add_task', 'Add task')}</button><button type="button" onClick={() => setOpen(false)} className="text-xs p-2 text-[var(--text-secondary)]">{t('project_content.cancel', 'Cancel')}</button></div>
    </form> : <button type="button" onClick={() => setOpen(true)} className="w-full flex items-center gap-2 rounded-lg p-2.5 text-sm text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)]"><Plus className="w-4 h-4" />{t('project_tasks.add_task', 'Add task')}</button>;
}
function Column({ column, tasks, total, columns, onCreate, ...rest }: {
    column: BoardColumn; tasks: ProjectTask[]; total: number; columns: BoardColumn[]; onCreate?: (id: string, title: string) => Promise<void>;
} & Omit<React.ComponentProps<typeof Card>, 'task' | 'columnId' | 'onOpen' | 'onMove'> & {
    onOpenTask: (t: ProjectTask) => void; onMoveTask: (t: ProjectTask, columnId: string) => void;
    onDeleteTask?: (t: ProjectTask) => void; mayDelete?: (t: ProjectTask) => boolean;
}) {
    const { t } = useTranslation();
    const { setNodeRef, isOver } = useDroppable({ id: `${COLUMN_PREFIX}${column.id}` });
    const { onOpenTask, onMoveTask, onDeleteTask, mayDelete, ...card } = rest;
    const title = column.title || statusLabel(t, column.status);
    const overLimit = !!column.wipLimit && total > column.wipLimit;
    return <section ref={setNodeRef} aria-label={title} data-testid={`board-column-${column.id}`}
        className={`flex flex-col min-w-[280px] flex-1 rounded-2xl border p-3 gap-3 bg-[var(--bg-secondary)] min-h-[320px] ${isOver ? 'border-[var(--accent-primary)] ring-2 ring-[var(--item-active-bg)]' : 'border-[var(--border-subtle)]'}`}>
        <h3 className="m-0 flex items-center gap-2 px-1 text-sm font-semibold text-[var(--text-primary)]">
            <span className={`w-2 h-2 shrink-0 rounded-full ${column.status === 'done' ? 'bg-[var(--success)]' : column.status === 'doing' ? 'bg-[var(--accent-primary)]' : 'bg-[var(--text-tertiary)]'}`} />
            <span className="flex-1 break-words">{title}</span><span className={`rounded-md px-2 py-0.5 text-xs tabular-nums ${overLimit ? 'bg-[var(--warning-bg)] text-[var(--warning-ink)]' : 'bg-[var(--bg-card)] text-[var(--text-secondary)]'}`}>{tasks.length !== total ? `${tasks.length} / ${total}` : total}{column.wipLimit ? ` / ${column.wipLimit}` : ''}</span>
        </h3>
        {overLimit && <p role="status" className="m-0 px-1 text-xs text-[var(--warning-ink)]">{t('project_tasks.wip_exceeded', 'Above the work in progress limit')}</p>}
        <ul className="list-none m-0 p-0 space-y-2.5 flex-1 min-h-24">
            {tasks.map(task => <Card key={task.id} task={task} {...card} columns={columns} columnId={column.id} onOpen={() => onOpenTask(task)} onMove={id => onMoveTask(task,id)} onDelete={onDeleteTask && (!mayDelete || mayDelete(task)) ? onDeleteTask : undefined} />)}
            {!tasks.length && <li className="border border-dashed border-[var(--border-default)] rounded-xl px-4 py-8 text-center text-xs text-[var(--text-tertiary)]">{t('project_tasks.empty_column', 'No tasks here yet')}</li>}
        </ul>
        {card.canEdit && onCreate && <QuickAdd columnId={column.id} onCreate={onCreate} />}
    </section>;
}

export default function TaskBoard({ tasks, canEdit, people, onOpen, onMove, onDelete, mayDelete, columns: configured, assignments = {}, onCreate, busy, allTasks = tasks }: TaskBoardProps) {
    const [active, setActive] = useState<ProjectTask | null>(null);
    const sensors = useSensors(
        useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
        // A touch that moves at once is a scroll; a short hold picks the card up.
        useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
        useSensor(KeyboardSensor),
    );
    const definitions = configured || DEFAULT_COLUMNS;
    const columns = useMemo(() => definitions.map(column => ({
        column, total: allTasks.filter(t => taskColumn(t, definitions, assignments)?.id === column.id).length, tasks: tasks.filter(t => taskColumn(t, definitions, assignments)?.id === column.id).sort((a,b) => a.sortOrder - b.sortOrder),
    })), [tasks, allTasks, definitions, assignments]);
    const move = (task: ProjectTask, columnId: string, beforeId: string | null) => {
        const column = definitions.find(c => c.id === columnId);
        if (!column || busy) return;
        if (configured) onMove(task, column.status, beforeId, column.id);
        else onMove(task, column.status, beforeId);
    };

    const onDragStart = (e: DragStartEvent) => setActive(tasks.find(t => t.id === e.active.id) || null);
    const onDragEnd = (e: DragEndEvent) => {
        setActive(null);
        const task = tasks.find(t => t.id === e.active.id);
        const over = e.over ? String(e.over.id) : '';
        if (!task || !over) return;
        if (over.startsWith(COLUMN_PREFIX)) {
            const status = over.slice(COLUMN_PREFIX.length) as TaskStatus;
            // Column drops append, also when reordering within the same column.
            move(task, status, null);
            return;
        }
        const target = tasks.find(t => t.id === over.slice(CARD_PREFIX.length));
        if (target && target.id !== task.id) move(task, taskColumn(target, definitions, assignments)?.id || target.status, target.id);
    };

    return (
        <DndContext sensors={sensors} collisionDetection={boardCollisions} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setActive(null)}>
            <div className="flex gap-4 items-stretch overflow-x-auto pb-4 min-h-[55vh] custom-scrollbar" data-testid="project-task-board">
                {columns.map(c => (
                    <Column key={c.column.id} column={c.column} total={c.total} columns={definitions} onCreate={onCreate} tasks={c.tasks} canEdit={canEdit && !busy} people={people}
                        onOpenTask={onOpen} onMoveTask={(task, columnId) => move(task, columnId, null)} onDeleteTask={onDelete} mayDelete={mayDelete} />
                ))}
            </div>
            <DragOverlay>
                {active && <div className="rounded-xl border border-[var(--accent-primary)] bg-[var(--bg-card)] p-2.5 text-[14px] leading-snug font-medium shadow-lg text-[var(--text-primary)]">{active.title}</div>}
            </DragOverlay>
        </DndContext>
    );
}
