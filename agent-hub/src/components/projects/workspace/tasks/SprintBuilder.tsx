// Plan a sprint with the team on one sheet: tick backlog items on the left,
// and keep the plan in a sticky summary on the right (capacity and a suggested
// fill, the running total, one queued poker session for the picks without an
// estimate, and the sprint's name and dates). The poker session opens inline.

import { ArrowLeft, Sparkles, Wand2 } from 'lucide-react';
import React, { useId, useMemo, useState } from 'react';
import { useStartPokerSession, type ProjectTask } from '../../../../api/queries/projectTasks';
import { useAssignSprintItems, useCreateSprint } from '../../../../api/queries/projectSprints';
import { useTranslation } from '../../../../hooks/useTranslation';
import { toast } from '../../../shared/Toast';
import { projectErrorText } from '../projectErrorText';
import { GhostButton, PrimaryButton } from '../workspaceUi';
import type { useChatPeople } from '../chat/chatPeople';
import PokerPanel from './PokerPanel';
import { SPRINT_WEEKS } from './SprintCreateForm';
import { TypeChip } from './TaskFields';
import { addDays, sprintName, storyPoints, workItemType } from './taskPlanning';
import { sprintPlanPoints, suggestSprintItems } from './sprintPlan';
import { Chip, META, pointsText, ProgressBar, ROW_LIST, SECTION_LABEL, SMALL_INPUT, TOOLBAR_BUTTON } from './sprintUi';

const FIELD_LABEL = `block space-y-1 ${META}`;

function Candidates({ backlog, picked, toggle, canEdit }: { backlog: ProjectTask[]; picked: ReadonlySet<string>; toggle: (id: string) => void; canEdit: boolean }) {
    const { t } = useTranslation();
    return (
        <section className="min-w-0 space-y-2" aria-label={t('project_tasks.builder_pick', 'Pick the candidates')}>
            <div className="flex h-7 items-center gap-2">
                <h3 className={SECTION_LABEL}>{t('project_tasks.backlog', 'Backlog')}<span className="ml-1.5 font-normal tabular-nums">{backlog.length}</span></h3>
                {picked.size > 0 && <span className={`ml-auto tabular-nums ${META}`}>{t('project_tasks.builder_picked', '{count} picked', { count: picked.size })}</span>}
            </div>
            <ul className={ROW_LIST}>
                {backlog.length ? backlog.map(task => {
                    const points = storyPoints(task);
                    return (
                        <li key={task.id}>
                            <label className="flex h-10 cursor-pointer items-center gap-3 px-3 transition-colors hover:bg-[var(--item-hover-bg)] has-[:checked]:bg-[var(--item-active-bg)] has-[:disabled]:cursor-default">
                                <input type="checkbox" checked={picked.has(task.id)} onChange={() => toggle(task.id)} disabled={!canEdit}
                                    className="w-3.5 h-3.5 flex-none accent-[var(--accent-primary)]" data-testid={`builder-pick-${task.id}`} />
                                <TypeChip type={workItemType(task)} />
                                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--text-primary)]">{task.title}</span>
                                {points
                                    ? <span className={`flex-none tabular-nums ${META}`}>{pointsText(t, points)}</span>
                                    : <Chip tone="warning">{t('project_tasks.builder_no_estimate', 'No estimate')}</Chip>}
                            </label>
                        </li>
                    );
                }) : <li className="py-6 text-center text-[12.5px] text-[var(--text-tertiary)]">{t('project_tasks.builder_no_backlog', 'The backlog is empty — everything open is already in a sprint.')}</li>}
            </ul>
        </section>
    );
}

