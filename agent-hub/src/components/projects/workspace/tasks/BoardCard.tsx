// One card on the board: the title, a row of chips (type, labels, priority)
// and the shared meta line with the people on the right. The whole card drags
// with a pointer; the hover-revealed grip is the keyboard's way in, and the
// "…" menu moves, opens or deletes without dragging at all.

import { useDraggable, useDroppable } from '@dnd-kit/core';
import { ArrowUpRight, GripVertical, MoreHorizontal } from 'lucide-react';
import React, { useRef, useState } from 'react';
import type { BoardColumn } from '../../../../api/queries/projectBoard';
import type { ProjectTask } from '../../../../api/queries/projectTasks';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { useChatPeople } from '../chat/chatPeople';
import DeleteTaskButton from './DeleteTaskButton';
import { LabelChip, PriorityIcon, TypeChip } from './TaskFields';
import { Assignees, TaskMeta } from './TaskRow';
import { AnchoredMenu, ICON_BUTTON_CLASS, MENU_PANEL_CLASS, MenuItem, MenuLabel, MenuSeparator } from './tasksMenu';
import { checklistProgress, priorityTone, statusLabel } from './taskText';
import { storyPoints, visibleLabels, workItemType } from './taskPlanning';
import ItemViewers from '../ItemViewers';

type People = ReturnType<typeof useChatPeople>;

// Named group: a lane or a page wrapper that is itself a `group` must not reveal every card's actions.
const CARD_REVEAL = 'opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100 has-[[aria-expanded=true]]:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity';

/** The status dot of a column: success for done, quiet otherwise. */
export function ColumnDot({ status }: { status: BoardColumn['status'] }) {
    return <span aria-hidden="true" className={`w-2 h-2 shrink-0 rounded-full ${status === 'done' ? 'bg-[var(--success)]' : status === 'doing' ? 'bg-[var(--info-ink)]' : 'bg-[var(--text-tertiary)]'}`} />;
}

/** "Move to" with one item per column, then Open and Delete. */
function CardMenu({ task, columns, columnId, onMove, onOpen, onDelete }: {
    task: ProjectTask; columns: BoardColumn[]; columnId: string; onMove: (columnId: string) => void; onOpen: () => void; onDelete?: (task: ProjectTask) => void;
}) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const anchor = useRef<HTMLButtonElement>(null);
    const close = () => setOpen(false);
    const label = t('project_tasks.card_actions', 'Task actions');
    return (
        <>
            <button ref={anchor} type="button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open}
                onClick={() => setOpen(v => !v)} className={`${ICON_BUTTON_CLASS} !w-6 !h-6`}>
                <MoreHorizontal className="w-4 h-4" aria-hidden="true" />
            </button>
            <AnchoredMenu open={open} onClose={close} anchorRef={anchor} align="right" width={224} role="menu" aria-label={label} className={MENU_PANEL_CLASS}>
                <div role="group" aria-label={t('project_tasks.move_to', 'Move to')}>
                    <MenuLabel>{t('project_tasks.move_to', 'Move to')}</MenuLabel>
                    {columns.map(column => {
                        const current = column.id === columnId;
                        return (
                            <MenuItem key={column.id} selected={current} icon={<ColumnDot status={column.status} />}
                                onClick={() => { close(); if (!current) onMove(column.id); }}>
                                {column.title || statusLabel(t, column.status)}
                            </MenuItem>
                        );
                    })}
                </div>
                <MenuSeparator />
                <MenuItem icon={<ArrowUpRight className="w-3.5 h-3.5" />} onClick={() => { close(); onOpen(); }}>{t('project_tasks.open_task', 'Open')}</MenuItem>
                {onDelete && <DeleteTaskButton task={task} variant="menuitem" onDelete={(task) => { close(); onDelete(task); }} />}
            </AnchoredMenu>
        </>
    );
}

/** Type, the first two labels (then "+n") and the priority glyph; nothing at all for a plain, unlabelled task. */
function CardChips({ task }: { task: ProjectTask }) {
    const labels = visibleLabels(task.labels);
    const type = workItemType(task);
    if (type === 'task' && !labels.length && !priorityTone(task.priority)) return null;
    return (
        <div className="flex flex-wrap items-center gap-1">
            <TypeChip type={type} />
            {labels.slice(0, 2).map(l => <LabelChip key={l} label={l} />)}
            {labels.length > 2 && <span className="text-[11px] text-[var(--text-tertiary)] tabular-nums">+{labels.length - 2}</span>}
            <PriorityIcon priority={task.priority} />
        </div>
    );
}

