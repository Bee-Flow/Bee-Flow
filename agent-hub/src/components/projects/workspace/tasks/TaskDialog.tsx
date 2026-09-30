// Make or edit a task: a title, a description, who it is given to, when it is
// due, and what it is about (documents, notebooks, chats, threads).

import { Link2, Sparkles, Trash2, X } from 'lucide-react';
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
    linkKey, TASK_PRIORITIES, TASK_STATUSES, useImproveTask, type ChecklistItem, type ProjectTask, type TaskInput, type TaskLink, type TaskPatch, type TaskPriority, type TaskStatus,
} from '../../../../api/queries/projectTasks';
import useTranslation from '../../../../hooks/useTranslation';
import Modal from '../../../shared/Modal';
import useConfirm from '../../../shared/useConfirm';
import CommentsPanel from '../../../comments/CommentsPanel';
import { useChatPeople } from '../chat/chatPeople';
import type { ProjectRole } from '../../../../api/queries/projects';
import type { WorkspaceUser } from '../types';
import { Avatar, ErrorText, INPUT_CLASS, PrimaryButton, SecondaryButton, SELECT_CLASS } from '../workspaceUi';
import { LINK_ICON, useTaskLinks } from './taskLinks';
import { ChecklistEditor, LabelsInput } from './TaskFields';
import { priorityLabel, statusLabel } from './taskText';

const LABEL = 'block text-[12px] font-medium text-[var(--text-secondary)] mb-1';
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 20000;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The fields of `next` that differ from the task as it was opened. */
export function changedFields(was: ProjectTask, next: TaskInput): TaskPatch {
    const changes: TaskPatch = {};
    (Object.keys(next) as (keyof TaskInput)[]).forEach((k) => {
        if (k === 'source') return;
        if (!same(next[k], k === 'startDate' ? (was[k] ?? null) : was[k])) (changes as Record<string, unknown>)[k] = next[k];
    });
    return changes;
}

export interface TaskDialogProps {
    projectId: string;
    currentUser: WorkspaceUser | null;
    /** Editing this task; absent makes a new one. */
    task?: ProjectTask | null;
    /** Links a new task starts with (e.g. the chat or thread it was made from). */
    initialLinks?: TaskLink[];
    initialTitle?: string;
    initialDescription?: string;
    role: ProjectRole | null;
    canEdit: boolean;
    busy: boolean;
    error: string | null;
    onClose: () => void;
    /** `input` is the whole form; `changes` only what differs from the task as it was opened (what an edit sends, so a colleague's change to another field survives). */
    onSubmit: (input: TaskInput, changes: TaskPatch) => void;
    onDelete?: () => void;
    onOpenLink?: (link: TaskLink) => void;
    /** Labels already used in the project, offered while typing. */
    labelSuggestions?: string[];
}

function AssigneePicker({ people, value, onChange, disabled }: {
    people: { id: string; name: string; avatar?: { type: 'emoji' | 'image' | 'url'; value: string }; color?: string }[];
    value: string[];
    onChange: (ids: string[]) => void;
    disabled: boolean;
}) {
    const { t } = useTranslation();
    if (!people.length) return <p className="m-0 text-[12px] text-[var(--text-tertiary)]">{t('project_tasks.no_people', 'Nobody to give this to yet.')}</p>;
    return (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('project_tasks.assignees', 'Assigned to')}>
            {people.map((p) => {
                const on = value.includes(p.id);
                return (
                    <button key={p.id} type="button" disabled={disabled} aria-pressed={on}
                        onClick={() => onChange(on ? value.filter(id => id !== p.id) : [...value, p.id])}
                        className={`inline-flex items-center gap-1.5 pl-1 pr-2.5 py-1 rounded-full border text-[12.5px] transition-colors ${on
                            ? 'border-[var(--accent-primary)] bg-[var(--item-active-bg)] text-[var(--text-primary)]'
                            : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)]'}`}>
                        <Avatar name={p.name} size="sm" picture={p.avatar} color={p.color} className="ring-0" />
                        {p.name}
                    </button>
                );
            })}
        </div>
    );
}

