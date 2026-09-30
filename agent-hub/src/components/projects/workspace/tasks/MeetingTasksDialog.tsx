// Make tasks from the action items of a meeting note: every item is a
// suggestion with a tick, a title, who it is for (the member the note's name
// points at, when it points at one), a due date and a priority. Items that
// already became a task are shown and left alone. Nothing is created until
// the person confirms.

import { Mic, Sparkles } from 'lucide-react';
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
    TASK_PRIORITIES, useCreateTasksBatch, useImproveMeetingTasks, useMeetingTaskSuggestions, useProjectTasksQuery, useUpdateTask,
    type ChecklistItem, type MeetingTaskImprovement, type MeetingTaskSuggestion, type ProjectTask, type TaskInput, type TaskPriority,
} from '../../../../api/queries/projectTasks';
import { useProjectResourcesQuery } from '../../../../api/queries/projects';
import useTranslation, { type TranslateFn } from '../../../../hooks/useTranslation';
import Modal from '../../../shared/Modal';
import { toast } from '../../../shared/Toast';
import { useChatPeople } from '../chat/chatPeople';
import { projectErrorText } from '../projectErrorText';
import type { WorkspaceUser } from '../types';
import { ErrorText, INPUT_CLASS, LoadingRow, Notice, PrimaryButton, SecondaryButton, SELECT_CLASS } from '../workspaceUi';
import { LabelChip } from './TaskFields';
import { priorityLabel } from './taskText';

export interface MeetingTasksDialogProps {
    projectId: string;
    currentUser: WorkspaceUser | null;
    /** The meeting to take action items from; absent asks which one. */
    meetingId?: string | null;
    onClose: () => void;
    /** After the tasks were made. */
    onCreated?: (count: number) => void;
}

