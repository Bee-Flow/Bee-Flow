// The property sidebar of the task dialog: one label/value row per field, the
// value a quiet control that reads as text until it is hovered or focused.
// Assignees open a member picker instead of a wall of chips.

import { Check } from 'lucide-react';
import React, { useRef, useState } from 'react';
import { TASK_PRIORITIES, TASK_STATUSES, type ProjectTask, type TaskLink, type TaskPriority, type TaskStatus } from '../../../../api/queries/projectTasks';
import { useTranslation } from '../../../../hooks/useTranslation';
import { Avatar, ErrorText } from '../workspaceUi';
import { LabelsInput, PriorityIcon, TypeIcon, typeLabel } from './TaskFields';
import { workItemType, WORK_ITEM_TYPES, type WorkItemType } from './taskPlanning';
import { priorityLabel, statusLabel } from './taskText';
import { MENU_ITEM, MENU_SEARCH, Popover, PROPERTY_CONTROL } from './taskDialogParts';

const STORY_POINTS = [1, 2, 3, 5, 8, 13, 21];

type Person = { id: string; name: string; avatar?: { type: 'emoji' | 'image' | 'url'; value: string }; color?: string };

const LABEL = 'max-w-[7.5rem] text-[12px] text-[var(--text-tertiary)] truncate';

function Row({ label, htmlFor, children, top = false }: { label: string; htmlFor?: string; children: React.ReactNode; top?: boolean }) {
    return (
        <>
            <div className={`${LABEL} ${top ? 'self-start pt-2' : ''}`} title={label}>{htmlFor ? <label htmlFor={htmlFor}>{label}</label> : label}</div>
            <div className="min-w-0">{children}</div>
        </>
    );
}

/** Who has the task: their faces on a quiet button, and a member list with ticks behind it. */
function AssigneeField({ people, value, onChange, disabled }: { people: Person[]; value: string[]; onChange: (ids: string[]) => void; disabled: boolean }) {
    const { t } = useTranslation();
    const anchor = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState('');
    const chosen = value.map(id => people.find(p => p.id === id)).filter((p): p is Person => !!p);
    const query = search.trim().toLocaleLowerCase();
    const shown = query ? people.filter(p => p.name.toLocaleLowerCase().includes(query)) : people;
    const label = t('project_tasks.assignees', 'Assigned to');
    if (!people.length && !chosen.length) return <span className="block px-2 text-[12.5px] text-[var(--text-tertiary)]">{t('project_tasks.no_people', 'Nobody to give this to yet.')}</span>;
    return (
        <>
            <button ref={anchor} type="button" onClick={() => setOpen(o => !o)} disabled={disabled} aria-haspopup="dialog" aria-expanded={open}
                aria-label={`${label}: ${chosen.length ? chosen.map(p => p.name).join(', ') : t('project_tasks.not_assigned', 'Not assigned')}`}
                className={`${PROPERTY_CONTROL} flex items-center gap-2 text-left`}>
                {chosen.length ? (
                    <>
                        <span className="flex -space-x-1.5 flex-none">
                            {chosen.slice(0, 3).map(p => <Avatar key={p.id} name={p.name} size="sm" picture={p.avatar} color={p.color} className="!w-5 !h-5 !text-[9px] !ring-[var(--bg-card)]" />)}
                        </span>
                        <span className="truncate">{chosen.length === 1 ? chosen[0].name : `${chosen[0].name} +${chosen.length - 1}`}</span>
                    </>
                ) : <span className="text-[var(--text-tertiary)]">{t('project_tasks.not_assigned', 'Not assigned')}</span>}
            </button>
            <Popover open={open} onClose={() => { setOpen(false); setSearch(''); }} anchorRef={anchor} width={248} label={label}>
                {people.length > 8 && (
                    <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder={t('project_tasks.search_people', 'Search people')}
                        aria-label={t('project_tasks.search_people', 'Search people')} className={MENU_SEARCH} />
                )}
                <div role="group" aria-label={label}>
                    {shown.map((p) => {
                        const on = value.includes(p.id);
                        return (
                            <button key={p.id} type="button" aria-pressed={on} className={MENU_ITEM}
                                onClick={() => onChange(on ? value.filter(id => id !== p.id) : [...value, p.id])}>
                                <Avatar name={p.name} size="sm" picture={p.avatar} color={p.color} className="!w-5 !h-5 !text-[9px] ring-0" />
                                <span className="flex-1 truncate">{p.name}</span>
                                {on && <Check className="w-3.5 h-3.5 flex-none text-[var(--accent-primary)]" aria-hidden="true" />}
                            </button>
                        );
                    })}
                </div>
            </Popover>
        </>
    );
}

