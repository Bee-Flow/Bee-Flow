// The Planning backlog: open work that is in no sprint yet, as one divided list,
// plus its controls (New sprint, and Plan sprint with poker in an overflow menu).

import React, { useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { MoreHorizontal, Plus, Target } from 'lucide-react';
import type { ProjectTask } from '../../../../api/queries/projectTasks';
import { useTranslation } from '../../../../hooks/useTranslation';
import AnchoredMenuJs from '../../../shared/AnchoredMenu';
import type { useChatPeople } from '../chat/chatPeople';
import { PriorityIcon, TypeChip } from './TaskFields';
import { storyPoints, workItemType } from './taskPlanning';
import { Faces, ICON_BUTTON, MENU_ITEM, StatusDot, TOOLBAR_BUTTON, useTaskTooltip } from './planningParts';
import { MENU_PANEL_CLASS } from './tasksMenu';

const AnchoredMenu = AnchoredMenuJs as unknown as ComponentType<Record<string, unknown>>;

/** Right-hand controls of the sub-nav row while the backlog is shown. */
export function BacklogControls({ onNewSprint, onPlanWithPoker }: { onNewSprint: () => void; onPlanWithPoker: () => void }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const anchor = useRef<HTMLButtonElement>(null);
    const more = t('project_tasks.backlog_more', 'More backlog actions');
    return (
        <>
            <button type="button" className={TOOLBAR_BUTTON} onClick={onNewSprint}>
                <Plus className="w-4 h-4" aria-hidden="true" />{t('project_tasks.sprint_new', 'New sprint')}
            </button>
            <button ref={anchor} type="button" className={ICON_BUTTON} onClick={() => setOpen(o => !o)} aria-haspopup="menu" aria-expanded={open} aria-label={more} title={more}>
                <MoreHorizontal className="w-4 h-4" aria-hidden="true" />
            </button>
            <AnchoredMenu open={open} onClose={() => setOpen(false)} anchorRef={anchor} align="right" width={256} role="menu" aria-label={more} className={MENU_PANEL_CLASS}>
                <button type="button" role="menuitem" className={MENU_ITEM} data-testid="plan-sprint-with-poker" onClick={() => { setOpen(false); onPlanWithPoker(); }}>
                    <Target className="w-3.5 h-3.5 text-[var(--text-tertiary)]" aria-hidden="true" />
                    {t('project_tasks.plan_sprint_with_poker', 'Plan a sprint with poker')}
                </button>
            </AnchoredMenu>
        </>
    );
}

export default function PlanningBacklog({ backlog, tasks, people, onOpen }: {
    backlog: ProjectTask[]; tasks: ProjectTask[]; people: ReturnType<typeof useChatPeople>; onOpen: (task: ProjectTask) => void;
}) {
    const { t } = useTranslation();
    const tooltip = useTaskTooltip(people);
    const kinds = tasks.map(task => workItemType(task));
    const counts = {
        epics: kinds.filter(kind => kind === 'epic').length,
        stories: kinds.filter(kind => kind === 'story' || kind === 'user-story').length,
        tasks: kinds.filter(kind => kind === 'task').length,
    };
    return (
        <div className="space-y-2">
            {backlog.length ? (
                <ul className="m-0 p-0 list-none rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] divide-y divide-[var(--border-subtle)] overflow-hidden">
                    {backlog.map(task => (
                        <li key={task.id}>
                            <button type="button" onClick={() => onOpen(task)} title={tooltip(task)}
                                className="group w-full flex items-center gap-3 px-3 h-10 text-left hover:bg-[var(--item-hover-bg)] transition-colors">
                                <StatusDot status={task.status} />
                                <TypeChip type={workItemType(task)} />
                                <span className="flex-1 min-w-0 truncate text-[13px] font-medium text-[var(--text-primary)]">{task.title}</span>
                                <PriorityIcon priority={task.priority} />
                                {!!storyPoints(task) && <span className="flex-none text-[11.5px] text-[var(--text-tertiary)] tabular-nums whitespace-nowrap">{t('project_tasks.points_short', '{points} pts', { points: storyPoints(task) })}</span>}
                                <Faces ids={task.assigneeIds} people={people} />
                            </button>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="m-0 py-6 text-center text-[12.5px] text-[var(--text-tertiary)]">{t('project_tasks.backlog_empty', 'Everything open is already in a sprint.')}</p>
            )}
            <p className="m-0 text-[11.5px] text-[var(--text-tertiary)] tabular-nums">
                {t('project_tasks.work_item_counts', '{epics} epics · {stories} stories · {tasks} tasks', counts)}
            </p>
        </div>
    );
}