interface Row {
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

/** What the AI adds to a task that exists: the description goes in front of what is there, what the person set stays. */
export function improvedPatch(task: ProjectTask, row: Row): Partial<TaskInput> {
    const description = row.description.trim();
    const kept = task.description.trim();
    return {
        description: !description || kept.includes(description) ? task.description : [description, kept].filter(Boolean).join('\n\n'),
        labels: [...task.labels, ...row.labels.filter(l => !task.labels.some(x => x.toLowerCase() === l.toLowerCase()))].slice(0, 20),
        checklist: task.checklist.length ? task.checklist : row.checklist,
        priority: task.priority !== 'normal' ? task.priority : row.priority,
        assigneeIds: task.assigneeIds.length ? task.assigneeIds : (row.assigneeId ? [row.assigneeId] : []),
        dueDate: task.dueDate || row.dueDate || null,
    };
}

/** The AI's expansion laid over a row: what the person already set (a member the notes named, a date) is kept. */
export function mergeImprovement(row: Row, imp: MeetingTaskImprovement): Row {
    const keepAssignee = !!row.assigneeId;
    return {
        ...row,
        title: row.title.trim() ? row.title : imp.title,
        description: imp.description,
        labels: imp.labels,
        checklist: imp.checklist,
        priority: row.priority !== 'normal' ? row.priority : imp.priority,
        assigneeId: keepAssignee ? row.assigneeId : (imp.assigneeId || ''),
        aiAssignee: !keepAssignee && !!imp.assigneeId,
        improved: true,
    };
}

/** What the note says when nobody was named (English and Dutch). */
const NOBODY = /^(unassigned|niet toegewezen|nobody|niemand|n\/a|-)?$/i;

/** Where the task came from, and who the note gave it to when that was nobody we could name. */
export function descriptionFor(t: TranslateFn, meetingTitle: string, s: Pick<MeetingTaskSuggestion, 'at' | 'assigneeName' | 'suggestedAssigneeId'>): string {
    const lines = [s.at
        ? t('project_tasks.from_meeting_at', 'From the meeting "{title}", at {at}.', { title: meetingTitle, at: s.at })
        : t('project_tasks.from_meeting', 'From the meeting "{title}".', { title: meetingTitle })];
    const named = s.assigneeName.trim();
    if (!NOBODY.test(named) && !s.suggestedAssigneeId) {
        lines.push(t('project_tasks.from_meeting_for', 'In the meeting this was for: {name}.', { name: named }));
    }
    return lines.join('\n');
}

function initialRows(suggestions: MeetingTaskSuggestion[]): Record<string, Row> {
    const rows: Record<string, Row> = {};
    for (const s of suggestions) {
        rows[s.itemId] = {
            // Done in the meeting, or already a task: not offered again by default.
            selected: !s.done && !s.createdTaskId,
            title: s.text.slice(0, 200),
            assigneeId: s.suggestedAssigneeId || '',
            dueDate: s.dueDate || '',
            priority: 'normal',
            description: '',
            labels: [],
            checklist: [],
            aiAssignee: false,
            improved: false,
        };
    }
    return rows;
}

function MeetingPicker({ projectId, onPick }: { projectId: string; onPick: (id: string) => void }) {
    const { t } = useTranslation();
    const resources = useProjectResourcesQuery(projectId);
    const meetings = (resources.data?.meetings || []).filter(m => typeof m.id === 'string');
    if (resources.isPending) return <LoadingRow label={t('project_tasks.loading_meetings', 'Loading meetings…')} />;
    if (!meetings.length) return <p className="m-0 text-sm text-[var(--text-tertiary)]">{t('project_tasks.no_meetings', 'No meetings in this project yet. Record or upload one in the Meetings tab.')}</p>;
    return (
        <ul className="list-none m-0 p-0 space-y-1.5" aria-label={t('project_tasks.pick_meeting', 'Choose a meeting')}>
            {meetings.map(m => (
                <li key={m.id}>
                    <button type="button" onClick={() => onPick(m.id)} data-testid={`pick-meeting-${m.id}`}
                        className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border border-[var(--border-subtle)] text-left hover:bg-[var(--item-hover-bg)]">
                        <Mic className="w-4 h-4 flex-shrink-0 text-[var(--kind-meet)]" aria-hidden="true" />
                        <span className="flex-1 min-w-0 truncate text-[13px] text-[var(--text-primary)]">{m.title || m.name || t('project_content.meeting_untitled', 'Untitled meeting')}</span>
                        {typeof m.actionItemCount === 'number' && (
                            <span className="text-[12px] text-[var(--text-tertiary)]">{t('project_tasks.action_items', '{count} action items', { count: m.actionItemCount })}</span>
                        )}
                    </button>
                </li>
            ))}
        </ul>
    );
}

function SuggestionRow({ s, row, people, onChange }: {
    s: MeetingTaskSuggestion; row: Row; people: { id: string; name: string }[]; onChange: (patch: Partial<Row>) => void;
}) {
    const { t } = useTranslation();
    const made = !!s.createdTaskId;
    return (
        <li className={`rounded-xl border px-3 py-2.5 space-y-2 ${made && !row.improved ? 'border-[var(--border-subtle)] opacity-60' : 'border-[var(--border-default)]'}`} data-testid={`suggestion-${s.itemId}`}>
            <div className="flex items-start gap-2.5">
                <input type="checkbox" checked={row.selected} disabled={made && !row.improved} onChange={e => onChange({ selected: e.target.checked })}
                    aria-label={made
                        ? t('project_tasks.update_item', 'Update the existing task with the AI: {text}', { text: s.text })
                        : t('project_tasks.include_item', 'Make a task of: {text}', { text: s.text })}
                    className="mt-1.5 accent-[var(--accent-primary)]" />
                <div className="flex-1 min-w-0 space-y-1.5">
                    <input className={INPUT_CLASS} value={row.title} maxLength={200} disabled={made || !row.selected}
                        aria-label={t('project_tasks.title_label', 'What needs to be done?')} onChange={e => onChange({ title: e.target.value })} />
                    <div className="flex flex-wrap items-center gap-2">
                        <select className={SELECT_CLASS} value={row.assigneeId} disabled={made || !row.selected} onChange={e => onChange({ assigneeId: e.target.value })}
                            aria-label={t('project_tasks.assignees', 'Assigned to')}>
                            <option value="">{t('project_tasks.who_unassigned', 'Not given to anyone')}</option>
                            {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                        <input type="date" className={SELECT_CLASS} value={row.dueDate} disabled={made || !row.selected} onChange={e => onChange({ dueDate: e.target.value })}
                            aria-label={t('project_tasks.due_label', 'Due date')} />
                        <select className={SELECT_CLASS} value={row.priority} disabled={made || !row.selected} onChange={e => onChange({ priority: e.target.value as TaskPriority })}
                            aria-label={t('project_tasks.priority_label', 'Priority')}>
                            {TASK_PRIORITIES.map(p => <option key={p} value={p}>{priorityLabel(t, p)}</option>)}
                        </select>
                        {!NOBODY.test(s.assigneeName.trim()) && !s.suggestedAssigneeId && !made && (
                            <span className="text-[11.5px] text-[var(--text-tertiary)]">{t('project_tasks.note_says', 'The notes say: {name}', { name: s.assigneeName })}</span>
                        )}
                        {row.aiAssignee && row.assigneeId && !made && (
                            <span className="inline-flex items-center gap-1 text-[11.5px] text-[var(--accent-primary)]" data-testid={`ai-assignee-${s.itemId}`}>
                                <Sparkles className="w-3 h-3" aria-hidden="true" />{t('project_tasks.ai_chose_person', 'Suggested by the AI')}
                            </span>
                        )}
                        {made && <span className="text-[11.5px] text-[var(--accent-primary)]">{row.improved ? t('project_tasks.already_task_update', 'Already a task: tick to let the AI improve it') : t('project_tasks.already_task', 'Already a task')}</span>}
                        {s.done && !made && <span className="text-[11.5px] text-[var(--text-tertiary)]">{t('project_tasks.done_in_meeting', 'Marked done in the notes')}</span>}
                    </div>
                    {row.improved && row.selected && (
                        <div className="space-y-1.5" data-testid={`ai-detail-${s.itemId}`}>
                            <textarea className={`${INPUT_CLASS} min-h-[64px] resize-y`} value={row.description} maxLength={2000}
                                aria-label={t('project_tasks.description_label', 'Description')} onChange={e => onChange({ description: e.target.value })} />
                            {(row.labels.length > 0 || row.checklist.length > 0) && (
                                <div className="flex flex-wrap items-center gap-1.5">
                                    {row.labels.map(l => <LabelChip key={l} label={l} onRemove={() => onChange({ labels: row.labels.filter(x => x !== l) })} />)}
                                    {row.checklist.length > 0 && (
                                        <span className="text-[11.5px] text-[var(--text-tertiary)]">{t('project_tasks.steps_count', '{count} steps', { count: row.checklist.length })}</span>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </li>
    );
}

function Suggestions({ projectId, meetingId, currentUser, onClose, onCreated }: MeetingTasksDialogProps & { meetingId: string }) {
    const { t } = useTranslation();
    const ids = useId();
    const query = useMeetingTaskSuggestions(projectId, meetingId);
    const people = useChatPeople(projectId, currentUser).people;
    const create = useCreateTasksBatch(projectId);
    const update = useUpdateTask(projectId);
    const existing = useProjectTasksQuery(projectId).data?.tasks;
    const improve = useImproveMeetingTasks(projectId, meetingId);
    const [rows, setRows] = useState<Record<string, Row>>({});
    const [error, setError] = useState<string | null>(null);
    const suggestions = useMemo(() => query.data?.suggestions || [], [query.data]);
    useEffect(() => { setRows(initialRows(suggestions)); }, [suggestions]);

    // The AI expands the items on its own once they are there; if it cannot, the plain items are still fine to make.
    const improveNow = () => improve.mutate(undefined, {
        onSuccess: (items) => setRows(prev => {
            const next = { ...prev };
            for (const imp of items) if (next[imp.itemId]) next[imp.itemId] = mergeImprovement(next[imp.itemId], imp);
            return next;
        }),
    });
    const asked = useRef<string | null>(null);
    useEffect(() => {
        // Anything not finished in the notes: new items to expand, and tasks already made that can be improved.
        const open = suggestions.some(s => !s.done);
        if (!query.data || !open || asked.current === meetingId) return;
        asked.current = meetingId;
        improveNow();
        // Once per meeting, when its items arrive: `improveNow` is a fresh function each render and must not restart this.
    }, [query.data, suggestions, meetingId]);

    const chosen = suggestions.filter(s => rows[s.itemId]?.selected && !s.createdTaskId && rows[s.itemId].title.trim());
    /** Tasks that already exist, ticked to be improved. */
    const updating = suggestions.filter(s => s.createdTaskId && rows[s.itemId]?.selected && rows[s.itemId].improved);
    const nothingNew = suggestions.length > 0 && suggestions.every(s => s.createdTaskId || s.done);
    const setAll = (selected: boolean) => setRows(prev => Object.fromEntries(Object.entries(prev).map(([k, r]) => {
        const made = !!suggestions.find(s => s.itemId === k)?.createdTaskId;
        return [k, { ...r, selected: selected && (!made || r.improved) }];
    })));
    const submit = async () => {
        setError(null);
        const title = query.data?.meeting.title || t('project_content.meeting_untitled', 'Untitled meeting');
        const items: TaskInput[] = chosen.map((s) => {
            const r = rows[s.itemId];
            return {
                title: r.title.trim(),
                description: [r.description.trim(), descriptionFor(t, title, s)].filter(Boolean).join('\n\n'),
                labels: r.labels,
                checklist: r.checklist,
                assigneeIds: r.assigneeId ? [r.assigneeId] : [],
                dueDate: r.dueDate || null,
                priority: r.priority,
                source: { kind: 'meeting', id: meetingId, itemId: s.itemId },
            };
        });
        try {
            const made = items.length ? (await create.mutateAsync(items)).tasks.length : 0;
            let improved = 0;
            for (const s of updating) {
                const task = existing?.find(x => x.id === s.createdTaskId);
                if (!task) continue;
                await update.mutateAsync({ id: task.id, patch: improvedPatch(task, rows[s.itemId]) });
                improved += 1;
            }
            toast.success(improved
                ? t('project_tasks.made_and_updated', '{made} tasks made, {updated} improved', { made, updated: improved })
                : t('project_tasks.made_count', '{count} tasks made', { count: made }));
            onCreated?.(made);
            onClose();
        } catch (e) {
            setError(projectErrorText(t, e));
        }
    };
    const busy = create.isPending || update.isPending;

    return (
        <Modal open onClose={onClose} size="lg" disableEscapeClose={create.isPending || update.isPending}
            title={t('project_tasks.from_meeting_title', 'Tasks from the meeting')}
            description={query.data?.meeting.title || undefined}
            footer={(
                <div className="flex items-center gap-2">
                    <SecondaryButton onClick={improveNow} busy={improve.isPending} disabled={busy || !suggestions.length} data-testid="meeting-tasks-improve">
                        <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />{t('project_tasks.improve_with_ai', 'Improve with AI')}
                    </SecondaryButton>
                    <SecondaryButton onClick={() => setAll(true)} disabled={create.isPending || !suggestions.length}>{t('project_tasks.select_all', 'Select all')}</SecondaryButton>
                    <SecondaryButton onClick={() => setAll(false)} disabled={create.isPending || !suggestions.length}>{t('project_tasks.select_none', 'Select none')}</SecondaryButton>
                    <span className="flex-1" />
                    <SecondaryButton onClick={onClose} disabled={busy}>{t('project_content.cancel', 'Cancel')}</SecondaryButton>
                    <PrimaryButton onClick={submit} busy={busy} disabled={!chosen.length && !updating.length} data-testid="meeting-tasks-create" aria-describedby={`${ids}-hint`}>
                        {updating.length && !chosen.length
                            ? t('project_tasks.update_n', 'Improve {count} tasks', { count: updating.length })
                            : updating.length
                                ? t('project_tasks.make_and_update_n', 'Make {made} tasks and improve {updated}', { made: chosen.length, updated: updating.length })
                                : t('project_tasks.make_n', 'Make {count} tasks', { count: chosen.length })}
                    </PrimaryButton>
                </div>
            )}>
            {query.isPending && <LoadingRow label={t('project_tasks.loading_items', 'Reading the action items…')} />}
            {query.isError && <Notice tone="error" role="alert">{t('project_tasks.suggestions_failed', 'Could not read the action items of this meeting.')}</Notice>}
            {query.data && suggestions.length === 0 && (
                <p className="m-0 text-sm text-[var(--text-tertiary)]">{t('project_tasks.no_action_items', 'This meeting has no action items.')}</p>
            )}
            {suggestions.length > 0 && (
                <>
                    <p id={`${ids}-hint`} className="m-0 mb-3 text-[12.5px] text-[var(--text-tertiary)]">
                        {t('project_tasks.review_hint', 'Check the items that should become tasks. Each task links back to the meeting.')}
                    </p>
                    {nothingNew && (
                        <p className="m-0 mb-3 text-[12.5px] text-[var(--text-secondary)]" data-testid="all-already-tasks">
                            {t('project_tasks.all_already', 'Every open action item is already a task. When the AI has answered you can tick one to let it improve that task: a fuller description, labels, steps and who it is for.')}
                        </p>
                    )}
                    {improve.isPending && (
                        <p className="m-0 mb-3 inline-flex items-center gap-1.5 text-[12.5px] text-[var(--accent-primary)]" role="status" data-testid="ai-improving">
                            <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />{t('project_tasks.ai_improving', 'The AI is filling in descriptions, labels and who it is for…')}
                        </p>
                    )}
                    {improve.isError && (
                        <p className="m-0 mb-3 text-[12.5px] text-[var(--text-tertiary)]" role="status" data-testid="ai-improve-failed">
                            {t('project_tasks.ai_failed', 'The AI could not expand these. You can still make them as they are, or try again.')}
                        </p>
                    )}
                    <ul className="list-none m-0 p-0 space-y-2" aria-label={t('project_tasks.suggestions', 'Action items')}>
                        {suggestions.map(s => rows[s.itemId] && (
                            <SuggestionRow key={s.itemId} s={s} row={rows[s.itemId]} people={people}
                                onChange={patch => setRows(prev => ({ ...prev, [s.itemId]: { ...prev[s.itemId], ...patch } }))} />
                        ))}
                    </ul>
                </>
            )}
            <ErrorText>{error || ''}</ErrorText>
        </Modal>
    );
}

export default function MeetingTasksDialog(props: MeetingTasksDialogProps) {
    const { t } = useTranslation();
    const [picked, setPicked] = useState<string | null>(props.meetingId ?? null);
    if (picked) return <Suggestions {...props} meetingId={picked} />;
    return (
        <Modal open onClose={props.onClose} size="md" title={t('project_tasks.from_meeting_title', 'Tasks from the meeting')}
            description={t('project_tasks.pick_meeting', 'Choose a meeting')}
            footer={<SecondaryButton onClick={props.onClose}>{t('project_content.cancel', 'Cancel')}</SecondaryButton>}>
            <MeetingPicker projectId={props.projectId} onPick={setPicked} />
        </Modal>
    );
}