/** The sticky plan on the right: capacity and fill, estimates, and the sprint's name and dates. */
function BuilderSummary({ projectId, canEdit, backlog, picked, setPicked, unestimated, estimating, onEstimating, onCreated }: {
    projectId: string; canEdit: boolean; backlog: ProjectTask[]; picked: ReadonlySet<string>; setPicked: (ids: ReadonlySet<string>) => void;
    unestimated: ProjectTask[]; estimating: boolean; onEstimating: () => void; onCreated: () => void;
}) {
    const { t } = useTranslation();
    const start = useStartPokerSession(projectId);
    const create = useCreateSprint(projectId);
    const assign = useAssignSprintItems(projectId);
    const capacityId = useId();
    const [capacity, setCapacity] = useState('');
    const [name, setName] = useState('');
    const [startDate, setStartDate] = useState('');
    const [weeks, setWeeks] = useState(2);
    const total = sprintPlanPoints(backlog, picked);
    const budget = Number(capacity) || 0;
    const over = budget > 0 && total > budget;
    const onError = (e: Error) => toast.error(projectErrorText(t, e));

    const createSprint = async () => {
        const clean = name.trim();
        if (!clean || !picked.size) return;
        try {
            const sprint = await create.mutateAsync({
                name: clean, startDate: startDate || null, endDate: startDate ? addDays(startDate, weeks * 7 - 1) : null,
                capacityPoints: budget || null,
            });
            if (sprint) await assign.mutateAsync({ sprintId: sprint.id, taskIds: [...picked] });
            toast.success(t('project_tasks.builder_created', 'Sprint created with {count} items', { count: picked.size }));
            onCreated();
        } catch (e) { onError(e as Error); }
    };

    return (
        <aside className="space-y-3 rounded-xl bg-[var(--bg-secondary)] p-3 lg:sticky lg:top-0" aria-label={t('project_tasks.builder_summary', 'Sprint plan')}>
            <div className="space-y-2">
                <div className={FIELD_LABEL}>
                    <label htmlFor={capacityId} className="block">{t('project_tasks.builder_capacity', 'Capacity (story points)')}</label>
                    <span className="flex items-center gap-1">
                        <input id={capacityId} className={SMALL_INPUT} type="number" min={0} inputMode="numeric" value={capacity} onChange={e => setCapacity(e.target.value)} data-testid="builder-capacity" placeholder="20" />
                        <button type="button" className={TOOLBAR_BUTTON} onClick={() => setPicked(new Set(suggestSprintItems(backlog, budget)))} disabled={!canEdit || !budget}
                            data-testid="builder-autofill" title={t('project_tasks.builder_autofill_hint', 'Pick estimated items by priority until the capacity is full')}>
                            <Wand2 className="w-3.5 h-3.5" aria-hidden="true" />{t('project_tasks.builder_suggest', 'Suggest')}
                        </button>
                    </span>
                </div>
                <div className="space-y-1.5" role="status">
                    <span className={`block text-[13px] tabular-nums ${over ? 'text-[var(--warning-ink)]' : 'text-[var(--text-primary)]'}`}>
                        {budget ? t('project_tasks.builder_total_of', '{total} of {capacity} pts picked', { total, capacity: budget }) : t('project_tasks.builder_total', '{total} pts picked', { total })}
                    </span>
                    {budget > 0 && <ProgressBar value={total} max={budget} tone={over ? 'warning' : 'accent'} className="w-full"
                        label={t('project_tasks.sprint_capacity_used', '{points} of {capacity} points planned', { points: total, capacity: budget })} />}
                </div>
                {unestimated.length > 0 && !estimating && (
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-[11.5px] text-[var(--warning-ink)]">{t('project_tasks.builder_unestimated', '{count} without estimate', { count: unestimated.length })}</span>
                        <GhostButton className="ml-auto !text-[var(--text-primary)]" disabled={!canEdit || start.isPending} data-testid="builder-estimate"
                            title={t('project_tasks.builder_estimate_hint_short', 'One live poker session walks the team through all of them.')}
                            onClick={() => start.mutate({ taskIds: unestimated.map(task => task.id) }, { onSuccess: onEstimating, onError })}>
                            <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />{t('project_tasks.builder_estimate_button', 'Estimate with poker')}
                        </GhostButton>
                    </div>
                )}
            </div>

            <div className="space-y-2 border-t border-[var(--border-subtle)] pt-3">
                <label className={FIELD_LABEL}><span>{t('project_tasks.sprint_name', 'Sprint name')}</span>
                    <input className={SMALL_INPUT} value={name} maxLength={60} onChange={e => setName(e.target.value)} placeholder={t('project_tasks.sprint_name_placeholder', 'e.g. Sprint 1')} data-testid="builder-name" /></label>
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                    <label className={FIELD_LABEL}><span>{t('project_tasks.start_label', 'Start date')}</span>
                        <input className={SMALL_INPUT} type="date" value={startDate} onChange={e => setStartDate(e.target.value)} /></label>
                    <label className={FIELD_LABEL}><span>{t('project_tasks.sprint_length', 'Length')}</span>
                        <select className={`${SMALL_INPUT} pr-7`} value={weeks} onChange={e => setWeeks(Number(e.target.value))}>
                            {SPRINT_WEEKS.map(w => <option key={w} value={w}>{t('project_tasks.sprint_weeks', '{count} weeks', { count: w })}</option>)}
                        </select></label>
                </div>
            </div>

            <PrimaryButton className="w-full" disabled={!canEdit || !name.trim() || !picked.size} busy={create.isPending || assign.isPending} data-testid="builder-create" onClick={() => void createSprint()}>
                {t('project_tasks.builder_create_button', 'Create sprint with {count} items', { count: picked.size })}
            </PrimaryButton>
        </aside>
    );
}

