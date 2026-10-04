// Make tasks from the action items of a meeting note: every item is a
// suggestion with a tick, a title, who it is for (the member the note's name
// points at, when it points at one), a due date and a priority. Items that
// already became a task are shown and left alone. Nothing is created until
// the person confirms.

import { Loader2, Mic, Sparkles } from 'lucide-react';
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
    useCreateTasksBatch, useImproveMeetingTasks, useMeetingTaskSuggestions, useProjectTasksQuery, useUpdateTask,
    type MeetingTaskImprovement, type MeetingTaskSuggestion, type ProjectTask, type TaskInput,
} from '../../../../api/queries/projectTasks';
import { useProjectResourcesQuery } from '../../../../api/queries/projects';
import useTranslation, { type TranslateFn } from '../../../../hooks/useTranslation';
import Modal from '../../../shared/Modal';
import { toast } from '../../../shared/Toast';
import { useChatPeople } from '../chat/chatPeople';
import { projectErrorText } from '../projectErrorText';
import type { WorkspaceUser } from '../types';
import { ErrorText, LoadingRow, Notice, PrimaryButton, SecondaryButton } from '../workspaceUi';
import MeetingSuggestionRow, { NOBODY, type Row } from './MeetingSuggestionRow';
import { CHIP_CLASS } from './TaskFields';
import { GHOST_ACTION } from './taskDialogParts';

export interface MeetingTasksDialogProps {
    projectId: string;
    currentUser: WorkspaceUser | null;
    /** The meeting to take action items from; absent asks which one. */
    meetingId?: string | null;
    onClose: () => void;
    /** After the tasks were made. */
    onCreated?: (count: number) => void;
}

/** What the AI adds to a task that exists: the description goes in front of what is there, what the person set stays. */
function improvedPatch(task: ProjectTask, row: Row): Partial<TaskInput> {
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
function mergeImprovement(row: Row, imp: MeetingTaskImprovement): Row {
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
    if (!meetings.length) return <p className="m-0 py-6 text-center text-[12.5px] text-[var(--text-tertiary)]">{t('project_tasks.no_meetings', 'No meetings in this project yet. Record or upload one in the Meetings tab.')}</p>;
    return (
        <ul className="list-none m-0 p-0 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] divide-y divide-[var(--border-subtle)] overflow-hidden" aria-label={t('project_tasks.pick_meeting', 'Choose a meeting')}>
            {meetings.map(m => (
                <li key={m.id}>
                    <button type="button" onClick={() => onPick(m.id)} data-testid={`pick-meeting-${m.id}`}
                        className="w-full flex items-center gap-3 h-10 px-3 text-left hover:bg-[var(--item-hover-bg)] focus-visible:bg-[var(--item-hover-bg)] outline-none transition-colors">
                        <Mic className="w-3.5 h-3.5 flex-none text-[var(--kind-meet)]" aria-hidden="true" />
                        <span className="flex-1 min-w-0 truncate text-[13px] font-medium text-[var(--text-primary)]">{m.title || m.name || t('project_content.meeting_untitled', 'Untitled meeting')}</span>
                        {typeof m.actionItemCount === 'number' && (
                            <span className="flex-none text-[11.5px] text-[var(--text-tertiary)] tabular-nums">{t('project_tasks.action_items', '{count} action items', { count: m.actionItemCount })}</span>
                        )}
                    </button>
                </li>
            ))}
        </ul>
    );
}

/** One line above the list: what to do (or that everything is a task already), and what the AI is doing. */
function StatusLine({ hintId, nothingNew, improve, onRetry }: {
    hintId: string; nothingNew: boolean; improve: { isPending: boolean; isError: boolean; isSuccess: boolean }; onRetry: () => void;
}) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mb-3 min-h-6">
            {nothingNew
                ? <p id={hintId} className="m-0 flex-1 min-w-0 text-[12px] text-[var(--text-secondary)]" data-testid="all-already-tasks"
                    title={t('project_tasks.all_already', 'Every open action item is already a task. When the AI has answered you can tick one to let it improve that task: a fuller description, labels, steps and who it is for.')}>
                    {t('project_tasks.all_already_short', 'Every open item is already a task. Tick one to let the AI improve it.')}
                </p>
                : <p id={hintId} className="m-0 flex-1 min-w-0 text-[12px] text-[var(--text-tertiary)]">{t('project_tasks.review_hint', 'Check the items that should become tasks. Each task links back to the meeting.')}</p>}
            {improve.isPending && (
                <span className={`${CHIP_CLASS} bg-[var(--bg-secondary)] text-[var(--text-secondary)]`} role="status" data-testid="ai-improving" title={t('project_tasks.ai_improving', 'The AI is filling in descriptions, labels and who it is for…')}>
                    <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />{t('project_tasks.ai_working', 'Improving…')}
                </span>
            )}
            {improve.isError && (
                <span className="inline-flex items-center gap-1" role="status" data-testid="ai-improve-failed">
                    <span className={`${CHIP_CLASS} bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning-ink)]`} title={t('project_tasks.ai_failed', 'The AI could not expand these. You can still make them as they are, or try again.')}>
                        {t('project_tasks.ai_failed_short', 'The AI couldn’t expand these')}
                    </span>
                    <button type="button" onClick={onRetry} className={GHOST_ACTION}>{t('project_tasks.try_again', 'Try again')}</button>
                </span>
            )}
            {improve.isSuccess && (
                <span className={`${CHIP_CLASS} bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-[var(--success-ink)]`} role="status">
                    <Sparkles className="w-3 h-3" aria-hidden="true" />{t('project_tasks.ai_improved', 'Improved')}
                </span>
            )}
        </div>
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
        <Modal open onClose={onClose} size="lg" className="overflow-hidden" disableEscapeClose={busy}
            title={t('project_tasks.from_meeting_title', 'Tasks from the meeting')}
            description={query.data?.meeting.title || undefined}
            footer={(
                <div className="flex items-center gap-2 w-full">
                    <button type="button" onClick={improveNow} disabled={busy || improve.isPending || !suggestions.length} data-testid="meeting-tasks-improve" className={`${GHOST_ACTION} h-8 px-2`}>
                        {improve.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />}
                        {t('project_tasks.improve_with_ai', 'Improve with AI')}
                    </button>
                    <span className="flex-1" />
                    <SecondaryButton onClick={onClose} disabled={busy}>{t('project_content.cancel', 'Cancel')}</SecondaryButton>
                    <PrimaryButton onClick={submit} busy={busy} disabled={!chosen.length && !updating.length} data-testid="meeting-tasks-create" aria-describedby={`${ids}-hint`}>
                        {createLabel(t, chosen.length, updating.length)}
                    </PrimaryButton>
                </div>
            )}>
            {query.isPending && <LoadingRow label={t('project_tasks.loading_items', 'Reading the action items…')} />}
            {query.isError && <Notice tone="error" role="alert">{t('project_tasks.suggestions_failed', 'Could not read the action items of this meeting.')}</Notice>}
            {query.data && suggestions.length === 0 && (
                <p className="m-0 py-6 text-center text-[12.5px] text-[var(--text-tertiary)]">{t('project_tasks.no_action_items', 'This meeting has no action items.')}</p>
            )}
            {suggestions.length > 0 && (
                <>
                    <StatusLine hintId={`${ids}-hint`} nothingNew={nothingNew} improve={improve} onRetry={improveNow} />
                    <SuggestionList suggestions={suggestions} rows={rows} people={people} disabled={create.isPending}
                        onAll={setAll} onRow={(id, patch) => setRows(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }))} />
                </>
            )}
            <div className="mt-2"><ErrorText>{error || ''}</ErrorText></div>
        </Modal>
    );
}

