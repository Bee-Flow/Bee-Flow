// One board column: a quiet lane whose height follows its cards. The header
// carries the status dot, the name and one count (the WIP limit folds into it
// as "3/4", a warning chip once it is exceeded); a hover "+" and a "…" menu sit
// on the right. Quick add lives at the foot of the lane.

import { useDroppable } from '@dnd-kit/core';
import { Gauge, MoreHorizontal, PencilLine, Plus, Settings2 } from 'lucide-react';
import React, { useRef, useState } from 'react';
import type { BoardColumn as BoardColumnDef } from '../../../../api/queries/projectBoard';
import type { ProjectTask } from '../../../../api/queries/projectTasks';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { useChatPeople } from '../chat/chatPeople';
import { GhostButton, PrimaryButton } from '../workspaceUi';
import BoardCard, { ColumnDot } from './BoardCard';
import type { BoardFocus } from './BoardSettings';
import { AnchoredMenu, ICON_BUTTON_CLASS, MENU_PANEL_CLASS, MenuItem, MenuSeparator } from './tasksMenu';
import { statusLabel } from './taskText';

const COLUMN_PREFIX = 'column:';
// Header actions show while the lane is hovered or holds focus, and always on touch screens.
const LANE_REVEAL = 'opacity-0 group-hover/lane:opacity-100 group-focus-within/lane:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity';

/** A ghost "+ Add task" row that opens into a card-shaped draft: Enter adds, Shift+Enter breaks the line, Esc cancels. */
function QuickAdd({ columnId, open, onOpenChange, onCreate }: {
    columnId: string; open: boolean; onOpenChange: (open: boolean) => void; onCreate: (id: string, title: string) => Promise<void>;
}) {
    const { t } = useTranslation();
    const [title, setTitle] = useState('');
    const [busy, setBusy] = useState(false);
    const submit = async () => {
        if (!title.trim() || busy) return;
        setBusy(true);
        try { await onCreate(columnId, title.trim()); setTitle(''); } catch { /* the parent shows the error; the draft stays */ }
        finally { setBusy(false); }
    };
    if (!open) {
        return (
            <button type="button" onClick={() => onOpenChange(true)}
                className="w-full flex items-center gap-1.5 h-8 px-2 rounded-lg text-[12.5px] text-[var(--text-tertiary)] hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)] transition-colors">
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />{t('project_tasks.add_task', 'Add task')}
            </button>
        );
    }
    return (
        <form onSubmit={e => { e.preventDefault(); void submit(); }} className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] p-2 space-y-2">
            <textarea autoFocus rows={2} value={title} maxLength={200} onChange={e => setTitle(e.target.value)}
                onKeyDown={e => {
                    if (e.key === 'Escape') { e.preventDefault(); onOpenChange(false); }
                    else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
                }}
                className="block w-full resize-none bg-transparent p-0.5 text-[13px] leading-snug outline-none text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
                placeholder={t('project_tasks.task_title', 'What needs doing?')} aria-label={t('project_tasks.title_label', 'Title')} />
            <div className="flex items-center gap-1.5">
                <PrimaryButton type="submit" busy={busy} disabled={!title.trim()} className="!h-7">{t('project_tasks.add_task', 'Add task')}</PrimaryButton>
                <GhostButton onClick={() => onOpenChange(false)}>{t('project_content.cancel', 'Cancel')}</GhostButton>
            </div>
        </form>
    );
}

/** Rename, WIP limit and the board settings, each opening the column settings at the right field. */
function ColumnMenu({ column, title, onConfigure }: { column: BoardColumnDef; title: string; onConfigure: (focus?: BoardFocus) => void }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const anchor = useRef<HTMLButtonElement>(null);
    const pick = (focus?: BoardFocus) => { setOpen(false); onConfigure(focus); };
    const label = t('project_tasks.column_actions', 'Column actions: {column}', { column: title });
    return (
        <>
            <button ref={anchor} type="button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open}
                onClick={() => setOpen(v => !v)} className={`${ICON_BUTTON_CLASS} !w-6 !h-6 ${LANE_REVEAL}`}>
                <MoreHorizontal className="w-4 h-4" aria-hidden="true" />
            </button>
            <AnchoredMenu open={open} onClose={() => setOpen(false)} anchorRef={anchor} align="right" width={208} role="menu" aria-label={label} className={MENU_PANEL_CLASS}>
                <MenuItem icon={<PencilLine className="w-3.5 h-3.5" />} onClick={() => pick({ columnId: column.id, field: 'title' })}>{t('project_tasks.rename_column', 'Rename column')}</MenuItem>
                <MenuItem icon={<Gauge className="w-3.5 h-3.5" />} onClick={() => pick({ columnId: column.id, field: 'wip' })}>{t('project_tasks.set_wip_limit', 'Set WIP limit')}</MenuItem>
                <MenuSeparator />
                <MenuItem icon={<Settings2 className="w-3.5 h-3.5" />} onClick={() => pick()}>{t('project_tasks.configure_board', 'Configure board')}</MenuItem>
            </AnchoredMenu>
        </>
    );
}