export default function SprintBuilder({ projectId, tasks, canEdit, people, onClose, onCreated }: {
    projectId: string; tasks: ProjectTask[]; canEdit: boolean; people: ReturnType<typeof useChatPeople>;
    onClose: () => void; onCreated: () => void;
}) {
    const { t } = useTranslation();
    const backlog = useMemo(() => tasks.filter(task => task.status !== 'done' && !task.sprintId && !sprintName(task)), [tasks]);
    const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
    const [estimating, setEstimating] = useState(false);

    const toggle = (id: string) => setPicked(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });
    const unestimated = backlog.filter(task => picked.has(task.id) && !storyPoints(task));

    return (
        <div className="space-y-4" data-testid="sprint-builder">
            <div className="flex h-8 items-center gap-1.5">
                <GhostButton onClick={onClose} data-testid="builder-close" aria-label={t('project_tasks.builder_back', 'Back to planning')} className="-ml-1.5 h-8 px-2">
                    <ArrowLeft className="w-4 h-4" aria-hidden="true" />{t('project_tasks.planning', 'Planning')}
                </GhostButton>
                <span className="text-[13px] text-[var(--text-tertiary)]" aria-hidden="true">/</span>
                <h2 className="m-0 text-[13px] font-semibold text-[var(--text-primary)]">{t('project_tasks.builder_title_short', 'Plan a sprint')}</h2>
            </div>

            <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_280px] lg:gap-6">
                <div className="min-w-0 space-y-4">
                    <Candidates backlog={backlog} picked={picked} toggle={toggle} canEdit={canEdit} />
                    {estimating && (
                        <section className="space-y-2" aria-label={t('project_tasks.builder_estimate', 'Estimate together')}>
                            <h3 className={`${SECTION_LABEL} flex h-7 items-center`}>{t('project_tasks.builder_estimate', 'Estimate together')}</h3>
                            <PokerPanel projectId={projectId} tasks={tasks} canEdit={canEdit} people={people} />
                        </section>
                    )}
                </div>

                <BuilderSummary {...{ projectId, canEdit, backlog, picked, setPicked, onCreated }} unestimated={unestimated} estimating={estimating} onEstimating={() => setEstimating(true)} />
            </div>
        </div>
    );
}
