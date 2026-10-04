// The board's columns, edited in a dialog: one divided row per column (order,
// name, status, WIP limit, remove), add on the left of the footer, Cancel and
// Save on the right. The rules live in the info tooltip, not in a paragraph.

import React, { useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Info, Plus, Trash2, X } from 'lucide-react';
import { useBoardActions, type ProjectBoard, type BoardColumn } from '../../../../api/queries/projectBoard';
import { TASK_STATUSES } from '../../../../api/queries/projectTasks';
import useTranslation from '../../../../hooks/useTranslation';
import Modal from '../../../shared/Modal';
import { ErrorText, GhostButton, PrimaryButton, SecondaryButton, SELECT_CLASS } from '../workspaceUi';
import { statusLabel } from './taskText';
import { projectErrorText } from '../projectErrorText';
import { AnchoredMenu, ICON_BUTTON_CLASS } from './tasksMenu';

/** Which field of which column to put the cursor in when the dialog opens (from a lane's "…" menu). */
export interface BoardFocus { columnId: string; field: 'title' | 'wip' }

const NAME_CLASS = 'flex-1 min-w-32 h-8 px-2 rounded-md text-[13px] text-[var(--text-primary)] bg-transparent border border-transparent '
    + 'hover:border-[var(--border-subtle)] focus:border-[var(--border-default)] focus:bg-[var(--bg-primary)] outline-none transition-colors '
    + 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-[var(--accent-primary)]';
const WIP_CLASS = 'w-16 h-7 px-2 rounded-md text-[13px] tabular-nums text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] bg-[var(--bg-primary)] '
    + 'border border-[var(--border-default)] outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]';
const REVEAL = 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity';
const HEAD = 'text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-tertiary)]';

/** The rules of the columns, one tap away (a title tooltip alone never shows on a touch screen). */
function BoardHelp({ text }: { text: string }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const anchor = useRef<HTMLButtonElement>(null);
    const label = t('project_tasks.board_help', 'About board columns');
    return (
        <>
            <button ref={anchor} type="button" onClick={() => setOpen(v => !v)} aria-expanded={open} aria-label={label} title={text}
                className="grid place-items-center w-5 h-5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] aria-expanded:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]">
                <Info className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
            <AnchoredMenu open={open} onClose={() => setOpen(false)} anchorRef={anchor} align="left" width={280} role="note" aria-label={label}
                className="!rounded-xl !bg-[var(--bg-card)] px-3 py-2.5 text-[12.5px] font-normal leading-relaxed text-[var(--text-secondary)]">
                {text}
            </AnchoredMenu>
        </>
    );
}

/** One column: order, name (borderless until focus), status, WIP limit and a hover trash. */
function ColumnRow({ column, first, last, only, fresh, focusField, onChange, onShift, onRemove }: {
    column: BoardColumn; first: boolean; last: boolean;
    /** The only column of its status: it cannot be removed. */
    only: boolean;
    /** Just added: its name is selected so typing replaces "New column". */
    fresh: boolean;
    focusField?: BoardFocus['field'];
    onChange: (patch: Partial<BoardColumn>) => void; onShift: (by: number) => void; onRemove: () => void;
}) {
    const { t } = useTranslation();
    return (
        <li className="group flex flex-wrap sm:flex-nowrap items-center gap-2 min-h-11 py-1.5">
            <span className="flex items-center">
                <button type="button" className={ICON_BUTTON_CLASS} disabled={first} onClick={() => onShift(-1)}
                    aria-label={t('project_tasks.column_up', 'Move column left')} title={t('project_tasks.column_up', 'Move column left')}>
                    <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
                <button type="button" className={ICON_BUTTON_CLASS} disabled={last} onClick={() => onShift(1)}
                    aria-label={t('project_tasks.column_down', 'Move column right')} title={t('project_tasks.column_down', 'Move column right')}>
                    <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
            </span>
            <input className={NAME_CLASS} value={column.title} maxLength={80} autoFocus={focusField === 'title'}
                onFocus={e => { if (fresh) e.currentTarget.select(); }}
                onChange={e => onChange({ title: e.target.value })} aria-label={t('project_tasks.column_name', 'Column name')} />
            <select className={`${SELECT_CLASS} !h-7 w-32`} value={column.status} onChange={e => onChange({ status: e.target.value as BoardColumn['status'] })}
                aria-label={t('project_tasks.status_label', 'Status')}>
                {TASK_STATUSES.map(s => <option key={s} value={s}>{statusLabel(t, s)}</option>)}
            </select>
            <input type="number" min={1} max={100} className={WIP_CLASS} placeholder="—" value={column.wipLimit || ''} autoFocus={focusField === 'wip'}
                onChange={e => onChange({ wipLimit: e.target.value ? Number(e.target.value) : null })} aria-label={t('project_tasks.wip_limit', 'Work in progress limit')} />
            <button type="button" disabled={only} onClick={onRemove}
                aria-label={t('project_tasks.column_remove', 'Remove column')} title={t('project_tasks.column_remove', 'Remove column')}
                className={`${ICON_BUTTON_CLASS} hover:text-[var(--error-ink)] ${only ? '!opacity-30' : REVEAL}`}>
                <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
        </li>
    );
}

