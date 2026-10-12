// One action item of a meeting as a row of the "From a meeting" dialog: a tick,
// the title as an inline field, and under it compact pickers for who, when and
// how urgent, plus state chips. What the AI added folds out under "Details".

import { ChevronRight, Sparkles } from 'lucide-react';
import React, { useId, useState } from 'react';
import { TASK_PRIORITIES, type ChecklistItem, type MeetingTaskSuggestion, type TaskPriority } from '../../../../api/queries/projectTasks';
import { useTranslation } from '../../../../hooks/useTranslation';
import { Avatar, SelectField } from '../workspaceUi';
import { CHIP_CLASS, LabelChip, PriorityIcon } from './TaskFields';
import { priorityLabel } from './taskText';
import { INLINE_CONTROL } from './taskDialogParts';

export interface Row {
    selected: boolean;
    title: string;
    assigneeId: string;
    dueDate: string;
    priority: TaskPriority;
    /** What the AI added: a description, labels and steps; empty until it has answered. */
    description: string;
    labels: string[];
    checklist: ChecklistItem[];
    /** The AI chose this person (shown, and changeable). */
    aiAssignee: boolean;
    improved: boolean;
}

/** What the note says when nobody was named (English and Dutch). */
export const NOBODY = /^(unassigned|niet toegewezen|nobody|niemand|n\/a|-)?$/i;

const NEUTRAL = `${CHIP_CLASS} bg-[var(--bg-secondary)] text-[var(--text-secondary)]`;
const INFO = `${CHIP_CLASS} bg-[color-mix(in_srgb,var(--info)_14%,transparent)] text-[var(--info-ink)]`;
const SUCCESS = `${CHIP_CLASS} bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-[var(--success-ink)]`;

type Person = { id: string; name: string; avatar?: { type: 'emoji' | 'image' | 'url'; value: string }; color?: string };

/** The AI's description, labels and steps of a ticked row: a one-line summary that opens into the editable text. */
function AiDetails({ s, row, onChange }: { s: MeetingTaskSuggestion; row: Row; onChange: (patch: Partial<Row>) => void }) {
    const { t } = useTranslation();
    const panel = useId();
    const [open, setOpen] = useState(false);
    return (
        <div className="space-y-1.5" data-testid={`ai-detail-${s.itemId}`}>
            <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} aria-controls={panel}
                    className="inline-flex items-center gap-1 h-6 -ml-1 pl-0.5 pr-1.5 rounded-md text-[11.5px] font-medium text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)] transition-colors">
                    <ChevronRight className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
                    {t('project_tasks.details', 'Details')}
                </button>
                {!open && row.description && <span className="flex-1 min-w-0 truncate text-[11.5px] text-[var(--text-tertiary)]">{row.description}</span>}
                {row.labels.map(l => <LabelChip key={l} label={l} onRemove={() => onChange({ labels: row.labels.filter(x => x !== l) })} />)}
                {row.checklist.length > 0 && (
                    <span className="text-[11.5px] text-[var(--text-tertiary)] tabular-nums">{t('project_tasks.steps_count', '{count} steps', { count: row.checklist.length })}</span>
                )}
            </div>
            {open && (
                <textarea id={panel} value={row.description} maxLength={2000} aria-label={t('project_tasks.description_label', 'Description')}
                    onChange={e => onChange({ description: e.target.value })}
                    className="block w-full min-h-[72px] px-2 py-1.5 rounded-lg border-0 bg-[var(--bg-secondary)] text-[12.5px] leading-relaxed text-[var(--text-primary)] resize-y outline-none focus:ring-1 focus:ring-[var(--border-default)]" />
            )}
        </div>
    );
}

/** The state of an item as chips: already a task, finished in the notes, who the AI or the notes named. */
function StateChips({ s, row }: { s: MeetingTaskSuggestion; row: Row }) {
    const { t } = useTranslation();
    const made = !!s.createdTaskId;
    return (
        <>
            {!NOBODY.test(s.assigneeName.trim()) && !s.suggestedAssigneeId && !made && (
                <span className={`${NEUTRAL} max-w-full`}><span className="truncate">{t('project_tasks.note_says', 'The notes say: {name}', { name: s.assigneeName })}</span></span>
            )}
            {row.aiAssignee && row.assigneeId && !made && (
                <span className={NEUTRAL} data-testid={`ai-assignee-${s.itemId}`}>
                    <Sparkles className="w-3 h-3" aria-hidden="true" />{t('project_tasks.ai_chose_person', 'Suggested by the AI')}
                </span>
            )}
            {made && (
                <span className={`${INFO} max-w-full`}><span className="truncate">{row.improved ? t('project_tasks.already_task_update', 'Already a task: tick to let the AI improve it') : t('project_tasks.already_task', 'Already a task')}</span></span>
            )}
            {s.done && !made && <span className={SUCCESS}>{t('project_tasks.done_in_meeting', 'Marked done in the notes')}</span>}
        </>
    );
}