export interface TaskPropertiesProps {
    ids: string;
    locked: boolean;
    task: ProjectTask | null | undefined;
    status: TaskStatus; onStatus: (s: TaskStatus) => void;
    priority: TaskPriority; onPriority: (p: TaskPriority) => void;
    people: Person[]; assigneeIds: string[]; onAssignees: (ids: string[]) => void;
    startDate: string; onStartDate: (d: string) => void;
    dueDate: string; onDueDate: (d: string) => void;
    invalidDates: boolean;
    itemType: WorkItemType; onItemType: (type: WorkItemType) => void;
    points: number | null; onPoints: (p: number | null) => void;
    parentTaskId: string | null; parentOptions: ProjectTask[]; parent: ProjectTask | null; onParent: (id: string | null) => void;
    sprint: string | null;
    labels: string[]; onLabels: (labels: string[]) => void; maxLabels: number; labelsOverflow: boolean; labelSuggestions?: string[];
    onOpen?: (link: TaskLink) => void;
}

/** When and by whom: status, priority, people and dates. */
function ScheduleRows(p: TaskPropertiesProps) {
    const { t } = useTranslation();
    const { ids, locked } = p;
    const marked = p.priority === 'urgent' || p.priority === 'high';
    return (
        <>
            <Row label={t('project_tasks.status_label', 'Status')} htmlFor={`${ids}-status`}>
                <select id={`${ids}-status`} className={PROPERTY_CONTROL} value={p.status} disabled={locked} onChange={e => p.onStatus(e.target.value as TaskStatus)}>
                    {TASK_STATUSES.map(s => <option key={s} value={s}>{statusLabel(t, s)}</option>)}
                </select>
            </Row>
            <Row label={t('project_tasks.priority_label', 'Priority')} htmlFor={`${ids}-priority`}>
                <span className="relative flex items-center">
                    {marked
                        ? <span className="absolute left-2 flex pointer-events-none"><PriorityIcon priority={p.priority} /></span>
                        : null}
                    <select id={`${ids}-priority`} className={`${PROPERTY_CONTROL} ${marked ? 'pl-7' : ''}`} value={p.priority} disabled={locked}
                        onChange={e => p.onPriority(e.target.value as TaskPriority)}>
                        {TASK_PRIORITIES.map(pr => <option key={pr} value={pr}>{priorityLabel(t, pr)}</option>)}
                    </select>
                </span>
            </Row>
            <Row label={t('project_tasks.assignees', 'Assigned to')}>
                <AssigneeField people={p.people} value={p.assigneeIds} onChange={p.onAssignees} disabled={locked} />
            </Row>
            <Row label={t('project_tasks.start_label', 'Start date')} htmlFor={`${ids}-start`}>
                <input id={`${ids}-start`} form={`${ids}-form`} type="date" max={p.dueDate || undefined} className={`${PROPERTY_CONTROL} tabular-nums ${p.startDate ? '' : 'text-[var(--text-tertiary)]'}`}
                    value={p.startDate} disabled={locked} onChange={e => p.onStartDate(e.target.value)} />
            </Row>
            <Row label={t('project_tasks.due_label', 'Due date')} htmlFor={`${ids}-due`}>
                <input id={`${ids}-due`} form={`${ids}-form`} type="date" min={p.startDate || undefined} aria-invalid={p.invalidDates || undefined}
                    className={`${PROPERTY_CONTROL} tabular-nums ${p.dueDate ? '' : 'text-[var(--text-tertiary)]'} ${p.invalidDates ? '!text-[var(--error-ink)]' : ''}`}
                    value={p.dueDate} disabled={locked} onChange={e => p.onDueDate(e.target.value)} />
            </Row>
            {p.invalidDates && <div className="col-start-2 px-2 pb-1"><ErrorText>{t('project_tasks.invalid_date_range', 'The start date must be on or before the due date.')}</ErrorText></div>}
        </>
    );
}

