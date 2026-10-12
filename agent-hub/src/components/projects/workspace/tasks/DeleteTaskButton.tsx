// Delete for a task, shown only to people who may delete it (the person who
// made the task, or the project owner: the server's rule). A small trash icon
// on a row, or the danger item at the end of a card's "…" menu.

import { Trash2 } from 'lucide-react';
import React from 'react';
import type { ProjectTask } from '../../../../api/queries/projectTasks';
import { useTranslation } from '../../../../hooks/useTranslation';
import { MenuItem } from './tasksMenu';

/** The server lets the author of a task and the project owner delete it; everyone else asks one of them. */
export function mayDeleteTask(task: ProjectTask, currentUserId: string | null, isOwner: boolean, canEdit: boolean): boolean {
    return canEdit && (isOwner || (!!currentUserId && task.createdBy === currentUserId));
}

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

export default function DeleteTaskButton({ task, onDelete, className = '', variant = 'icon' }: {
    task: ProjectTask; onDelete: (task: ProjectTask) => void; className?: string;
    /** 'menuitem' renders the danger row of a menu (the board card), 'icon' the trash button of a row. */
    variant?: 'icon' | 'menuitem';
}) {
    const { t } = useTranslation();
    const label = t('project_tasks.delete_task', 'Delete task {name}', { name: task.title || t('project_tasks.untitled', 'Untitled task') });
    const onClick = (e: React.MouseEvent) => { e.stopPropagation(); onDelete(task); };
    if (variant === 'menuitem') {
        return (
            <MenuItem danger aria-label={label} data-testid={`delete-task-${task.id}`} className={className}
                icon={<Trash2 className="w-3.5 h-3.5 text-[var(--error-ink)]" />}
                onClick={onClick} onPointerDown={stop} onMouseDown={stop} onTouchStart={stop}>
                {t('project_tasks.delete', 'Delete')}
            </MenuItem>
        );
    }
    return (
        <button type="button" aria-label={label} title={t('project_tasks.delete', 'Delete')} data-testid={`delete-task-${task.id}`}
            onClick={onClick} onPointerDown={stop} onMouseDown={stop} onTouchStart={stop}
            className={`grid place-items-center w-7 h-7 rounded-md text-[var(--text-tertiary)] hover:text-[var(--error-ink)] hover:bg-[var(--item-hover-bg)] transition-colors ${className}`.trim()}>
            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
    );
}
