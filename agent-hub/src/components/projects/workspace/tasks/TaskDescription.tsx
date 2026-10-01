// The description of a task in the dialog, with "Improve with AI" beside its
// heading and what the AI said directly under it, so the suggestion sits next
// to the text it is about.

import { Loader2, Sparkles } from 'lucide-react';
import React, { useRef, useState } from 'react';
import { useImproveTask, type ChecklistItem, type ProjectTask, type TaskPriority } from '../../../../api/queries/projectTasks';
import { useTranslation } from '../../../../hooks/useTranslation';
import { SecondaryButton } from '../workspaceUi';
import { GHOST_ACTION, useAutoGrow } from './taskDialogParts';

const MAX_DESCRIPTION = 20000;

/** The form fields the AI may fill in, as setters. */
export interface ImproveTargets {
    setDescription: (value: string) => void;
    setPriority: React.Dispatch<React.SetStateAction<TaskPriority>>;
    setLabels: React.Dispatch<React.SetStateAction<string[]>>;
    setChecklist: React.Dispatch<React.SetStateAction<ChecklistItem[]>>;
    setAssigneeIds: React.Dispatch<React.SetStateAction<string[]>>;
}

/**
 * The AI's suggestion fills the form; nothing is saved until the person saves. What they wrote stays:
 * a description they changed is not replaced, the suggestion is offered next to it.
 */
export function useImproveIntoForm(projectId: string, task: ProjectTask | null | undefined, description: string, targets: ImproveTargets) {
    const { t } = useTranslation();
    const improve = useImproveTask(projectId);
    const [note, setNote] = useState<string | null>(null);
    const [suggested, setSuggested] = useState<string | null>(null);
    // The description as it was when the task was opened, and as it is now (the AI answers later than the click).
    const openedAs = useRef(task?.description ?? '');
    const descriptionNow = useRef(description);
    descriptionNow.current = description;
    const run = () => {
        if (!task) return;
        setNote(null);
        setSuggested(null);
        improve.mutate(task.id, {
            onSuccess: (s) => {
                if (s.description) {
                    const typed = descriptionNow.current;
                    if (!typed.trim() || typed === openedAs.current) targets.setDescription(s.description);
                    else if (s.description !== typed) setSuggested(s.description);
                }
                targets.setPriority(prev => (prev !== 'normal' ? prev : s.priority));
                targets.setLabels(prev => [...prev, ...s.labels.filter(l => !prev.some(p => p.toLowerCase() === l))].slice(0, 20));
                targets.setChecklist(prev => (prev.length ? prev : s.checklist));
                if (s.assigneeId) targets.setAssigneeIds(prev => (prev.length ? prev : [s.assigneeId as string]));
                setNote(t('project_tasks.ai_suggested', 'The AI filled in suggestions. Read them, change what you like, and save.'));
            },
        });
    };
    return { run, pending: improve.isPending, failed: improve.isError, note, suggested, dismiss: () => setSuggested(null) };
}

export default function TaskDescription({ id, value, onChange, locked, busy, ai }: {
    id: string;
    value: string;
    onChange: (value: string) => void;
    locked: boolean;
    busy: boolean;
    /** Absent where the AI may not be asked (a new task, a reader). */
    ai?: ReturnType<typeof useImproveIntoForm>;
}) {
    const { t } = useTranslation();
    const ref = useAutoGrow(value);
    return (
        <section className="space-y-1.5">
            <div className="flex items-center gap-2 min-h-7">
                <label htmlFor={id} className="flex-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-tertiary)]">{t('project_tasks.description_label', 'Description')}</label>
                {ai && (
                    <button type="button" onClick={ai.run} disabled={ai.pending || busy} data-testid="task-improve-ai" className={GHOST_ACTION}>
                        {ai.pending ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />}
                        {ai.pending ? t('project_tasks.ai_working', 'Improving…') : t('project_tasks.improve_with_ai', 'Improve with AI')}
                    </button>
                )}
            </div>
            <textarea id={id} ref={ref} value={value} maxLength={MAX_DESCRIPTION} disabled={locked}
                placeholder={t('project_tasks.description_placeholder', 'Context, steps, what done looks like…')}
                onChange={e => onChange(e.target.value)}
                className="block w-[calc(100%+1rem)] min-h-[120px] -mx-2 px-2 py-1.5 resize-none overflow-hidden rounded-lg border-0 bg-transparent text-[13px] leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none hover:bg-[var(--item-hover-bg)] focus:bg-transparent focus:ring-1 focus:ring-[var(--border-default)] transition-colors disabled:opacity-100 disabled:hover:bg-transparent" />
            {ai?.note && (
                <p className="m-0 flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)]" role="status" data-testid="task-ai-note">
                    <Sparkles className="w-3.5 h-3.5 flex-none text-[var(--accent-primary)]" aria-hidden="true" />{ai.note}
                </p>
            )}
            {ai?.failed && <p className="m-0 text-[12px] text-[var(--text-tertiary)]" role="status">{t('project_tasks.ai_failed_one', 'The AI could not improve this task right now.')}</p>}
            {ai?.suggested && (
                <div className="rounded-lg bg-[var(--bg-secondary)] p-3 space-y-2" data-testid="task-ai-description">
                    <p className="m-0 text-[11.5px] font-medium text-[var(--text-tertiary)]">{t('project_tasks.ai_description_suggestion', 'Suggested description (yours is kept)')}</p>
                    <p className="m-0 text-[13px] leading-relaxed whitespace-pre-wrap text-[var(--text-primary)]">{ai.suggested}</p>
                    <div className="flex items-center gap-1">
                        <SecondaryButton onClick={() => { onChange(ai.suggested as string); ai.dismiss(); }} disabled={locked}>{t('project_tasks.ai_use_description', 'Use this description')}</SecondaryButton>
                        <button type="button" onClick={ai.dismiss} className={GHOST_ACTION}>{t('project_tasks.ai_dismiss_description', 'Dismiss')}</button>
                    </div>
                </div>
            )}
        </section>
    );
}
