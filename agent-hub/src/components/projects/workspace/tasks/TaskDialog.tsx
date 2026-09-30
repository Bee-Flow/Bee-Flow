// Make or edit a task: a title, a description, who it is given to, when it is
// due, and what it is about (documents, notebooks, chats, threads).

import { Link2, Sparkles, Trash2, X } from 'lucide-react';
import React, { useId, useMemo, useState } from 'react';
import {
    linkKey, TASK_PRIORITIES, TASK_STATUSES, useImproveTask, type ChecklistItem, type ProjectTask, type TaskInput, type TaskLink, type TaskPriority, type TaskStatus,
} from '../../../../api/queries/projectTasks';
import useTranslation from '../../../../hooks/useTranslation';
import Modal from '../../../shared/Modal';
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
    onSubmit: (input: TaskInput) => void;
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
    const [dueDate, setDueDate] = useState(task?.dueDate ?? '');
    const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? 'normal');
    const [labels, setLabels] = useState<string[]>(task?.labels ?? []);
    const [checklist, setChecklist] = useState<ChecklistItem[]>(task?.checklist ?? []);
    const [links, setLinks] = useState<TaskLink[]>(task?.links ?? props.initialLinks ?? []);
    const clean = title.trim();
    const improve = useImproveTask(projectId);
    const [aiNote, setAiNote] = useState<string | null>(null);
    // The AI's suggestion fills the form; nothing is saved until the person saves. What they wrote stays.
    const improveNow = () => {
        if (!task) return;
        setAiNote(null);
        improve.mutate(task.id, {
            onSuccess: (s) => {
                if (s.description) setDescription(s.description);
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

    const submit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!clean || locked) return;
        onSubmit({ title: clean, description, status, priority, labels, checklist, assigneeIds, links, dueDate: dueDate || null });
    };

    return (
        <Modal open onClose={onClose} size="md" disableEscapeClose={busy}
            title={task ? t('project_tasks.edit_title', 'Task') : t('project_tasks.new_title', 'New task')}
            footer={(
                <div className="flex items-center gap-2">
                    {task && onDelete && canEdit && (
                        <SecondaryButton onClick={onDelete} disabled={busy} className="!text-[var(--error-ink)] mr-auto">
                            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />{t('project_tasks.delete', 'Delete')}
                        </SecondaryButton>
                    )}
                    <span className="flex-1" />
                    <SecondaryButton onClick={onClose} disabled={busy}>{canEdit ? t('project_content.cancel', 'Cancel') : t('project_tasks.close', 'Close')}</SecondaryButton>
                    {canEdit && (
                        <PrimaryButton type="submit" form={`${ids}-form`} busy={busy} disabled={!clean}>
                            {task ? t('project_chat.save', 'Save') : t('project_tasks.create', 'Create task')}
                        </PrimaryButton>
                    )}
                </div>
            )}>
            <form id={`${ids}-form`} onSubmit={submit} className="space-y-4">
                <div>
                    <label htmlFor={`${ids}-title`} className={LABEL}>{t('project_tasks.title_label', 'What needs to be done?')}</label>
                    <input id={`${ids}-title`} className={INPUT_CLASS} value={title} maxLength={MAX_TITLE} autoFocus disabled={locked}
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
                    <textarea id={`${ids}-desc`} className={`${INPUT_CLASS} min-h-[110px] resize-y`} value={description} maxLength={MAX_DESCRIPTION} disabled={locked}
                        placeholder={t('project_tasks.description_placeholder', 'Context, steps, what done looks like…')}
                        onChange={e => setDescription(e.target.value)} />
                </div>
                <div className="grid grid-cols-3 gap-3">
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
                        <label htmlFor={`${ids}-due`} className={LABEL}>{t('project_tasks.due_label', 'Due date')}</label>
                        <input id={`${ids}-due`} type="date" className={`${SELECT_CLASS} w-full`} value={dueDate} disabled={locked} onChange={e => setDueDate(e.target.value)} />
                    </div>
                </div>
                <div>
                    <span className={LABEL}>{t('project_tasks.labels', 'Labels')}</span>
                    <LabelsInput value={labels} onChange={setLabels} disabled={locked} suggestions={props.labelSuggestions} />
                </div>
                <div>
                    <span className={LABEL}>{t('project_tasks.checklist', 'Checklist')}</span>
                    <ChecklistEditor value={checklist} onChange={setChecklist} disabled={locked} />
                </div>
                <div>
                    <span className={LABEL}>{t('project_tasks.assignees', 'Assigned to')}</span>
                    <AssigneePicker people={pool} value={assigneeIds} onChange={setAssigneeIds} disabled={locked} />
                </div>
                <div>
                    <span className={LABEL}>{t('project_tasks.links_label', 'Linked')}</span>
                    <LinkList projectId={projectId} links={links} onChange={setLinks} onOpen={onOpenLink} disabled={locked} />
                </div>
                {aiNote && <p className="m-0 text-[12px] text-[var(--accent-primary)]" role="status" data-testid="task-ai-note">{aiNote}</p>}
                {improve.isError && <p className="m-0 text-[12px] text-[var(--text-tertiary)]" role="status">{t('project_tasks.ai_failed_one', 'The AI could not improve this task right now.')}</p>}
                <ErrorText>{error || ''}</ErrorText>
            </form>
            {task && (
                <section className="mt-5 pt-4 border-t border-[var(--border-subtle)]" aria-label={t('project_tasks.comments', 'Comments')} data-testid="task-comments">
                    <div className="max-h-[420px] overflow-y-auto custom-scrollbar rounded-xl border border-[var(--border-subtle)]">
                        <CommentsPanel projectId={projectId} targetType="task" targetId={task.id} role={props.role} currentUser={currentUser} />
                    </div>
                </section>
            )}
        </Modal>
    );
}
