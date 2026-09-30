import React, { useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react';
import { useBoardActions, type ProjectBoard, type BoardColumn } from '../../../../api/queries/projectBoard';
import { TASK_STATUSES } from '../../../../api/queries/projectTasks';
import useTranslation from '../../../../hooks/useTranslation';
import { ErrorText, INPUT_CLASS, PrimaryButton, SecondaryButton, SELECT_CLASS } from '../workspaceUi';
import { statusLabel } from './taskText';
import { projectErrorText } from '../projectErrorText';

export default function BoardSettings({ projectId, board, onClose }: { projectId: string; board: ProjectBoard; onClose: () => void }) {
    const { t } = useTranslation();
    const [columns, setColumns] = useState(() => board.columns.map(c => ({ ...c, title: c.title || statusLabel(t, c.status) })));
    const [version] = useState(board.version);
    const { save } = useBoardActions(projectId);
    const set = (id: string, patch: Partial<BoardColumn>) => setColumns(cs => cs.map(c => c.id === id ? { ...c, ...patch } : c));
    const shift = (index: number, by: number) => setColumns(cs => { const next = [...cs]; [next[index], next[index + by]] = [next[index + by], next[index]]; return next; });
    return <section className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-card)] p-4 space-y-3" aria-label={t('project_tasks.configure_board', 'Configure board')}>
        <div className="flex items-center gap-2"><h3 className="flex-1 m-0 font-semibold">{t('project_tasks.configure_board', 'Configure board')}</h3><SecondaryButton onClick={onClose} aria-label={t('project_content.close', 'Close')}><X className="w-4 h-4" /></SecondaryButton></div>
        <p className="text-xs text-[var(--text-secondary)]">{t('project_tasks.column_help', 'Columns are shared with everyone. Keep one column for each status. Move tasks out before removing a column. WIP limits highlight too much work in progress.')}</p>
        <ol className="list-none p-0 m-0 space-y-2">{columns.map((column, index) => <li key={column.id} className="flex flex-wrap gap-2 items-center p-2 rounded-xl bg-[var(--bg-secondary)]">
            <input className={`${INPUT_CLASS} flex-1 min-w-32`} value={column.title} maxLength={80} onChange={e => set(column.id, { title: e.target.value })} aria-label={t('project_tasks.column_name', 'Column name')} />
            <select className={SELECT_CLASS} value={column.status} onChange={e => set(column.id, { status: e.target.value as BoardColumn['status'] })} aria-label={t('project_tasks.status_label', 'Status')}>{TASK_STATUSES.map(s => <option key={s} value={s}>{statusLabel(t,s)}</option>)}</select>
            <input type="number" min={1} max={100} className={`${INPUT_CLASS} !w-24`} placeholder="WIP" value={column.wipLimit || ''} onChange={e => set(column.id, { wipLimit: e.target.value ? Number(e.target.value) : null })} aria-label={t('project_tasks.wip_limit', 'Work in progress limit')} />
            <SecondaryButton disabled={index === 0} onClick={() => shift(index, -1)} aria-label={t('project_tasks.column_up', 'Move column left')}><ArrowUp className="w-4 h-4" /></SecondaryButton>
            <SecondaryButton disabled={index === columns.length - 1} onClick={() => shift(index, 1)} aria-label={t('project_tasks.column_down', 'Move column right')}><ArrowDown className="w-4 h-4" /></SecondaryButton>
            <SecondaryButton disabled={columns.filter(c => c.status === column.status).length === 1} onClick={() => setColumns(cs => cs.filter(c => c.id !== column.id))} aria-label={t('project_tasks.column_remove', 'Remove column')}><Trash2 className="w-4 h-4" /></SecondaryButton>
        </li>)}</ol>
        <div className="flex justify-between gap-2"><SecondaryButton disabled={columns.length >= 20} onClick={() => setColumns(cs => [...cs, { id: crypto.randomUUID(), title: t('project_tasks.new_column', 'New column'), status: 'doing', wipLimit: null }])}><Plus className="w-4 h-4" />{t('project_tasks.add_column', 'Add column')}</SecondaryButton><PrimaryButton busy={save.isPending} disabled={columns.some(c => !c.title.trim())} onClick={() => save.mutate({ columns, version }, { onSuccess: onClose })}>{t('project_home.settings.save', 'Save')}</PrimaryButton></div>
        <ErrorText>{save.error ? projectErrorText(t, save.error) : null}</ErrorText>
    </section>;
}
