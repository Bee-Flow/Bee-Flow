// A small trash button for a task, shown only to people who may delete it
// (the person who made the task, or the project owner: the server's rule).

import { Trash2 } from 'lucide-react';
import React from 'react';
import type { ProjectTask } from '../../../../api/queries/projectTasks';
import { useTranslation } from '../../../../hooks/useTranslation';

/** The server lets the author of a task and the project owner delete it; everyone else asks one of them. */
export function mayDeleteTask(task: ProjectTask, currentUserId: string | null, isOwner: boolean, canEdit: boolean): boolean {
    return canEdit && (isOwner || (!!currentUserId && task.createdBy === currentUserId));
}

export default function DeleteTaskButton({ task, onDelete, className = '' }: { task: ProjectTask; onDelete: (task: ProjectTask) => void; className?: string }) {
    const { t } = useTranslation();
    const label = t('project_tasks.delete_task', 'Delete task {name}', { name: task.title || t('project_tasks.untitled', 'Untitled task') });
    return (
        <button type="button" aria-label={label} title={t('project_tasks.delete', 'Delete')} data-testid={`delete-task-${task.id}`}
            onClick={(e) => { e.stopPropagation(); onDelete(task); }}
            onPointerDown={e => e.stopPropagation()}
            className={`grid place-items-center w-7 h-7 rounded-md text-[var(--text-tertiary)] hover:text-[var(--error-ink)] hover:bg-[var(--item-hover-bg)] transition-colors ${className}`.trim()}>
            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
    );
}
