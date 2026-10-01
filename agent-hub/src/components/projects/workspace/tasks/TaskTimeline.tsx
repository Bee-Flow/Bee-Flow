// The Planning timeline: one card holding the day header, an optional workload
// strip and a 40px row per scheduled task, with relationship connectors drawn
// over the rows. Tasks without dates follow underneath as a compact list.

import React, { useId, useRef, useState } from 'react';
import { CalendarDays, ChevronRight, Info } from 'lucide-react';
import { DndContext, KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors, type KeyboardCoordinateGetter } from '@dnd-kit/core';
import type { ProjectTask } from '../../../../api/queries/projectTasks';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { useChatPeople } from '../chat/chatPeople';
import { GhostButton } from '../workspaceUi';
import { dayNumber, moveDates, taskRange, timelineRelations, TIMELINE_ROW, type DateMove } from './taskPlanning';
import { GROUP_LABEL, REVEAL, StatusDot, useTaskTooltip } from './planningParts';
import TimelineRow from './TimelineRow';
import type { Dates, Timeline } from './TimelineControls';

type Props = {
    tasks: ProjectTask[]; timeline: Timeline; canEdit: boolean; busy: boolean; people: ReturnType<typeof useChatPeople>;
    onOpen: (task: ProjectTask) => void; onDates: (task: ProjectTask, dates: Dates) => void; onDependency?: (task: ProjectTask, predecessor: ProjectTask) => void;
};

const LEFT = 'sticky left-0 shrink-0 w-[220px] sm:w-[260px] bg-[var(--bg-card)] border-r border-[var(--border-subtle)]';
const isWeekend = (day: string) => [0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());
const COLLAPSE_AFTER = 8;

