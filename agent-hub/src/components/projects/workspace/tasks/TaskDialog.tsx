// Make or edit a task, laid out as a document with properties: the title and
// description lead, the checklist, sub-items, relationships, linked resources and
// comments follow as quiet sections, and the planning fields sit in a sidebar
// of label/value rows.

import { ChevronRight, SquareCheck, Trash2, X } from 'lucide-react';
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
    useProjectTasksQuery, type ChecklistItem, type ProjectTask, type TaskInput, type TaskLink, type TaskPatch, type TaskPriority, type TaskStatus,
} from '../../../../api/queries/projectTasks';
import useTranslation from '../../../../hooks/useTranslation';
import Modal from '../../../shared/Modal';
import CommentsPanel from '../../../comments/CommentsPanel';
import { useChatPeople } from '../chat/chatPeople';
import type { ProjectRole } from '../../../../api/queries/projects';
import type { WorkspaceUser } from '../types';
import { ErrorText, GhostButton, PrimaryButton, SecondaryButton } from '../workspaceUi';
import { ChecklistEditor, MAX_LABELS, TypeIcon, typeLabel } from './TaskFields';
import TaskProperties from './TaskProperties';
import { LinkedResources, RelatedTasks, SubItems } from './TaskRelations';
import TaskDescription, { useImproveIntoForm } from './TaskDescription';
import { ICON_BUTTON, SectionHeader, useAutoGrow } from './taskDialogParts';
import { canContainWorkItem, retainSprintLabels, sprintName, storyPoints, workItemType, visibleLabels, type WorkItemType } from './taskPlanning';
import './projectTasks.css';

