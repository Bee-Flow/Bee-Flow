// Planning: one underline sub-nav (Backlog · Sprints · Timeline · Poker) whose
// right side carries the controls of the active view, with that view directly
// below. The Sprints view portals its "New sprint ▾" menu (with "Plan with
// poker") into that right side. The sprint builder takes over the whole area
// while it is open and draws its own compact header.

import React, { useId, useState } from 'react';
import type { ProjectTask } from '../../../../api/queries/projectTasks';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { useChatPeople } from '../chat/chatPeople';
import { sprintName } from './taskPlanning';
import PlanningBacklog, { BacklogControls } from './PlanningBacklog';
import PokerPanel from './PokerPanel';
import SprintBuilder from './SprintBuilder';
import SprintsPanel from './SprintsPanel';
import TaskTimeline from './TaskTimeline';
import TimelineControls, { useTimeline, type Dates } from './TimelineControls';

type Mode = 'backlog' | 'sprints' | 'timeline' | 'poker';
type Props = { projectId: string; tasks: ProjectTask[]; canEdit: boolean; busy: boolean; people: ReturnType<typeof useChatPeople>; onOpen: (task: ProjectTask) => void; onDates: (task: ProjectTask, dates: Dates) => void; onDependency?: (task: ProjectTask, predecessor: ProjectTask) => void };

const TAB = 'relative h-9 inline-flex items-center gap-1.5 text-[13px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors '
    + 'aria-selected:text-[var(--text-primary)] aria-selected:font-medium after:rounded-full '
    + 'aria-selected:after:absolute aria-selected:after:inset-x-0 aria-selected:after:-bottom-px aria-selected:after:h-0.5 aria-selected:after:bg-[var(--accent-primary)]';

export default function TaskPlanning({ projectId, tasks, canEdit, busy, people, onOpen, onDates, onDependency }: Props) {
    const { t } = useTranslation();
    const [mode, setMode] = useState<Mode>('timeline');
    const [builder, setBuilder] = useState(false);
    // The sub-nav's right side while Sprints is shown; set by a ref callback, so SprintsPanel re-renders into it once it exists.
    const [sprintActions, setSprintActions] = useState<HTMLElement | null>(null);
    const timeline = useTimeline();
    const ids = useId();
    const backlog = tasks.filter(task => task.status !== 'done' && !task.sprintId && !sprintName(task));
    const tabs: [Mode, string, number | null][] = [
        ['backlog', t('project_tasks.planning_backlog', 'Backlog'), backlog.length],
        ['sprints', t('project_tasks.planning_sprints', 'Sprints'), null],
        ['timeline', t('project_tasks.planning_timeline', 'Timeline'), null],
        ['poker', t('project_tasks.planning_poker', 'Poker'), null],
    ];
    const controls = mode === 'timeline' ? <TimelineControls timeline={timeline} />
        : mode === 'backlog' && canEdit ? <BacklogControls onNewSprint={() => setMode('sprints')} onPlanWithPoker={() => setBuilder(true)} /> : null;
    const tabId = (key: Mode) => `${ids}-tab-${key}`;
    return (
        <section className="space-y-4 min-w-0" aria-label={t('project_tasks.planning', 'Planning')} data-testid="task-planning">
            {builder ? (
                <SprintBuilder projectId={projectId} tasks={tasks} canEdit={canEdit} people={people} onClose={() => setBuilder(false)} onCreated={() => { setBuilder(false); setMode('sprints'); }} />
            ) : <>
                {/* wrap-reverse keeps the tabs on the border line when the controls wrap on a narrow screen */}
                <div className="flex flex-wrap-reverse items-center gap-x-4 gap-y-1 border-b border-[var(--border-subtle)]">
                    <div className="flex items-center gap-4" role="tablist" aria-label={t('project_tasks.planning_methods', 'Planning methods')}>
                        {tabs.map(([key, label, count]) => (
                            <button key={key} id={tabId(key)} type="button" role="tab" aria-selected={mode === key} aria-controls={`${ids}-panel`}
                                tabIndex={mode === key ? 0 : -1} onClick={() => setMode(key)} className={TAB}
                                onKeyDown={e => {
                                    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
                                    const i = tabs.findIndex(([k]) => k === key);
                                    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length][0];
                                    setMode(next);
                                    document.getElementById(tabId(next))?.focus();
                                }}>
                                {label}
                                {count !== null && <span className="font-normal text-[var(--text-tertiary)] tabular-nums">{count}</span>}
                            </button>
                        ))}
                    </div>
                    {mode === 'sprints'
                        ? <div ref={setSprintActions} className="ml-auto flex flex-wrap items-center gap-2 py-0.5 empty:hidden" data-testid="planning-sprint-actions" />
                        : controls && <div className="ml-auto flex flex-wrap items-center gap-2 py-0.5">{controls}</div>}
                </div>
                <div id={`${ids}-panel`} role="tabpanel" aria-labelledby={tabId(mode)}>
                    {mode === 'backlog' && <PlanningBacklog backlog={backlog} tasks={tasks} people={people} onOpen={onOpen} />}
                    {mode === 'sprints' && <SprintsPanel projectId={projectId} tasks={tasks} canEdit={canEdit} people={people} onOpen={onOpen}
                        onPlanWithPoker={canEdit ? () => setBuilder(true) : undefined} actionsSlot={sprintActions} />}
                    {mode === 'timeline' && <TaskTimeline tasks={tasks} timeline={timeline} canEdit={canEdit} busy={busy} people={people} onOpen={onOpen} onDates={onDates} onDependency={onDependency} />}
                    {mode === 'poker' && <PokerPanel projectId={projectId} tasks={tasks} canEdit={canEdit} people={people} />}
                </div>
            </>}
        </section>
    );
}