/** Tasks without any date, as a quiet divided list; collapsed when it is long. */
function Unscheduled({ tasks, people, onOpen }: { tasks: ProjectTask[]; people: ReturnType<typeof useChatPeople>; onOpen: (task: ProjectTask) => void }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(tasks.length <= COLLAPSE_AFTER);
    const tooltip = useTaskTooltip(people);
    const listId = useId();
    if (!tasks.length) return null;
    return (
        <section className="space-y-2" aria-label={t('project_tasks.unscheduled_title', 'Unscheduled')}>
            <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} aria-controls={listId}
                className="inline-flex items-center gap-1 -ml-1 px-1 h-6 rounded-md hover:bg-[var(--item-hover-bg)] transition-colors">
                <ChevronRight className={`w-3.5 h-3.5 text-[var(--text-tertiary)] transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
                <span className={GROUP_LABEL}>{t('project_tasks.unscheduled_title', 'Unscheduled')}<span className="ml-1.5 font-normal tabular-nums">{tasks.length}</span></span>
            </button>
            {open && (
                <ul id={listId} className="m-0 p-0 list-none rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] divide-y divide-[var(--border-subtle)] overflow-hidden">
                    {tasks.map(task => (
                        <li key={task.id}>
                            <button type="button" onClick={() => onOpen(task)} title={`${tooltip(task)}\n${t('project_tasks.unplanned_hint', 'Open a task and choose its dates. It stays in the same Kanban column.')}`}
                                className="group w-full flex items-center gap-3 px-3 h-9 text-left hover:bg-[var(--item-hover-bg)] transition-colors">
                                <StatusDot status={task.status} />
                                <span className="flex-1 min-w-0 truncate text-[13px] text-[var(--text-primary)]">{task.title}</span>
                                <span className={`inline-flex items-center gap-1 text-[12px] text-[var(--text-secondary)] ${REVEAL}`}>
                                    <CalendarDays className="w-3.5 h-3.5" aria-hidden="true" />{t('project_tasks.set_dates', 'Set dates')}
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}

/** Day header: the planned count in the corner, then one cell per day with weekends and today marked. */
function TimelineHeader({ timeline, planned, overdue }: { timeline: Timeline; planned: number; overdue: number }) {
    const { t } = useTranslation();
    const { days, today, format, dayWidth } = timeline;
    const cell = { width: dayWidth };
    return (
        <div className="flex sticky top-0 z-30 h-10 bg-[var(--bg-card)] border-b border-[var(--border-subtle)]">
            <div className={`${LEFT} z-40 flex items-center gap-1.5 px-3`}>
                <span className={GROUP_LABEL}>{t('project_tasks.planned_count', '{count} planned', { count: planned })}</span>
                {overdue > 0 && <span className="text-[11px] font-medium tabular-nums text-[var(--warning-ink)]">· {t('project_tasks.overdue_count', '{count} overdue', { count: overdue })}</span>}
                <Info className="w-3.5 h-3.5 ml-auto text-[var(--text-tertiary)]" role="img" aria-label={t('project_tasks.gantt_hint', 'Move a bar to reschedule. Drag its edges to adjust the duration, or open a task to edit dates.')}>
                    <title>{t('project_tasks.gantt_hint', 'Move a bar to reschedule. Drag its edges to adjust the duration, or open a task to edit dates.')}</title>
                </Info>
            </div>
            <div className="flex">
                {days.map((day, i) => {
                    const isToday = day === today;
                    return (
                        <div key={day} style={cell} className={`shrink-0 flex flex-col justify-end pb-1.5 text-[10.5px] leading-none tabular-nums text-[var(--text-tertiary)] ${isWeekend(day) ? 'bg-[var(--bg-secondary)]/60' : ''}`}>
                            {(i === 0 || day.endsWith('-01')) && <span className="pl-1.5 mb-1 text-[10px] font-medium text-[var(--text-secondary)] whitespace-nowrap">{format(day, { month: 'short' })}</span>}
                            <span className="text-center whitespace-nowrap">
                                {format(day, { weekday: 'narrow' })}{' '}
                                <span className={isToday ? 'px-1 py-0.5 rounded-md bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] font-semibold' : ''}>{format(day, { day: 'numeric' })}</span>
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

/** Active tasks per day as thin bars; the number is in each day's tooltip. */
function LoadRow({ timeline, load }: { timeline: Timeline; load: number[] }) {
    const { t } = useTranslation();
    const { days, format, dayWidth } = timeline;
    const cell = { width: dayWidth };
    const maxLoad = Math.max(1, ...load);
    return (
        <div className="relative flex h-7 border-b border-[var(--border-subtle)]">
            <div className={`${LEFT} z-20 flex items-center gap-1 px-3 text-[11px] text-[var(--text-tertiary)]`} title={t('project_tasks.daily_load', 'Active tasks per day')}>
                {t('project_tasks.load_label', 'Load')}
                <Info className="w-3 h-3" role="img" aria-label={t('project_tasks.load_hint', 'Task count, not hours or capacity')}><title>{t('project_tasks.load_hint', 'Task count, not hours or capacity')}</title></Info>
            </div>
            <div className="flex items-end">
                {load.map((n, i) => (
                    <div key={days[i]} style={cell} className="shrink-0 h-full flex items-end justify-center pb-1" title={`${format(days[i])}: ${n}`}>
                        <span className="sr-only">{`${format(days[i])}: ${n}`}</span>
                        {n > 0 && <div className={`w-1/2 max-w-6 rounded-sm ${n >= 3 ? 'bg-[color-mix(in_srgb,var(--warning)_45%,transparent)]' : 'bg-[var(--bg-tertiary)]'}`} style={{ height: Math.max(3, Math.round(n / maxLoad * 16)) }} />}
                    </div>
                ))}
            </div>
        </div>
    );
}

/** The connectors between bars, drawn over the rows. */
function Relations({ edges, timeline, rows }: { edges: ReturnType<typeof timelineRelations>; timeline: Timeline; rows: number }) {
    const { t } = useTranslation();
    const { relationLabels, count, dayWidth } = timeline;
    const arrowId = useId().replace(/:/g, '');
    const width = count * dayWidth;
    return (
        <svg className="absolute top-0 left-[220px] sm:left-[260px] z-10 pointer-events-none overflow-hidden" width={width} height={rows * TIMELINE_ROW} role="img" aria-label={t('project_tasks.task_relationships', 'Task relationships')}>
            <defs>{[false, true].map(conflict => <marker key={String(conflict)} id={`${arrowId}-${conflict ? 'overlap' : 'normal'}`} viewBox="0 0 8 8" refX="8" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z" fill={conflict ? 'var(--warning-ink)' : 'var(--info-ink)'} /></marker>)}</defs>
            {edges.map(edge => <g key={`${edge.relation}:${edge.id}`} className="task-timeline-dependency" data-relation={edge.relation} data-conflict={edge.conflict}>
                <path className="task-timeline-dependency-halo" d={edge.path} aria-hidden="true" />
                <path className="task-timeline-dependency-line" data-testid={`${edge.relation === 'depends_on' ? 'dependency' : edge.relation === 'parent_child' ? 'hierarchy' : 'related'}-${edge.id}`} d={edge.path} markerEnd={edge.relation === 'depends_on' ? `url(#${arrowId}-${edge.conflict ? 'overlap' : 'normal'})` : undefined}><title>{`${relationLabels[edge.relation]}: ${edge.predecessor.title} ${edge.relation === 'depends_on' ? '→' : '—'} ${edge.successor.title}`}</title></path>
                <circle cx={edge.source.x} cy={edge.source.y} r="3" className="task-timeline-dependency-anchor" />
                {edge.relation !== 'depends_on' && <circle cx={edge.target.x} cy={edge.target.y} r="2.5" className="task-timeline-dependency-anchor" />}
            </g>)}
        </svg>
    );
}