/** What the primary button says: make, improve, or both. */
function createLabel(t: TranslateFn, made: number, updated: number): string {
    if (updated && !made) return t('project_tasks.update_n', 'Improve {count} tasks', { count: updated });
    if (updated) return t('project_tasks.make_and_update_n', 'Make {made} tasks and improve {updated}', { made, updated });
    return t('project_tasks.make_n', 'Make {count} tasks', { count: made });
}

/** The items as one divided list, with a header row that ticks all or none. */
function SuggestionList({ suggestions, rows, people, disabled, onAll, onRow }: {
    suggestions: MeetingTaskSuggestion[];
    rows: Record<string, Row>;
    people: React.ComponentProps<typeof MeetingSuggestionRow>['people'];
    disabled: boolean;
    onAll: (selected: boolean) => void;
    onRow: (id: string, patch: Partial<Row>) => void;
}) {
    const { t } = useTranslation();
    const all = useRef<HTMLInputElement>(null);
    // Only the items that can be ticked count: one already made is tickable once the AI improved it.
    const tickable = suggestions.filter(s => rows[s.itemId] && (!s.createdTaskId || rows[s.itemId].improved));
    const ticked = tickable.filter(s => rows[s.itemId].selected).length;
    const allOn = tickable.length > 0 && ticked === tickable.length;
    useEffect(() => { if (all.current) all.current.indeterminate = ticked > 0 && !allOn; }, [ticked, allOn]);
    return (
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] overflow-hidden">
            <div className="flex items-center gap-3 h-9 px-3 border-b border-[var(--border-subtle)]">
                <input ref={all} type="checkbox" checked={allOn} disabled={disabled || !tickable.length} onChange={() => onAll(!allOn)}
                    aria-label={allOn ? t('project_tasks.select_none', 'Select none') : t('project_tasks.select_all', 'Select all')}
                    className="flex-none accent-[var(--accent-primary)]" />
                <span className="flex-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-tertiary)]">
                    {t('project_tasks.suggestions', 'Action items')}
                    <span className="ml-1.5 font-normal tabular-nums">{suggestions.length}</span>
                </span>
                <span className="text-[11.5px] text-[var(--text-tertiary)] tabular-nums">{t('project_tasks.selected_count', '{count} selected', { count: ticked })}</span>
            </div>
            <ul className="list-none m-0 p-0 divide-y divide-[var(--border-subtle)]" aria-label={t('project_tasks.suggestions', 'Action items')}>
                {suggestions.map(s => rows[s.itemId] && (
                    <MeetingSuggestionRow key={s.itemId} s={s} row={rows[s.itemId]} people={people} onChange={patch => onRow(s.itemId, patch)} />
                ))}
            </ul>
        </div>
    );
}

export default function MeetingTasksDialog(props: MeetingTasksDialogProps) {
    const { t } = useTranslation();
    const [picked, setPicked] = useState<string | null>(props.meetingId ?? null);
    if (picked) return <Suggestions {...props} meetingId={picked} />;
    return (
        <Modal open onClose={props.onClose} size="md" className="overflow-hidden" title={t('project_tasks.from_meeting_title', 'Tasks from the meeting')}
            description={t('project_tasks.pick_meeting', 'Choose a meeting')}
            footer={<SecondaryButton onClick={props.onClose}>{t('project_content.cancel', 'Cancel')}</SecondaryButton>}>
            <MeetingPicker projectId={props.projectId} onPick={setPicked} />
        </Modal>
    );
}