function LinkList({ projectId, links, onChange, onOpen, disabled }: {
    projectId: string; links: TaskLink[]; onChange: (links: TaskLink[]) => void; onOpen?: (l: TaskLink) => void; disabled: boolean;
}) {
    const { t } = useTranslation();
    const { options, labelOf } = useTaskLinks(projectId);
    const held = new Set(links.map(linkKey));
    const addable = options.filter(o => !held.has(linkKey(o.link)));
    const groups: [TaskLink['kind'], string][] = [
        ['document', t('project_tasks.link_documents', 'Documents')],
        ['notebook', t('project_tasks.link_notebooks', 'Notebooks')],
        ['meeting', t('project_tasks.link_meetings', 'Meetings')],
        ['chat', t('project_tasks.link_chats', 'Chats')],
    ];
    return (
        <div className="space-y-2">
            {links.length > 0 && (
                <ul className="list-none m-0 p-0 flex flex-wrap gap-1.5">
                    {links.map((l) => {
                        const Icon = LINK_ICON[l.kind];
                        return (
                            <li key={linkKey(l)} className="inline-flex items-center max-w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[12.5px]">
                                <button type="button" onClick={() => onOpen?.(l)} disabled={!onOpen}
                                    className="inline-flex items-center gap-1.5 min-w-0 pl-2 pr-1.5 py-1 text-[var(--text-primary)] hover:text-[var(--accent-primary)]">
                                    <Icon className="w-3.5 h-3.5 flex-shrink-0 text-[var(--accent-primary)]" aria-hidden="true" />
                                    <span className="truncate">{labelOf(l)}</span>
                                </button>
                                {!disabled && (
                                    <button type="button" onClick={() => onChange(links.filter(x => linkKey(x) !== linkKey(l)))}
                                        aria-label={t('project_tasks.remove_link', 'Remove link')}
                                        className="grid place-items-center w-6 h-6 mr-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
                                        <X className="w-3 h-3" aria-hidden="true" />
                                    </button>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
            {!disabled && (
                <div className="flex items-center gap-2">
                    <Link2 className="w-3.5 h-3.5 text-[var(--text-tertiary)]" aria-hidden="true" />
                    <select className={`${SELECT_CLASS} flex-1 min-w-0`} value="" aria-label={t('project_tasks.add_link', 'Link a document, notebook or chat')}
                        onChange={(e) => {
                            const picked = addable.find(o => linkKey(o.link) === e.target.value);
                            if (picked) onChange([...links, picked.link]);
                        }}>
                        <option value="">{addable.length ? t('project_tasks.add_link', 'Link a document, notebook or chat') : t('project_tasks.nothing_to_link', 'Nothing left to link')}</option>
                        {groups.map(([kind, label]) => {
                            const of = addable.filter(o => o.link.kind === kind);
                            return of.length ? (
                                <optgroup key={kind} label={label}>
                                    {of.map(o => <option key={linkKey(o.link)} value={linkKey(o.link)}>{o.label}</option>)}
                                </optgroup>
                            ) : null;
                        })}
                    </select>
                </div>
            )}
        </div>
    );
}

export default function TaskDialog(props: TaskDialogProps) {
    const { projectId, currentUser, task, canEdit, busy, error, onClose, onSubmit, onDelete, onOpenLink } = props;
    const { t } = useTranslation();
    const ids = useId();
    const people = useChatPeople(projectId, currentUser).people;
    const [title, setTitle] = useState(task?.title ?? props.initialTitle ?? '');
    const [description, setDescription] = useState(task?.description ?? props.initialDescription ?? '');
    const [status, setStatus] = useState<TaskStatus>(task?.status ?? 'todo');
    const [assigneeIds, setAssigneeIds] = useState<string[]>(task?.assigneeIds ?? []);
    const [startDate, setStartDate] = useState(task?.startDate ?? '');
    const [dueDate, setDueDate] = useState(task?.dueDate ?? '');
    const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? 'normal');
    const [labels, setLabels] = useState<string[]>(task?.labels ?? []);
    const [checklist, setChecklist] = useState<ChecklistItem[]>(task?.checklist ?? []);
    const [links, setLinks] = useState<TaskLink[]>(task?.links ?? props.initialLinks ?? []);
    const clean = title.trim();
    const improve = useImproveTask(projectId);
    const [aiNote, setAiNote] = useState<string | null>(null);
    // The description as it was when the task was opened, and as it is now (the AI answers later than the click).
    const openedAs = useRef(task);
    const descriptionNow = useRef(description);
    descriptionNow.current = description;
    const [suggestedDescription, setSuggestedDescription] = useState<string | null>(null);
    // The AI's suggestion fills the form; nothing is saved until the person saves. What they wrote stays:
    // a description they changed is not replaced, the suggestion is offered next to it.
    const improveNow = () => {
        if (!task) return;
        setAiNote(null);
        setSuggestedDescription(null);
        improve.mutate(task.id, {
            onSuccess: (s) => {
                if (s.description) {
                    const typed = descriptionNow.current;
                    if (!typed.trim() || typed === (openedAs.current?.description ?? '')) setDescription(s.description);
                    else if (s.description !== typed) setSuggestedDescription(s.description);
                }
                setPriority(prev => (prev !== 'normal' ? prev : s.priority));
                setLabels(prev => [...prev, ...s.labels.filter(l => !prev.some(p => p.toLowerCase() === l))].slice(0, 20));
                setChecklist(prev => (prev.length ? prev : s.checklist));
                if (s.assigneeId) setAssigneeIds(prev => (prev.length ? prev : [s.assigneeId as string]));
                setAiNote(t('project_tasks.ai_suggested', 'The AI filled in suggestions. Read them, change what you like, and save.'));
            },
        });
    };
    const locked = !canEdit || busy;
    const pool = useMemo(() => people, [people]);

    const { confirm, confirmDialog } = useConfirm();
    const input: TaskInput = { title: clean, description, status, priority, labels, checklist, assigneeIds, links, startDate: startDate || null, dueDate: dueDate || null };
    const initial = useRef(JSON.stringify(input));
    const dirty = JSON.stringify(input) !== initial.current;
    useEffect(() => {
        if (!dirty || !canEdit) return;
        const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
        window.addEventListener('beforeunload', guard);
        return () => window.removeEventListener('beforeunload', guard);
    }, [dirty, canEdit]);
    const invalidDates = !!(startDate && dueDate && startDate > dueDate);
    const requestClose = async (action = onClose) => {
        if (busy) return;
        if (canEdit && dirty && !await confirm({ title: t('project_tasks.discard_title', 'Discard task changes?'), description: t('project_tasks.discard_hint', 'Your unsaved changes to this task will be lost.'), confirmLabel: t('project_tasks.discard', 'Discard changes'), cancelLabel: t('project_tasks.keep_editing', 'Keep editing'), destructive: true })) return;
        action();
    };
    const submit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!clean || locked || invalidDates) return;
        onSubmit(input, openedAs.current ? changedFields(openedAs.current, input) : input);
    };

    return (
        <><Modal open onClose={() => void requestClose()} size="auto" className="max-w-[1040px]" disableEscapeClose={busy} disableBackdropClose={busy}
            headerActions={<button type="button" onClick={() => void requestClose()} disabled={busy} className="p-1.5 rounded-lg hover:bg-[var(--item-hover-bg)]" aria-label={t('project_tasks.close', 'Close')}><X className="w-4 h-4" /></button>}
            title={task ? t('project_tasks.edit_title', 'Task') : t('project_tasks.new_title', 'New task')}
            footer={(
                <div className="flex items-center gap-2 w-full">
                    {task && onDelete && canEdit && (
                        <SecondaryButton onClick={onDelete} disabled={busy} className="!text-[var(--error-ink)] mr-auto">
                            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />{t('project_tasks.delete', 'Delete')}
                        </SecondaryButton>
                    )}
                    <span className="flex-1" />
                    <SecondaryButton onClick={() => void requestClose()} disabled={busy}>{canEdit ? t('project_content.cancel', 'Cancel') : t('project_tasks.close', 'Close')}</SecondaryButton>
                    {canEdit && (
                        <PrimaryButton type="submit" form={`${ids}-form`} busy={busy} disabled={!clean || invalidDates}>
                            {task ? t('project_chat.save', 'Save') : t('project_tasks.create', 'Create task')}
                        </PrimaryButton>
                    )}
                </div>
            )}>
            <form id={`${ids}-form`} onSubmit={submit} className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_280px] gap-6">
                <div className="space-y-5 min-w-0">
                <div>
                    <label htmlFor={`${ids}-title`} className={LABEL}>{t('project_tasks.title_label', 'What needs to be done?')}</label>
                    <textarea id={`${ids}-title`} rows={2} className={`${INPUT_CLASS} !text-xl !font-semibold !leading-snug resize-y min-h-[76px]`} value={title} maxLength={MAX_TITLE} autoFocus disabled={locked}
                        onChange={e => setTitle(e.target.value)} />
                </div>
                <div>
                    <div className="flex items-center gap-2">
                        <label htmlFor={`${ids}-desc`} className={`${LABEL} !mb-1 flex-1`}>{t('project_tasks.description_label', 'Description')}</label>
                        {task && canEdit && (
                            <button type="button" onClick={improveNow} disabled={improve.isPending || busy} data-testid="task-improve-ai"
                                className="inline-flex items-center gap-1 mb-1 text-[12px] text-[var(--accent-primary)] hover:underline disabled:opacity-50">
                                <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                                {improve.isPending ? t('project_tasks.ai_working', 'Improving…') : t('project_tasks.improve_with_ai', 'Improve with AI')}
                            </button>
                        )}
                    </div>
                    <textarea id={`${ids}-desc`} className={`${INPUT_CLASS} min-h-[190px] resize-y`} value={description} maxLength={MAX_DESCRIPTION} disabled={locked}
                        placeholder={t('project_tasks.description_placeholder', 'Context, steps, what done looks like…')}
                        onChange={e => setDescription(e.target.value)} />
                </div>
                <div>
                    <span className={LABEL}>{t('project_tasks.checklist', 'Checklist')}</span>
                    <ChecklistEditor value={checklist} onChange={setChecklist} disabled={locked} />
                </div>
                <div>
                    <span className={LABEL}>{t('project_tasks.links_label', 'Linked')}</span>
                    <LinkList projectId={projectId} links={links} onChange={setLinks} onOpen={onOpenLink ? l => void requestClose(() => onOpenLink(l)) : undefined} disabled={locked} />
                </div>
                {suggestedDescription && (
                    <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3 space-y-2" data-testid="task-ai-description">
                        <p className="m-0 text-[12px] font-medium text-[var(--text-secondary)]">{t('project_tasks.ai_description_suggestion', 'Suggested description (yours is kept)')}</p>
                        <p className="m-0 text-[12.5px] whitespace-pre-wrap text-[var(--text-primary)]">{suggestedDescription}</p>
                        <div className="flex gap-2">
                            <SecondaryButton onClick={() => { setDescription(suggestedDescription); setSuggestedDescription(null); }} disabled={locked}>{t('project_tasks.ai_use_description', 'Use this description')}</SecondaryButton>
                            <SecondaryButton onClick={() => setSuggestedDescription(null)}>{t('project_tasks.ai_dismiss_description', 'Dismiss')}</SecondaryButton>
                        </div>
                    </div>
                )}
                {aiNote && <p className="m-0 text-[12px] text-[var(--accent-primary)]" role="status" data-testid="task-ai-note">{aiNote}</p>}
                {improve.isError && <p className="m-0 text-[12px] text-[var(--text-tertiary)]" role="status">{t('project_tasks.ai_failed_one', 'The AI could not improve this task right now.')}</p>}
                <ErrorText>{error || ''}</ErrorText>
                </div>
                <aside className="space-y-5 rounded-xl bg-[var(--bg-primary)] border border-[var(--border-subtle)] p-4 self-start min-w-0">
                    <h3 className="m-0 text-sm font-semibold text-[var(--text-primary)]">{t('project_tasks.planning_details', 'Planning & responsibility')}</h3>
                <div className="grid grid-cols-1 gap-4">
                    <div>
                        <label htmlFor={`${ids}-status`} className={LABEL}>{t('project_tasks.status_label', 'Status')}</label>
                        <select id={`${ids}-status`} className={`${SELECT_CLASS} w-full`} value={status} disabled={locked} onChange={e => setStatus(e.target.value as TaskStatus)}>
                            {TASK_STATUSES.map(s => <option key={s} value={s}>{statusLabel(t, s)}</option>)}
                        </select>
                    </div>
                    <div>
                        <label htmlFor={`${ids}-priority`} className={LABEL}>{t('project_tasks.priority_label', 'Priority')}</label>
                        <select id={`${ids}-priority`} className={`${SELECT_CLASS} w-full`} value={priority} disabled={locked} onChange={e => setPriority(e.target.value as TaskPriority)}>
                            {TASK_PRIORITIES.map(p => <option key={p} value={p}>{priorityLabel(t, p)}</option>)}
                        </select>
                    </div>
                    <div>
                        <label htmlFor={`${ids}-start`} className={LABEL}>{t('project_tasks.start_label', 'Start date')}</label>
                        <input id={`${ids}-start`} type="date" max={dueDate || undefined} className={`${SELECT_CLASS} w-full`} value={startDate} disabled={locked} onChange={e => setStartDate(e.target.value)} />
                    </div>
                    <div>
                        <label htmlFor={`${ids}-due`} className={LABEL}>{t('project_tasks.due_label', 'Due date')}</label>
                        <input id={`${ids}-due`} type="date" min={startDate || undefined} className={`${SELECT_CLASS} w-full`} value={dueDate} disabled={locked} onChange={e => setDueDate(e.target.value)} />
                    </div>
                </div>
                <div>
                    <span className={LABEL}>{t('project_tasks.assignees', 'Assigned to')}</span>
                    <AssigneePicker people={pool} value={assigneeIds} onChange={setAssigneeIds} disabled={locked} />
                </div>
                <div>
                    <span className={LABEL}>{t('project_tasks.labels', 'Labels')}</span>
                    <LabelsInput value={labels} onChange={setLabels} disabled={locked} suggestions={props.labelSuggestions} />
                </div>
                    {invalidDates && <ErrorText>{t('project_tasks.invalid_date_range', 'The start date must be on or before the due date.')}</ErrorText>}
                </aside>
            </form>
            {task && (
                <section className="mt-6 pt-4 border-t border-[var(--border-subtle)] md:mr-[304px]" aria-label={t('project_tasks.comments', 'Comments')} data-testid="task-comments">
                    <div className="max-h-[360px] overflow-y-auto custom-scrollbar rounded-xl border border-[var(--border-subtle)]">
                        <CommentsPanel compact projectId={projectId} targetType="task" targetId={task.id} role={props.role} currentUser={currentUser} />
                    </div>
                </section>
            )}
        </Modal>{confirmDialog}</>
    );
}
