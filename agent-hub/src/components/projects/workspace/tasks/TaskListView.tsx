// The list view of the Tasks tab: one group per status, each a label with a
// count and a collapse chevron, its rows in ONE card divided by lines. Done
// folds away by default once it has more than a handful of tasks; whatever
// the reader opens or closes is remembered per project.

import { ChevronRight, Plus } from 'lucide-react';
import React, { useState } from 'react';
import { TASK_STATUSES, type ProjectTask, type TaskStatus } from '../../../../api/queries/projectTasks';
import { useTranslation } from '../../../../hooks/useTranslation';
import scopedStorage from '../../../../utils/scopedStorage';
import type { useChatPeople } from '../chat/chatPeople';
import { sortTasks, type TaskSort } from './taskFilters';
import TaskRow from './TaskRow';
import { statusLabel } from './taskText';

/** Done starts folded once it holds more than this many tasks. */
const DONE_FOLD_FROM = 6;
const ROW_CARD_CLASS = 'rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] divide-y divide-[var(--border-subtle)] overflow-hidden';

type Folded = Partial<Record<TaskStatus, boolean>>;

function useFolded(projectId: string): [Folded, (status: TaskStatus, folded: boolean) => void] {
    const key = `projectTaskGroups:${projectId}`;
    const [folded, setFolded] = useState<Folded>(() => {
        try { const saved = JSON.parse(scopedStorage.getItem(key) || 'null'); return saved && typeof saved === 'object' ? saved : {}; } catch { return {}; }
    });
    const set = (status: TaskStatus, value: boolean) => setFolded(prev => {
        const next = { ...prev, [status]: value };
        try { scopedStorage.setItem(key, JSON.stringify(next)); } catch { /* the choice just does not outlive the page */ }
        return next;
    });
    return [folded, set];
}

/** Pulsing placeholder rows while the tasks load, in the same card the list uses. */
export function TasksSkeleton() {
    const { t } = useTranslation();
    return (
        <div className={ROW_CARD_CLASS} role="status" aria-label={t('project_tasks.loading', 'Loading tasks…')} data-testid="tasks-skeleton">
            {['w-2/3', 'w-1/2', 'w-3/4', 'w-2/5', 'w-3/5'].map((width, i) => (
                <div key={i} className="flex items-center gap-3 px-3 h-10">
                    <span className="h-4 w-4 flex-none animate-pulse rounded-full bg-[var(--bg-secondary)]" aria-hidden="true" />
                    <span className={`h-3 animate-pulse rounded-full bg-[var(--bg-secondary)] ${width}`} aria-hidden="true" />
                    <span className="ml-auto h-3 w-16 flex-none animate-pulse rounded-full bg-[var(--bg-secondary)]" aria-hidden="true" />
                </div>
            ))}
        </div>
    );
}

export default function TaskList({ projectId, tasks, sort, canEdit, people, onOpen, onStatus, onDelete, mayDelete, onAdd }: {
    projectId: string; tasks: ProjectTask[]; sort: TaskSort; canEdit: boolean; people: ReturnType<typeof useChatPeople>;
    onOpen: (t: ProjectTask) => void; onStatus: (t: ProjectTask, s: TaskStatus) => void;
    onDelete: (t: ProjectTask) => void; mayDelete: (t: ProjectTask) => boolean;
    /** Present for editors: the quiet "Add task" row at the end of To do. */
    onAdd?: () => void;
}) {
    const { t } = useTranslation();
    const [folded, setFolded] = useFolded(projectId);
    return (
        <div className="space-y-4">
            {TASK_STATUSES.map((status) => {
                const list = sortTasks(tasks.filter(x => x.status === status), status === 'done' ? 'newest' : sort);
                const addRow = status === 'todo' && onAdd;
                if (!list.length && !addRow) return null;
                const isFolded = folded[status] ?? (status === 'done' && list.length >= DONE_FOLD_FROM);
                const bodyId = `task-group-${status}`;
                return (
                    <section key={status} aria-label={statusLabel(t, status)} className="space-y-2" data-status={status}>
                        <h3 className="m-0">
                            <button type="button" onClick={() => setFolded(status, !isFolded)} aria-expanded={!isFolded} aria-controls={bodyId}
                                className="inline-flex items-center gap-1 -ml-1 px-1 h-6 rounded-md text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)]">
                                <ChevronRight className={`w-3 h-3 transition-transform duration-150 ${isFolded ? '' : 'rotate-90'}`} aria-hidden="true" />
                                {statusLabel(t, status)}
                                <span className="ml-1.5 font-normal tabular-nums">{list.length}</span>
                            </button>
                        </h3>
                        {!isFolded && (
                            <ul id={bodyId} className={`${ROW_CARD_CLASS} list-none m-0 p-0`}>
                                {list.map(task => <TaskRow key={task.id} task={task} canEdit={canEdit} people={people} onOpen={() => onOpen(task)} onStatus={s => onStatus(task, s)} onDelete={mayDelete(task) ? onDelete : undefined} />)}
                                {addRow && (
                                    <li>
                                        <button type="button" onClick={onAdd} data-testid="task-list-add"
                                            className="w-full flex items-center gap-3 px-3 h-9 text-left text-[13px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)]">
                                            <Plus className="w-4 h-4 flex-none" aria-hidden="true" />{t('project_tasks.add_task', 'Add task')}
                                        </button>
                                    </li>
                                )}
                            </ul>
                        )}
                    </section>
                );
            })}
        </div>
    );
}
