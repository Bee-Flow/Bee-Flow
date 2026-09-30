// The extra fields of a task: labels, a checklist, and the priority mark.

import { Plus, X } from 'lucide-react';
import React, { useId, useState } from 'react';
import type { ChecklistItem, TaskPriority } from '../../../../api/queries/projectTasks';
import { useTranslation } from '../../../../hooks/useTranslation';
import { INPUT_CLASS } from '../workspaceUi';
import { priorityLabel, priorityTone } from './taskText';

export const MAX_LABELS = 20;
export const MAX_LABEL_LENGTH = 40;
export const MAX_CHECKLIST = 50;
export const MAX_CHECK_TEXT = 200;

export function newCheckId(): string {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function PriorityMark({ priority }: { priority: TaskPriority }) {
    const { t } = useTranslation();
    const tone = priorityTone(priority);
    if (!tone) return null;
    return (
        <span className="inline-flex items-center px-1.5 py-px rounded-full text-[10.5px] font-semibold border" style={{ color: tone, borderColor: tone }}>
            {priorityLabel(t, priority)}
        </span>
    );
}

export function LabelChip({ label, onRemove }: { label: string; onRemove?: () => void }) {
    const { t } = useTranslation();
    return (
        <span className="inline-flex items-center gap-1 max-w-full px-2 py-0.5 rounded-full text-[11.5px] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
            <span className="truncate">{label}</span>
            {onRemove && (
                <button type="button" onClick={onRemove} aria-label={t('project_tasks.remove_label', 'Remove label {name}', { name: label })}
                    className="grid place-items-center w-3.5 h-3.5 rounded-full hover:text-[var(--text-primary)]">
                    <X className="w-3 h-3" aria-hidden="true" />
                </button>
            )}
        </span>
    );
}

/** Labels typed one at a time: Enter or a comma adds, Backspace on an empty box takes the last one off. */
export function LabelsInput({ value, onChange, disabled, suggestions = [] }: {
    value: string[]; onChange: (labels: string[]) => void; disabled: boolean; suggestions?: string[];
}) {
    const { t } = useTranslation();
    const listId = useId();
    const [draft, setDraft] = useState('');
    const add = (raw: string) => {
        const name = raw.trim().slice(0, MAX_LABEL_LENGTH);
        setDraft('');
        if (!name || value.some(v => v.toLowerCase() === name.toLowerCase()) || value.length >= MAX_LABELS) return;
        onChange([...value, name]);
    };
    return (
        <div className="flex flex-wrap items-center gap-1.5">
            {value.map(l => <LabelChip key={l} label={l} onRemove={disabled ? undefined : () => onChange(value.filter(x => x !== l))} />)}
            {!disabled && value.length < MAX_LABELS && (
                <>
                    <input value={draft} list={listId} maxLength={MAX_LABEL_LENGTH} placeholder={t('project_tasks.add_label', 'Add a label')}
                        aria-label={t('project_tasks.add_label', 'Add a label')}
                        onChange={(e) => (e.target.value.endsWith(',') ? add(e.target.value.slice(0, -1)) : setDraft(e.target.value))}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); add(draft); }
                            else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
                        }}
                        onBlur={() => add(draft)}
                        className="min-w-[8rem] flex-1 bg-transparent text-[12.5px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none py-1" />
                    <datalist id={listId}>{suggestions.filter(s => !value.includes(s)).map(s => <option key={s} value={s} />)}</datalist>
                </>
            )}
        </div>
    );
}

export function ChecklistEditor({ value, onChange, disabled }: { value: ChecklistItem[]; onChange: (items: ChecklistItem[]) => void; disabled: boolean }) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState('');
    const add = () => {
        const text = draft.trim().slice(0, MAX_CHECK_TEXT);
        if (!text || value.length >= MAX_CHECKLIST) return;
        onChange([...value, { id: newCheckId(), text, done: false }]);
        setDraft('');
    };
    const patch = (id: string, change: Partial<ChecklistItem>) => onChange(value.map(i => (i.id === id ? { ...i, ...change } : i)));
    return (
        <div className="space-y-1.5">
            {value.length > 0 && (
                <ul className="list-none m-0 p-0 space-y-1" aria-label={t('project_tasks.checklist', 'Checklist')}>
                    {value.map(item => (
                        <li key={item.id} className="flex items-center gap-2">
                            <input type="checkbox" checked={item.done} disabled={disabled} onChange={e => patch(item.id, { done: e.target.checked })}
                                aria-label={item.text} className="accent-[var(--accent-primary)]" />
                            <input value={item.text} maxLength={MAX_CHECK_TEXT} disabled={disabled} onChange={e => patch(item.id, { text: e.target.value })}
                                onBlur={() => { if (!item.text.trim()) onChange(value.filter(i => i.id !== item.id)); }}
                                aria-label={t('project_tasks.checklist_item', 'Checklist item')}
                                className={`flex-1 min-w-0 bg-transparent text-[13px] outline-none ${item.done ? 'line-through text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]'}`} />
                            {!disabled && (
                                <button type="button" onClick={() => onChange(value.filter(i => i.id !== item.id))} aria-label={t('project_tasks.remove_item', 'Remove item')}
                                    className="grid place-items-center w-6 h-6 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
                                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {!disabled && value.length < MAX_CHECKLIST && (
                <div className="flex items-center gap-2">
                    <Plus className="w-3.5 h-3.5 text-[var(--text-tertiary)]" aria-hidden="true" />
                    <input value={draft} maxLength={MAX_CHECK_TEXT} onChange={e => setDraft(e.target.value)} className={`${INPUT_CLASS} !py-1.5`}
                        placeholder={t('project_tasks.add_item', 'Add a step')} aria-label={t('project_tasks.add_item', 'Add a step')}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} onBlur={add} />
                </div>
            )}
        </div>
    );
}
