// The board: one lane per column, cards you drag between and within them.
// Dropping on a card puts the task right before it; dropping on a lane puts
// it at the end. Every card also has a "Move to" menu, and the grip takes the
// keyboard, so the board works without a pointer.

import {
    closestCorners, DndContext, DragOverlay, KeyboardSensor, MouseSensor, pointerWithin, TouchSensor, useSensor, useSensors,
    type CollisionDetection, type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core';
import React, { useMemo, useState } from 'react';
import { DEFAULT_COLUMNS, taskColumn, type BoardColumn } from '../../../../api/queries/projectBoard';
import { type ProjectTask, type TaskStatus } from '../../../../api/queries/projectTasks';
import type { useChatPeople } from '../chat/chatPeople';
import { DragCard } from './BoardCard';
import Lane from './BoardColumn';
import type { BoardFocus } from './BoardSettings';

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
    /** Opens the column settings, optionally at one column's name or WIP limit (the lane's "…" menu). */
    onConfigure?: (focus?: BoardFocus) => void;
}

const COLUMN_PREFIX = 'column:';
const CARD_PREFIX = 'card:';

/** With a pointer, the column or card under it; with the keyboard (no pointer), the nearest other card or column. */
const boardCollisions: CollisionDetection = (args) => {
    if (args.pointerCoordinates) {
        const hits = pointerWithin({ ...args, droppableContainers: args.droppableContainers.filter(c => c.id !== `${CARD_PREFIX}${args.active.id}`) });
        const cards = hits.filter(hit => String(hit.id).startsWith(CARD_PREFIX));
        return cards.length ? cards : hits;
    }
    return closestCorners({ ...args, droppableContainers: args.droppableContainers.filter(c => c.id !== `${CARD_PREFIX}${args.active.id}`) });
};

export default function TaskBoard({ tasks, canEdit, people, onOpen, onMove, onDelete, mayDelete, onConfigure, columns: configured, assignments = {}, onCreate, busy, allTasks = tasks }: TaskBoardProps) {
    const [active, setActive] = useState<ProjectTask | null>(null);
    const sensors = useSensors(
        useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
        // A touch that moves at once is a scroll; a short hold picks the card up.
        useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
        useSensor(KeyboardSensor),
    );
    const definitions = configured || DEFAULT_COLUMNS;
    const columns = useMemo(() => definitions.map(column => ({
        column,
        total: allTasks.filter(t => taskColumn(t, definitions, assignments)?.id === column.id).length,
        tasks: tasks.filter(t => taskColumn(t, definitions, assignments)?.id === column.id).sort((a, b) => a.sortOrder - b.sortOrder),
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
        if (!canEdit || busy || !task || !over) return;
        if (over.startsWith(COLUMN_PREFIX)) {
            // Column drops append, also when reordering within the same column.
            move(task, over.slice(COLUMN_PREFIX.length), null);
            return;
        }
        const target = tasks.find(t => t.id === over.slice(CARD_PREFIX.length));
        if (target && target.id !== task.id) move(task, taskColumn(target, definitions, assignments)?.id || target.status, target.id);
    };

    return (
        <DndContext sensors={sensors} collisionDetection={boardCollisions} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setActive(null)}>
            {/* Lanes keep their own height (items-start), so a short column does not stretch into an empty box. */}
            <div className="flex gap-3 items-start overflow-x-auto pb-2 custom-scrollbar" data-testid="project-task-board">
                {columns.map(c => (
                    <Lane key={c.column.id} column={c.column} total={c.total} columns={definitions} onCreate={onCreate} tasks={c.tasks}
                        canEdit={canEdit && !busy} people={people} dragging={!!active} onConfigure={onConfigure}
                        onOpenTask={onOpen} onMoveTask={(task, columnId) => move(task, columnId, null)} onDeleteTask={onDelete} mayDelete={mayDelete} />
                ))}
            </div>
            <DragOverlay>{active && <DragCard task={active} />}</DragOverlay>
        </DndContext>
    );
}