// Presses on these never start a pointer drag: they are controls of their own.
const NO_DRAG = 'details, select, input, textarea, a, button:not([data-card-title]), [data-drag-handle], [role="menu"]';

export default function BoardCard({ task, canEdit, people, columns, columnId, onOpen, onMove, onDelete }: {
    task: ProjectTask; canEdit: boolean; people: People; columns: BoardColumn[]; columnId: string;
    onOpen: () => void; onMove: (columnId: string) => void; onDelete?: (task: ProjectTask) => void;
}) {
    const { t } = useTranslation();
    const drag = useDraggable({ id: task.id, disabled: !canEdit });
    const drop = useDroppable({ id: `card:${task.id}` });
    const done = task.status === 'done';
    const facts = !!(task.dueDate || checklistProgress(task.checklist) || task.links.length || storyPoints(task) || task.assigneeIds.length);
    const startDrag = (e: React.MouseEvent | React.TouchEvent, kind: 'onMouseDown' | 'onTouchStart') => {
        if (!(e.target as HTMLElement).closest(NO_DRAG)) (drag.listeners?.[kind] as ((ev: typeof e) => void) | undefined)?.(e);
    };
    return (
        <li ref={drop.setNodeRef} className="relative">
            {/* Dropping on a card puts the task before it: the accent line shows where. */}
            {drop.isOver && <span aria-hidden="true" className="absolute -top-[5px] inset-x-1 h-0.5 rounded-full bg-[var(--accent-primary)]" />}
            <div ref={drag.setNodeRef} onMouseDown={e => startDrag(e, 'onMouseDown')} onTouchStart={e => startDrag(e, 'onTouchStart')}
                data-testid={`board-task-${task.id}`}
                className={`group/card relative rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] p-2.5 space-y-2 hover:border-[var(--border-default)] transition-colors ${canEdit ? 'cursor-grab active:cursor-grabbing' : ''} ${drag.isDragging ? 'opacity-40' : ''}`}>
                {/* The title is the open button, so opening, dragging and the menu stay separate keyboard stops. */}
                <button type="button" data-card-title onClick={onOpen}
                    className={`block w-full text-left bg-transparent p-0 border-0 cursor-[inherit] rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-primary)] ${canEdit ? '[@media(hover:none)]:pr-14' : ''}`}>
                    <span className={`line-clamp-3 break-words text-[13px] leading-snug font-medium ${done ? 'line-through text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]'}`}>
                        {task.title || t('project_tasks.untitled', 'Untitled task')}
                    </span>
                </button>
                <CardChips task={task} />
                <ItemViewers type="task" id={task.id} />
                {facts ? (
                    <div className="flex items-center gap-2.5 min-h-5 text-[11.5px] text-[var(--text-tertiary)] tabular-nums">
                        <TaskMeta task={task} showPriority={false} />
                        <span className="ml-auto inline-flex"><Assignees ids={task.assigneeIds} people={people} max={2} /></span>
                    </div>
                ) : <span className="sr-only" data-testid="task-unassigned">{t('project_tasks.not_assigned', 'Not assigned')}</span>}
                {canEdit && (
                    <div className={`absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-md bg-[var(--bg-card)] ${CARD_REVEAL}`}>
                        <button type="button" data-drag-handle ref={drag.setActivatorNodeRef} {...drag.attributes} {...drag.listeners}
                            aria-label={t('project_tasks.drag_task', 'Drag task: {title}', { title: task.title })} title={t('project_tasks.drag_task', 'Drag task: {title}', { title: task.title })}
                            className={`${ICON_BUTTON_CLASS} !w-6 !h-6 cursor-grab active:cursor-grabbing touch-none`}>
                            <GripVertical className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                        <CardMenu task={task} columns={columns} columnId={columnId} onMove={onMove} onOpen={onOpen} onDelete={onDelete} />
                    </div>
                )}
            </div>
        </li>
    );
}

/** The card as it follows the pointer while dragging. */
export function DragCard({ task }: { task: ProjectTask }) {
    const { t } = useTranslation();
    return (
        <div className="w-[264px] rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] p-2.5 shadow-lg ring-1 ring-[var(--accent-primary)] rotate-[1deg] cursor-grabbing">
            <span className="line-clamp-3 break-words text-[13px] leading-snug font-medium text-[var(--text-primary)]">{task.title || t('project_tasks.untitled', 'Untitled task')}</span>
        </div>
    );
}
