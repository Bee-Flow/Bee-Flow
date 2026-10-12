// The extra fields of a task (labels, a checklist) and the small chips and glyphs every
// tasks view shares: status, type, priority and label, so a task looks the same everywhere.

import { BookOpen, Check, CircleDot, Layers3, Plus, Signal, SignalHigh, User, X } from 'lucide-react';
import React, { useId, useState } from 'react';
import type { ChecklistItem, TaskPriority, TaskStatus } from '../../../../api/queries/projectTasks';
import { useTranslation, type TranslateFn } from '../../../../hooks/useTranslation';
import type { WorkItemType } from './taskPlanning';
import { checklistProgress, priorityLabel, priorityTone, statusLabel } from './taskText';

export const MAX_LABELS = 20;
const MAX_LABEL_LENGTH = 40;
const MAX_CHECKLIST = 50;
const MAX_CHECK_TEXT = 200;

function newCheckId(): string {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    // randomUUID needs a secure context; getRandomValues does not.
    const bytes = c.getRandomValues(new Uint8Array(8));
    return `c-${Date.now().toString(36)}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** One chip recipe for the whole tasks area: neutral by default, tinted only when it carries state. */
export const CHIP_CLASS = 'inline-flex items-center gap-1 h-5 px-1.5 rounded-md text-[11px] font-medium leading-none whitespace-nowrap';
const NEUTRAL_CHIP = 'bg-[var(--bg-secondary)] text-[var(--text-secondary)]';

const PRIORITY_INK: Partial<Record<TaskPriority, string>> = {
    urgent: 'text-[var(--error-ink)]',
    high: 'text-[var(--warning-ink)]',
};
/** The ring, in-progress dot or success tick a task shows for its status (the list's tick button draws the same). */
export function StatusMark({ status }: { status: TaskStatus }) {
    if (status === 'done') {
        return (
            <span className="grid place-items-center w-4 h-4 rounded-full bg-[var(--success-ink)] text-[var(--bg-card)]">
                <Check className="w-2.5 h-2.5" strokeWidth={3.5} aria-hidden="true" />
            </span>
        );
    }
    if (status === 'doing') return <CircleDot className="w-4 h-4 text-[var(--info-ink)]" strokeWidth={2.25} aria-hidden="true" />;
    return <span className="w-4 h-4 rounded-full border-[1.5px] border-[var(--border-default)]" aria-hidden="true" />;
}

/** A read-only status glyph, named for screen readers and in its tooltip; `decorative` when the row already says it. */
export function StatusGlyph({ status, decorative = false }: { status: TaskStatus; decorative?: boolean }) {
    const { t } = useTranslation();
    const label = statusLabel(t, status);
    return decorative
        ? <span aria-hidden="true" className="grid place-items-center flex-none w-4 h-4"><StatusMark status={status} /></span>
        : <span role="img" aria-label={label} title={label} className="grid place-items-center flex-none w-4 h-4"><StatusMark status={status} /></span>;
}

/** A small signal glyph for high and urgent work; nothing for the ordinary priorities. The word lives in the tooltip. */
export function PriorityIcon({ priority, className = 'w-3.5 h-3.5' }: { priority: TaskPriority; className?: string }) {
    const { t } = useTranslation();
    if (!priorityTone(priority)) return null;
    const Icon = priority === 'urgent' ? Signal : SignalHigh;
    const word = priorityLabel(t, priority);
    return (
        <span className={`inline-flex flex-none ${PRIORITY_INK[priority]}`} title={`${t('project_tasks.priority_label', 'Priority')}: ${word}`}>
            <Icon className={className} aria-hidden="true" /><span className="sr-only">{word}</span>
        </span>
    );
}

const TYPE_ICON: Record<Exclude<WorkItemType, 'task'>, typeof Layers3> = { epic: Layers3, story: BookOpen, 'user-story': User };

export function typeLabel(t: TranslateFn, type: WorkItemType): string {
    if (type === 'epic') return t('project_tasks.type_epic', 'Epic');
    if (type === 'story') return t('project_tasks.type_story', 'Story');
    if (type === 'user-story') return t('project_tasks.type_user_story', 'User story');
    return t('project_tasks.type_task', 'Task');
}

/** The type of a work item as a lone 14px glyph (epic, story, user story); a plain task shows nothing. */
export function TypeIcon({ type, className = 'w-3.5 h-3.5' }: { type: WorkItemType; className?: string }) {
    const { t } = useTranslation();
    if (type === 'task') return null;
    const Icon = TYPE_ICON[type];
    const label = typeLabel(t, type);
    return (
        <span className="inline-flex flex-none text-[var(--text-tertiary)]" title={label} data-type={type}>
            <Icon className={className} aria-hidden="true" /><span className="sr-only">{label}</span>
        </span>
    );
}

/**
 * The type of a work item as a neutral chip with its icon and translated name; a plain task
 * shows none. The one type chip of the tasks area: list, board, hierarchy, backlog, sprints, poker.
 */
export function TypeChip({ type }: { type: WorkItemType }) {
    const { t } = useTranslation();
    if (type === 'task') return null;
    const Icon = TYPE_ICON[type];
    return (
        <span className={`${CHIP_CLASS} ${NEUTRAL_CHIP} flex-none`} data-type={type}>
            <Icon className="w-2.5 h-2.5" aria-hidden="true" />{typeLabel(t, type)}
        </span>
    );
}

export function LabelChip({ label, onRemove }: { label: string; onRemove?: () => void }) {
    const { t } = useTranslation();
    return (
        <span className={`${CHIP_CLASS} ${NEUTRAL_CHIP} max-w-[12rem] ${onRemove ? 'pr-0.5' : ''}`}>
            <span className="truncate">{label}</span>
            {onRemove && (
                <button type="button" onClick={onRemove} aria-label={t('project_tasks.remove_label', 'Remove label {name}', { name: label })}
                    className="grid place-items-center w-4 h-4 rounded hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] transition-colors">
                    <X className="w-3 h-3" aria-hidden="true" />
                </button>
            )}
        </span>
    );
}

/** Labels typed one at a time: Enter or a comma adds, Backspace on an empty box takes the last one off. */
export function LabelsInput({ value, onChange, disabled, suggestions = [], maxLabels = MAX_LABELS }: {
    value: string[]; onChange: (labels: string[]) => void; disabled: boolean; suggestions?: string[]; maxLabels?: number;
}) {
    const { t } = useTranslation();
    const listId = useId();
    const [draft, setDraft] = useState('');
    const add = (raw: string) => {
        const name = raw.trim().slice(0, MAX_LABEL_LENGTH);
        setDraft('');
        if (!name || value.some(v => v.toLowerCase() === name.toLowerCase()) || value.length >= maxLabels) return;
        onChange([...value, name]);
    };
    return (
        <div className="flex flex-wrap items-center gap-1.5">
            {value.map(l => <LabelChip key={l} label={l} onRemove={disabled ? undefined : () => onChange(value.filter(x => x !== l))} />)}
            {!disabled && value.length < maxLabels && (
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
    const progress = checklistProgress(value);
    return (
        <div className="space-y-1.5">
            {progress && (
                <div className="flex items-center gap-2">
                    <div className="flex-1 h-1 rounded-full bg-[var(--bg-tertiary)] overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}
                        aria-label={t('project_tasks.checklist_progress', '{done} of {total} steps done', progress)}>
                        <ProgressFill done={progress.done} total={progress.total} />
                    </div>
                    <span className="text-[11.5px] text-[var(--text-tertiary)] tabular-nums whitespace-nowrap">{t('project_tasks.checklist_of', '{done} of {total}', progress)}</span>
                </div>
            )}
            {value.length > 0 && (
                <ul className="list-none m-0 p-0" aria-label={t('project_tasks.checklist', 'Checklist')}>
                    {value.map(item => (
                        <li key={item.id} className="group/item flex items-center gap-2 h-8 px-1 -mx-1 rounded-md hover:bg-[var(--item-hover-bg)] transition-colors">
                            <input type="checkbox" checked={item.done} disabled={disabled} onChange={e => patch(item.id, { done: e.target.checked })}
                                aria-label={item.text} className="accent-[var(--accent-primary)]" />
                            <input value={item.text} maxLength={MAX_CHECK_TEXT} disabled={disabled} onChange={e => patch(item.id, { text: e.target.value })}
                                onBlur={() => { if (!item.text.trim()) onChange(value.filter(i => i.id !== item.id)); }}
                                aria-label={t('project_tasks.checklist_item', 'Checklist item')}
                                className={`flex-1 min-w-0 bg-transparent text-[13px] outline-none ${item.done ? 'line-through text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]'}`} />
                            {!disabled && (
                                <button type="button" onClick={() => onChange(value.filter(i => i.id !== item.id))} aria-label={t('project_tasks.remove_item', 'Remove item')}
                                    title={t('project_tasks.remove_item', 'Remove item')}
                                    className="grid place-items-center w-6 h-6 rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] opacity-0 group-hover/item:opacity-100 focus-visible:opacity-100 group-focus-within/item:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity">
                                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {!disabled && value.length < MAX_CHECKLIST && (
                <div className="flex items-center gap-2 h-8 px-1 -mx-1 rounded-md focus-within:bg-[var(--item-hover-bg)] transition-colors">
                    <Plus className="w-3.5 h-3.5 flex-none text-[var(--text-tertiary)]" aria-hidden="true" />
                    <input value={draft} maxLength={MAX_CHECK_TEXT} onChange={e => setDraft(e.target.value)}
                        className="flex-1 min-w-0 h-8 p-0 bg-transparent border-0 outline-none focus:ring-0 text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
                        placeholder={t('project_tasks.add_item', 'Add a step')} aria-label={t('project_tasks.add_item', 'Add a step')}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} onBlur={add} />
                </div>
            )}
        </div>
    );
}

/** The filled part of the checklist bar: a width step per tenth, so no inline style is needed. */
const FILL_STEPS = ['w-0', 'w-[10%]', 'w-[20%]', 'w-[30%]', 'w-[40%]', 'w-1/2', 'w-[60%]', 'w-[70%]', 'w-[80%]', 'w-[90%]', 'w-full'];
function ProgressFill({ done, total }: { done: number; total: number }) {
    const step = total ? Math.round((done / total) * 10) : 0;
    return <div className={`h-full rounded-full transition-[width] ${done === total ? 'bg-[var(--success-ink)]' : 'bg-[var(--text-tertiary)]'} ${FILL_STEPS[step]}`} />;
}