/** One count: what is shown, or "total/limit" with a WIP limit; a warning chip above the limit. */
function ColumnCount({ shown, total, limit }: { shown: number; total: number; limit: number | null | undefined }) {
    const { t } = useTranslation();
    const over = !!limit && total > limit;
    const hints = [
        shown !== total ? t('project_tasks.shown_of_total', '{shown} of {total} shown', { shown, total }) : null,
        limit ? (over ? t('project_tasks.wip_exceeded', 'Above the work in progress limit') : t('project_tasks.wip_limit_count', 'Work in progress limit: {limit}', { limit })) : null,
    ].filter(Boolean).join(' · ');
    const text = limit ? `${total}/${limit}` : String(shown);
    return (
        <>
            <span title={hints || undefined}
                className={over
                    ? 'inline-flex items-center h-5 px-1.5 rounded-md text-[11px] font-medium leading-none tabular-nums bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning-ink)]'
                    : 'text-[11.5px] font-normal text-[var(--text-tertiary)] tabular-nums'}>
                {text}
            </span>
            {/* A title is not read out reliably: the filtered total and the limit also go to screen readers. */}
            {over
                ? <span role="status" className="sr-only">{t('project_tasks.wip_exceeded', 'Above the work in progress limit')}</span>
                : hints && <span className="sr-only">({hints})</span>}
        </>
    );
}

export interface BoardColumnProps {
    column: BoardColumnDef;
    tasks: ProjectTask[];
    total: number;
    columns: BoardColumnDef[];
    canEdit: boolean;
    people: ReturnType<typeof useChatPeople>;
    /** A card is being dragged: empty lanes show where it can land. */
    dragging: boolean;
    onCreate?: (id: string, title: string) => Promise<void>;
    onConfigure?: (focus?: BoardFocus) => void;
    onOpenTask: (task: ProjectTask) => void;
    onMoveTask: (task: ProjectTask, columnId: string) => void;
    onDeleteTask?: (task: ProjectTask) => void;
    mayDelete?: (task: ProjectTask) => boolean;
}

export default function BoardColumn({ column, tasks, total, columns, canEdit, people, dragging, onCreate, onConfigure, onOpenTask, onMoveTask, onDeleteTask, mayDelete }: BoardColumnProps) {
    const { t } = useTranslation();
    const { setNodeRef, isOver } = useDroppable({ id: `${COLUMN_PREFIX}${column.id}` });
    const [adding, setAdding] = useState(false);
    const title = column.title || statusLabel(t, column.status);
    const canAdd = canEdit && !!onCreate;
    return (
        <section ref={setNodeRef} aria-label={title} data-testid={`board-column-${column.id}`} data-status={column.status}
            className={`group/lane flex flex-col w-[280px] shrink-0 min-h-40 rounded-xl p-2 gap-2 transition-colors ${isOver ? 'bg-[var(--item-hover-bg)] ring-1 ring-[var(--accent-primary)]' : 'bg-[var(--bg-secondary)]'}`}>
            <header className="flex items-center gap-2 h-8 pl-1.5 pr-0.5">
                <h3 className="m-0 flex items-center gap-2 flex-1 min-w-0 text-[13px] font-semibold text-[var(--text-primary)]">
                    <ColumnDot status={column.status} />
                    <span className="truncate" title={title}>{title}</span>
                    <ColumnCount shown={tasks.length} total={total} limit={column.wipLimit} />
                </h3>
                {canAdd && (
                    <button type="button" onClick={() => setAdding(true)} className={`${ICON_BUTTON_CLASS} !w-6 !h-6 ${LANE_REVEAL}`}
                        aria-label={t('project_tasks.add_task_to', 'Add task to {column}', { column: title })} title={t('project_tasks.add_task', 'Add task')}>
                        <Plus className="w-4 h-4" aria-hidden="true" />
                    </button>
                )}
                {canEdit && onConfigure && <ColumnMenu column={column} title={title} onConfigure={onConfigure} />}
            </header>
            <ul className="list-none m-0 p-0 flex flex-col gap-2">
                {tasks.map(task => (
                    <BoardCard key={task.id} task={task} canEdit={canEdit} people={people} columns={columns} columnId={column.id}
                        onOpen={() => onOpenTask(task)} onMove={id => onMoveTask(task, id)}
                        onDelete={onDeleteTask && (!mayDelete || mayDelete(task)) ? onDeleteTask : undefined} />
                ))}
                {!tasks.length && (dragging
                    ? <li aria-hidden="true" className="h-16 rounded-lg border border-dashed border-[var(--border-default)]" />
                    : !adding && <li className="py-6 text-center text-[12.5px] text-[var(--text-tertiary)]">{t('project_tasks.empty_column', 'No tasks here yet')}</li>)}
            </ul>
            {canAdd && onCreate && <QuickAdd columnId={column.id} open={adding} onOpenChange={setAdding} onCreate={onCreate} />}
        </section>
    );
}