export default function BoardSettings({ projectId, board, onClose, focus }: { projectId: string; board: ProjectBoard; onClose: () => void; focus?: BoardFocus }) {
    const { t } = useTranslation();
    const [columns, setColumns] = useState(() => board.columns.map(c => ({ ...c, title: c.title || statusLabel(t, c.status) })));
    const [version] = useState(board.version);
    const [added, setAdded] = useState<string | null>(null);
    const { save } = useBoardActions(projectId);
    const set = (id: string, patch: Partial<BoardColumn>) => setColumns(cs => cs.map(c => c.id === id ? { ...c, ...patch } : c));
    const shift = (index: number, by: number) => setColumns(cs => { const next = [...cs]; [next[index], next[index + by]] = [next[index + by], next[index]]; return next; });
    const add = () => {
        const id = crypto.randomUUID();
        setColumns(cs => [...cs, { id, title: t('project_tasks.new_column', 'New column'), status: 'doing', wipLimit: null }]);
        setAdded(id);
    };
    const help = t('project_tasks.column_help', 'Columns are shared with everyone. Keep one column for each status. Move tasks out before removing a column. WIP limits highlight too much work in progress.');

    return (
        <Modal open onClose={onClose} size="lg" className="overflow-hidden" data-testid="board-settings"
            title={(
                <span className="inline-flex items-center gap-1.5 text-[14px]">
                    {t('project_tasks.board_columns', 'Board columns')}
                    <BoardHelp text={help} />
                </span>
            )}
            headerActions={(
                <button type="button" onClick={onClose} aria-label={t('project_content.close', 'Close')} title={t('project_content.close', 'Close')} className={ICON_BUTTON_CLASS}>
                    <X className="w-4 h-4" aria-hidden="true" />
                </button>
            )}
            footer={(
                <>
                    <GhostButton className="mr-auto h-8 !px-2.5 !text-[12.5px]" disabled={columns.length >= 20} onClick={add}>
                        <Plus className="w-3.5 h-3.5" aria-hidden="true" />{t('project_tasks.add_column', 'Add column')}
                    </GhostButton>
                    <SecondaryButton onClick={onClose}>{t('project_content.cancel', 'Cancel')}</SecondaryButton>
                    <PrimaryButton busy={save.isPending} disabled={columns.some(c => !c.title.trim())} onClick={() => save.mutate({ columns, version }, { onSuccess: onClose })}>
                        {t('project_home.settings.save', 'Save')}
                    </PrimaryButton>
                </>
            )}>
            <div className="space-y-2" aria-label={t('project_tasks.configure_board', 'Configure board')} role="group">
                <div className="hidden sm:flex items-center gap-2 pr-9 pl-[64px]" aria-hidden="true">
                    <span className={`${HEAD} flex-1 pl-2`}>{t('project_tasks.column_name', 'Column name')}</span>
                    <span className={`${HEAD} w-32`}>{t('project_tasks.status_label', 'Status')}</span>
                    <span className={`${HEAD} w-16`} title={t('project_tasks.wip_limit', 'Work in progress limit')}>{t('project_tasks.wip_short', 'WIP')}</span>
                </div>
                <ol className="list-none p-0 m-0 divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">
                    {columns.map((column, index) => (
                        <ColumnRow key={column.id} column={column} first={index === 0} last={index === columns.length - 1}
                            only={columns.filter(c => c.status === column.status).length === 1} fresh={added === column.id}
                            focusField={added === column.id ? 'title' : !added && focus?.columnId === column.id ? focus.field : undefined}
                            onChange={patch => set(column.id, patch)} onShift={by => shift(index, by)}
                            onRemove={() => setColumns(cs => cs.filter(c => c.id !== column.id))} />
                    ))}
                </ol>
                <ErrorText>{save.error ? projectErrorText(t, save.error) : null}</ErrorText>
            </div>
        </Modal>
    );
}