const MAX_TITLE = 200;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The fields of `next` that differ from the task as it was opened. */
function changedFields(was: ProjectTask, next: TaskInput): TaskPatch {
    const changes: TaskPatch = {};
    (Object.keys(next) as (keyof TaskInput)[]).forEach((k) => {
        if (k === 'source') return;
        // The dialog shows the planning fields the way the reader sees them:
        // derived from the labels when the column is empty. Compare against
        // that same view, or opening and saving unchanged would "change" them.
        const held = k === 'itemType' ? workItemType(was)
            : k === 'storyPoints' ? storyPoints(was)
            : k === 'parentTaskId' ? (was.parentTaskId ?? null)
            : k === 'startDate' ? (was[k] ?? null) : was[k];
        if (!same(next[k], held)) (changes as Record<string, unknown>)[k] = next[k];
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
    /** The type a new work item starts as (quick-create preset; the selector can still change it). */
    initialItemType?: WorkItemType;
    /** The parent a new work item starts under ("Add child" in the hierarchy view). */
    initialParentTaskId?: string | null;
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

/** The items above this one, outermost first (Epic › Story), for the dialog's header. */
function ancestorsOf(tasks: ProjectTask[], parentId: string | null): ProjectTask[] {
    const trail: ProjectTask[] = [];
    let at = parentId ? tasks.find(item => item.id === parentId) : undefined;
    while (at && trail.length < 5 && !trail.some(item => item.id === at?.id)) {
        trail.unshift(at);
        const up: string | null = at.parentTaskId || null;
        at = up ? tasks.find(item => item.id === up) : undefined;
    }
    return trail;
}

/** The header: where the item sits (Epic › Story ›) and what it is, in meta type. Screen readers hear the dialog's name. */
function TaskHeading({ name, itemType, trail, editing }: { name: string; itemType: WorkItemType; trail: ProjectTask[]; editing: boolean }) {
    const { t } = useTranslation();
    return (
        <>
            <span className="sr-only">{name}</span>
            <span aria-hidden="true" className="flex items-center gap-1 min-w-0 text-[12px] font-normal text-[var(--text-tertiary)]">
                {trail.map(item => (
                    <React.Fragment key={item.id}>
                        <TypeIcon type={workItemType(item)} className="w-3 h-3" />
                        <span className="truncate max-w-[10rem]">{item.title}</span>
                        <ChevronRight className="w-3 h-3 flex-none" />
                    </React.Fragment>
                ))}
                {itemType === 'task' ? <SquareCheck className="w-3 h-3 flex-none" /> : <TypeIcon type={itemType} className="w-3 h-3" />}
                <span className="flex-none font-medium text-[var(--text-secondary)]">{editing ? typeLabel(t, itemType) : name}</span>
            </span>
        </>
    );
}

/** Everything that may be the parent of an item of this type: not itself, nothing inside it, and only a type that can hold it. */
function useParentOptions(task: ProjectTask | null | undefined, taskPool: ProjectTask[], itemType: WorkItemType) {
    const descendants = useMemo(() => {
        const found = new Set<string>();
        if (!task) return found;
        let frontier = [task.id];
        while (frontier.length) {
            const next = taskPool.filter(candidate => frontier.includes(candidate.parentTaskId || '') && !found.has(candidate.id));
            next.forEach(candidate => found.add(candidate.id));
            frontier = next.map(candidate => candidate.id);
        }
        return found;
    }, [task, taskPool]);
    return taskPool.filter(candidate => candidate.id !== task?.id && !descendants.has(candidate.id) && canContainWorkItem(workItemType(candidate), itemType));
}

/**
 * Closing with unsaved changes does not open a second dialog over this one: the
 * action waits in `pending` and the dialog shows an inline Save / Discard bar.
 * The page being left is guarded by the browser's own prompt.
 */
function useDirtyGuard(dirty: boolean, canEdit: boolean, busy: boolean, onClose: () => void) {
    const [pending, setPending] = useState<(() => void) | null>(null);
    useEffect(() => {
        if (!dirty || !canEdit) return undefined;
        const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
        window.addEventListener('beforeunload', guard);
        return () => window.removeEventListener('beforeunload', guard);
    }, [dirty, canEdit]);
    const requestClose = (action: () => void = onClose) => {
        if (busy) return;
        if (canEdit && dirty) { setPending(() => action); return; }
        action();
    };
    return { requestClose, pending, keepEditing: () => setPending(null) };
}

/** The bar that replaces a confirm: what to do with the unsaved changes. */
function UnsavedBar({ formId, busy, onDiscard, onKeep }: { formId: string; busy: boolean; onDiscard: () => void; onKeep: () => void }) {
    const { t } = useTranslation();
    return (
        <div role="alert" data-testid="task-unsaved-bar" className="flex items-center gap-2 w-full px-3 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-default)]">
            <span className="flex-1 min-w-0 text-[13px] text-[var(--text-primary)]">{t('project_home.unsaved_changes', 'Unsaved changes')}</span>
            <GhostButton onClick={onKeep} disabled={busy}>{t('project_tasks.keep_editing', 'Keep editing')}</GhostButton>
            <SecondaryButton onClick={onDiscard} disabled={busy} data-testid="task-unsaved-discard">{t('project_home.discard', 'Discard')}</SecondaryButton>
            <PrimaryButton type="submit" form={formId} busy={busy} data-testid="task-unsaved-save">{t('project_chat.save', 'Save')}</PrimaryButton>
        </div>
    );
}

export default function TaskDialog(props: TaskDialogProps) {
    const { projectId, currentUser, task, canEdit, busy, error, onClose, onSubmit, onDelete, onOpenLink } = props;
    const { t } = useTranslation();
    const ids = useId();
    const people = useChatPeople(projectId, currentUser).people;
    const taskPool = useProjectTasksQuery(projectId).data?.tasks || [];
    const [title, setTitle] = useState(task?.title ?? props.initialTitle ?? '');
    const [description, setDescription] = useState(task?.description ?? props.initialDescription ?? '');
    const [status, setStatus] = useState<TaskStatus>(task?.status ?? 'todo');
    const [assigneeIds, setAssigneeIds] = useState<string[]>(task?.assigneeIds ?? []);
    const [startDate, setStartDate] = useState(task?.startDate ?? '');
    const [dueDate, setDueDate] = useState(task?.dueDate ?? '');
    const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? 'normal');
    const [labels, setLabels] = useState<string[]>(task?.labels ?? []);
    const [itemType, setItemType] = useState<WorkItemType>(task ? workItemType(task) : props.initialItemType || 'task');
    const [points, setPoints] = useState<number | null>(task ? storyPoints(task) : null);
    const [parentTaskId, setParentTaskId] = useState<string | null>(task ? task.parentTaskId || null : props.initialParentTaskId || null);
    const [checklist, setChecklist] = useState<ChecklistItem[]>(task?.checklist ?? []);
    const [links, setLinks] = useState<TaskLink[]>(task?.links ?? props.initialLinks ?? []);
    const clean = title.trim();
    const titleRef = useAutoGrow(title);
    const ai = useImproveIntoForm(projectId, task, description, { setDescription, setPriority, setLabels, setChecklist, setAssigneeIds });
    const openedAs = useRef(task);
    const locked = !canEdit || busy;
    const parentOptions = useParentOptions(task, taskPool, itemType);

    const userLabels = visibleLabels(labels);
    const plannedLabels = retainSprintLabels(labels, userLabels);
    const labelsOverflow = plannedLabels.length > MAX_LABELS;
    const input: TaskInput = { title: clean, description, status, priority, itemType, parentTaskId, storyPoints: points, labels: plannedLabels, checklist, assigneeIds, links, startDate: startDate || null, dueDate: dueDate || null };
    const initial = useRef(JSON.stringify(input));
    const { requestClose, pending, keepEditing } = useDirtyGuard(JSON.stringify(input) !== initial.current, canEdit, busy, onClose);
    const invalidDates = !!(startDate && dueDate && startDate > dueDate);
    const newTitles: Record<WorkItemType, string> = {
        epic: t('project_tasks.new_epic', 'New epic'),
        story: t('project_tasks.new_story', 'New story'),
        'user-story': t('project_tasks.new_user_story', 'New user story'),
        task: t('project_tasks.new_title', 'New task'),
    };
    const submit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!clean || locked || invalidDates) return;
        onSubmit(input, openedAs.current ? changedFields(openedAs.current, input) : input);
    };
    const openLink = onOpenLink ? (l: TaskLink) => requestClose(() => onOpenLink(l)) : undefined;
    const changeType = (nextType: WorkItemType) => {
        setItemType(nextType);
        if (parentTaskId && !taskPool.some(option => option.id === parentTaskId && canContainWorkItem(workItemType(option), nextType))) setParentTaskId(null);
    };
    const trail = ancestorsOf(taskPool, parentTaskId);
    const name = task ? t('project_tasks.edit_title', 'Task') : newTitles[itemType];

    return (
        <Modal open onClose={() => requestClose()} size="auto" className="project-task-dialog max-w-[960px] overflow-hidden" disableEscapeClose={busy} disableBackdropClose={busy}
            headerActions={(
                <button type="button" onClick={() => requestClose()} disabled={busy} className={`${ICON_BUTTON} -my-1`} aria-label={t('project_tasks.close', 'Close')} title={t('project_tasks.close', 'Close')}>
                    <X className="w-4 h-4" aria-hidden="true" />
                </button>
            )}
            title={<TaskHeading name={name} itemType={itemType} trail={trail} editing={!!task} />}
            footer={(
                <div className="flex flex-col gap-2 w-full">
                    {pending && <UnsavedBar formId={`${ids}-form`} busy={busy} onDiscard={pending} onKeep={keepEditing} />}
                    <div className="flex items-center gap-2 w-full">
                    {task && onDelete && canEdit && (
                        <button type="button" onClick={onDelete} disabled={busy} aria-label={t('project_tasks.delete', 'Delete')} title={t('project_tasks.delete', 'Delete')}
                            className={`${ICON_BUTTON} !text-[var(--error-ink)] hover:!bg-[color-mix(in_srgb,var(--error)_10%,transparent)]`}>
                            <Trash2 className="w-4 h-4" aria-hidden="true" />
                        </button>
                    )}
                    <span className="flex-1" />
                    <SecondaryButton onClick={() => requestClose()} disabled={busy}>{canEdit ? t('project_content.cancel', 'Cancel') : t('project_tasks.close', 'Close')}</SecondaryButton>
                    {canEdit && (
                        <PrimaryButton type="submit" form={`${ids}-form`} busy={busy} disabled={!clean || invalidDates || labelsOverflow}>
                            {task ? t('project_chat.save', 'Save') : t('project_tasks.create', 'Create task')}
                        </PrimaryButton>
                    )}
                    </div>
                </div>
            )}>
            <div className="-mx-5 -my-4 grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_260px] min-h-full">
                <div className="min-w-0 p-5 space-y-6">
                    <form id={`${ids}-form`} onSubmit={submit} className="space-y-6">
                        <div>
                            <label htmlFor={`${ids}-title`} className="sr-only">{t('project_tasks.title_label', 'What needs to be done?')}</label>
                            <textarea id={`${ids}-title`} ref={titleRef} rows={1} value={title} maxLength={MAX_TITLE} autoFocus disabled={locked}
                                placeholder={t('project_tasks.title_placeholder', 'Task title')}
                                onKeyDown={(e) => { if (e.key !== 'Enter') return; e.preventDefault(); e.currentTarget.form?.requestSubmit(); }}
                                onChange={e => setTitle(e.target.value.replace(/\n/g, ' '))}
                                className="block w-full resize-none overflow-hidden bg-transparent border-0 p-0 text-[18px] font-semibold leading-snug text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none focus:ring-0 disabled:opacity-100" />
                        </div>
                        <TaskDescription id={`${ids}-desc`} value={description} onChange={setDescription} locked={locked} busy={busy} ai={task && canEdit ? ai : undefined} />
                        {(!locked || checklist.length > 0) && (
                            <section>
                                <SectionHeader title={t('project_tasks.checklist', 'Checklist')} />
                                <ChecklistEditor value={checklist} onChange={setChecklist} disabled={locked} />
                            </section>
                        )}
                        <SubItems task={task} tasks={taskPool} onOpen={openLink} />
                        <RelatedTasks task={task} tasks={taskPool} links={links} onChange={setLinks} onOpen={openLink} disabled={locked} />
                        <LinkedResources projectId={projectId} links={links} onChange={setLinks} onOpen={openLink} disabled={locked} />
                        <ErrorText>{error || ''}</ErrorText>
                    </form>
                    {task && (
                        <section className="pt-4 border-t border-[var(--border-subtle)] -mx-3" aria-label={t('project_tasks.comments', 'Comments')} data-testid="task-comments">
                            <CommentsPanel compact projectId={projectId} targetType="task" targetId={task.id} role={props.role} currentUser={currentUser} className="!bg-transparent !h-auto" />
                        </section>
                    )}
                </div>
                <aside className="min-w-0 p-4 border-t md:border-t-0 md:border-l border-[var(--border-subtle)] bg-[var(--bg-secondary)]/40" aria-label={t('project_tasks.properties', 'Properties')}>
                    <TaskProperties ids={ids} locked={locked} task={task}
                        status={status} onStatus={setStatus} priority={priority} onPriority={setPriority}
                        people={people} assigneeIds={assigneeIds} onAssignees={setAssigneeIds}
                        startDate={startDate} onStartDate={setStartDate} dueDate={dueDate} onDueDate={setDueDate} invalidDates={invalidDates}
                        itemType={itemType} onItemType={changeType} points={points} onPoints={setPoints}
                        parentTaskId={parentTaskId} parentOptions={parentOptions} parent={trail[trail.length - 1] || null} onParent={setParentTaskId}
                        sprint={sprintName({ labels })}
                        labels={userLabels} onLabels={next => setLabels(retainSprintLabels(labels, next))}
                        maxLabels={Math.max(0, MAX_LABELS - (plannedLabels.length - userLabels.length))} labelsOverflow={labelsOverflow}
                        labelSuggestions={props.labelSuggestions} onOpen={openLink} />
                </aside>
            </div>
        </Modal>
    );
}