export default function MeetingSuggestionRow({ s, row, people, onChange }: {
    s: MeetingTaskSuggestion; row: Row; people: Person[]; onChange: (patch: Partial<Row>) => void;
}) {
    const { t } = useTranslation();
    const made = !!s.createdTaskId;
    const off = made || !row.selected;
    const person = people.find(p => p.id === row.assigneeId);
    return (
        <li className={`flex items-start gap-3 px-3 py-2.5 transition-colors ${made && !row.improved ? 'opacity-60' : ''}`} data-testid={`suggestion-${s.itemId}`}>
            <input type="checkbox" checked={row.selected} disabled={made && !row.improved} onChange={e => onChange({ selected: e.target.checked })}
                aria-label={made
                    ? t('project_tasks.update_item', 'Update the existing task with the AI: {text}', { text: s.text })
                    : t('project_tasks.include_item', 'Make a task of: {text}', { text: s.text })}
                className="mt-2 flex-none accent-[var(--accent-primary)]" />
            <div className="flex-1 min-w-0 space-y-1">
                <input value={row.title} maxLength={200} disabled={off} aria-label={t('project_tasks.title_label', 'What needs to be done?')}
                    onChange={e => onChange({ title: e.target.value })}
                    className="block w-full h-8 -mx-1.5 px-1.5 rounded-md border-0 bg-transparent text-[13px] font-medium text-[var(--text-primary)] outline-none hover:bg-[var(--item-hover-bg)] focus:bg-transparent focus:ring-1 focus:ring-[var(--border-default)] disabled:hover:bg-transparent disabled:text-[var(--text-secondary)] transition-colors" />
                <div className="flex flex-wrap items-center gap-x-1 gap-y-1 -ml-1.5">
                    <span className="inline-flex items-center">
                        {person && <Avatar name={person.name} size="sm" picture={person.avatar} color={person.color} className="!w-5 !h-5 !text-[9px] ring-0 ml-1" />}
                        <SelectField bare className={`${INLINE_CONTROL} max-w-[11rem] ${row.assigneeId ? '' : 'text-[var(--text-tertiary)]'}`} value={row.assigneeId} disabled={off}
                            onChange={e => onChange({ assigneeId: e.target.value })} aria-label={t('project_tasks.assignees', 'Assigned to')}>
                            <option value="">{t('project_tasks.who_unassigned', 'Not given to anyone')}</option>
                            {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </SelectField>
                    </span>
                    <input type="date" className={`${INLINE_CONTROL} tabular-nums ${row.dueDate ? '' : 'text-[var(--text-tertiary)]'}`} value={row.dueDate} disabled={off}
                        onChange={e => onChange({ dueDate: e.target.value })} aria-label={t('project_tasks.due_label', 'Due date')} />
                    <span className="relative inline-flex items-center">
                        {(row.priority === 'high' || row.priority === 'urgent') && <span className="absolute left-1.5 flex pointer-events-none"><PriorityIcon priority={row.priority} className="w-3 h-3" /></span>}
                        <SelectField bare className={`${INLINE_CONTROL} ${row.priority === 'high' || row.priority === 'urgent' ? 'pl-5' : ''}`} value={row.priority} disabled={off}
                            onChange={e => onChange({ priority: e.target.value as TaskPriority })} aria-label={t('project_tasks.priority_label', 'Priority')}>
                            {TASK_PRIORITIES.map(p => <option key={p} value={p}>{priorityLabel(t, p)}</option>)}
                        </SelectField>
                    </span>
                    <StateChips s={s} row={row} />
                </div>
                {row.improved && row.selected && <AiDetails s={s} row={row} onChange={onChange} />}
            </div>
        </li>
    );
}