/** Where it sits in the plan: type, estimate, parent and sprint. */
function PlanningRows(p: TaskPropertiesProps) {
    const { t } = useTranslation();
    const { ids, locked } = p;
    const epic = p.itemType === 'epic';
    const parentLabel = t('project_tasks.parent_work_item', 'Parent work item');
    const parent = p.parent;
    return (
        <>
            <Row label={t('project_tasks.work_item_type', 'Work item type')} htmlFor={`${ids}-type`}>
                <select id={`${ids}-type`} className={PROPERTY_CONTROL} value={p.itemType} disabled={locked} onChange={e => p.onItemType(e.target.value as WorkItemType)}>
                    {WORK_ITEM_TYPES.map(type => <option key={type} value={type}>{typeLabel(t, type)}</option>)}
                </select>
            </Row>
            <Row label={t('project_tasks.story_points', 'Story points')} htmlFor={`${ids}-points`}>
                <select id={`${ids}-points`} className={`${PROPERTY_CONTROL} tabular-nums ${p.points == null ? 'text-[var(--text-tertiary)]' : ''}`} value={p.points ?? ''} disabled={locked}
                    onChange={e => p.onPoints(e.target.value ? Number(e.target.value) : null)}>
                    <option value="">{t('project_tasks.not_estimated', 'Not estimated')}</option>
                    {STORY_POINTS.map(point => <option key={point} value={point}>{point}</option>)}
                </select>
            </Row>
            <Row label={t('project_tasks.parent', 'Parent')} htmlFor={locked ? undefined : `${ids}-parent`}>
                {locked ? (
                    parent ? (
                        <button type="button" onClick={() => p.onOpen?.({ kind: 'task', id: parent.id })} disabled={!p.onOpen}
                            className={`${PROPERTY_CONTROL} !cursor-pointer flex items-center gap-1.5 text-left disabled:!cursor-default`}>
                            <TypeIcon type={workItemType(parent)} /><span className="truncate">{parent.title}</span>
                        </button>
                    ) : <span className="block px-2 text-[13px] text-[var(--text-tertiary)]">—</span>
                ) : (
                    <select id={`${ids}-parent`} aria-label={parentLabel} className={`${PROPERTY_CONTROL} ${p.parentTaskId ? '' : 'text-[var(--text-tertiary)]'}`}
                        value={p.parentTaskId || ''} disabled={epic}
                        title={epic ? t('project_tasks.epics_top_level', 'Epics are top-level') : t('project_tasks.parent_hint', 'Epics contain stories; stories can contain tasks.')}
                        onChange={e => p.onParent(e.target.value || null)}>
                        <option value="">{epic ? t('project_tasks.epics_top_level', 'Epics are top-level') : t('project_tasks.no_parent', 'No parent')}</option>
                        {p.parentOptions.map(option => <option key={option.id} value={option.id}>{option.title} · {typeLabel(t, workItemType(option))}</option>)}
                    </select>
                )}
            </Row>
            {p.sprint && (
                <Row label={t('project_tasks.sprint_label', 'Sprint')}>
                    <span className="block px-2 text-[13px] text-[var(--text-primary)] truncate">{p.sprint}</span>
                </Row>
            )}
        </>
    );
}

const DIVIDER = <div className="col-span-2 my-2 border-t border-[var(--border-subtle)]" role="presentation" />;

export default function TaskProperties(p: TaskPropertiesProps) {
    const { t } = useTranslation();
    return (
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1">
            <ScheduleRows {...p} />
            {DIVIDER}
            <PlanningRows {...p} />
            {DIVIDER}
            <Row label={t('project_tasks.labels', 'Labels')} top>
                <div className="px-2 py-1">
                    <LabelsInput value={p.labels} onChange={p.onLabels} disabled={p.locked} suggestions={p.labelSuggestions} maxLabels={p.maxLabels} />
                    {p.locked && !p.labels.length && <span className="text-[13px] text-[var(--text-tertiary)]">—</span>}
                </div>
            </Row>
            {p.labelsOverflow && <div className="col-start-2 px-2"><ErrorText>{t('project_tasks.labels_overflow', 'Remove a label to make room for this planning information.')}</ErrorText></div>}
        </div>
    );
}