/** One layer under the rows draws the day lines, weekends and today, instead of every row repeating them. */
function DayLayer({ timeline }: { timeline: Timeline }) {
    const { days, dayWidth, count, today, first } = timeline;
    const todayIndex = dayNumber(today) - dayNumber(first);
    const lines = { width: count * dayWidth, backgroundImage: 'linear-gradient(to right, var(--border-subtle) 1px, transparent 1px)', backgroundSize: `${dayWidth}px 100%` };
    return (
        <div aria-hidden="true" className="absolute inset-y-0 left-[220px] sm:left-[260px] pointer-events-none" style={lines}>
            {days.map((day, i) => isWeekend(day) ? <div key={day} className="absolute inset-y-0 bg-[var(--bg-secondary)] opacity-60" style={{ left: i * dayWidth, width: dayWidth }} /> : null)}
            {todayIndex >= 0 && todayIndex < count && <div className="absolute inset-y-0 w-px bg-[var(--accent-primary)]" style={{ left: (todayIndex + 0.5) * dayWidth }} />}
        </div>
    );
}

export default function TaskTimeline({ tasks, timeline, canEdit, busy, people, onOpen, onDates, onDependency }: Props) {
    const { t } = useTranslation();
    const { today, first, count, dayWidth, days, format, hideDone, showLoad, showLinks, connectFrom, setConnectFrom } = timeline;
    const [preview, setPreview] = useState<{ id: string; dates: Dates } | null>(null);
    const dragging = useRef<{ task: ProjectTask; mode: DateMove } | null>(null);
    const tooltip = useTaskTooltip(people);
    const visible = tasks.filter(task => !hideDone || task.status !== 'done');
    const scheduled = visible.filter(task => taskRange(task)).sort((a, b) => taskRange(a)!.start.localeCompare(taskRange(b)!.start) || a.title.localeCompare(b.title));
    const unplanned = visible.filter(task => !taskRange(task));
    const edges = showLinks ? timelineRelations(scheduled.map(task => preview?.id === task.id ? { ...task, ...preview.dates } : task), first, count, dayWidth) : [];
    const load = days.map(day => visible.filter(task => { const r = taskRange(task); return task.status !== 'done' && r && r.start <= day && r.end >= day; }).length);
    const overdue = visible.filter(task => task.status !== 'done' && task.dueDate && task.dueDate < today).length;
    const keyboard: KeyboardCoordinateGetter = (event, { currentCoordinates }) => {
        if (event.code === 'ArrowRight' || event.code === 'ArrowLeft') { event.preventDefault(); return { ...currentCoordinates, x: currentCoordinates.x + (event.code === 'ArrowRight' ? dayWidth : -dayWidth) }; }
        return undefined;
    };
    const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 5 } }), useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }), useSensor(KeyboardSensor, { coordinateGetter: keyboard }));
    return (
        <div className="space-y-4">
            {connectFrom && (
                <div role="status" className="flex items-center gap-2 h-8 px-3 rounded-lg bg-[var(--bg-secondary)] text-[12.5px] text-[var(--text-primary)]">
                    <span className="flex-1 min-w-0 truncate">{t('project_tasks.connect_from', 'Choose a task that depends on {title}', { title: connectFrom.title })}</span>
                    <GhostButton onClick={() => setConnectFrom(null)}>{t('project_content.cancel', 'Cancel')}</GhostButton>
                </div>
            )}
            <DndContext sensors={sensors} onDragStart={({ active }) => {
                const data = active.data.current;
                // A preview can unmount a clipped handle; keep its original payload
                // for the entire gesture rather than reading the disappearing node.
                dragging.current = data?.task && ['move', 'start', 'end'].includes(data.mode) ? { task: data.task, mode: data.mode } : null;
            }} onDragMove={({ delta }) => {
                const data = dragging.current; if (!data) return;
                const dates = moveDates(data.task, data.mode, Math.round(delta.x / dayWidth));
                if (dates) setPreview({ id: data.task.id, dates });
            }} onDragCancel={() => { dragging.current = null; setPreview(null); }} onDragEnd={({ delta }) => {
                setPreview(null); const data = dragging.current; dragging.current = null; const offset = Math.round(delta.x / dayWidth);
                if (!data || !offset || busy || !canEdit) return;
                const dates = moveDates(data.task, data.mode, offset); if (dates) onDates(data.task, dates);
            }}>
                <div className="overflow-auto max-h-[70vh] rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] custom-scrollbar" tabIndex={0} role="region" aria-label={t('project_tasks.gantt_chart', 'Gantt chart')}>
                    <div className="min-w-max">
                        <TimelineHeader timeline={timeline} planned={scheduled.length} overdue={overdue} />
                        <div className="relative">
                            <DayLayer timeline={timeline} />
                            {showLoad && <LoadRow timeline={timeline} load={load} />}
                            <div className="relative">
                                {showLinks && <Relations edges={edges} timeline={timeline} rows={scheduled.length} />}
                                {scheduled.map(task => (
                                    <TimelineRow key={task.id} task={task} shown={preview?.id === task.id ? preview.dates : task} timeline={timeline} people={people}
                                        tooltip={tooltip(task)} canEdit={canEdit} busy={busy} previewing={preview?.id === task.id}
                                        onOpen={() => onOpen(task)} onDependency={onDependency} />
                                ))}
                            </div>
                            {!scheduled.length && <p className="relative m-0 py-6 text-center text-[12.5px] text-[var(--text-tertiary)]">{t('project_tasks.no_planned', 'Give a task a start date or deadline to see it here.')}</p>}
                        </div>
                    </div>
                </div>
            </DndContext>
            {preview && <p role="status" className="sr-only">{format(preview.dates.startDate)} – {format(preview.dates.dueDate)}</p>}
            <Unscheduled tasks={unplanned} people={people} onOpen={onOpen} />
        </div>
    );
}
