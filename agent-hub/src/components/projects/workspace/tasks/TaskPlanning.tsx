import React, { useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, CalendarDays, Check, ChevronLeft, ChevronRight } from 'lucide-react';
import { DndContext, KeyboardSensor, MouseSensor, TouchSensor, useDraggable, useSensor, useSensors, type KeyboardCoordinateGetter } from '@dnd-kit/core';
import type { ProjectTask } from '../../../../api/queries/projectTasks';
import { useTranslation } from '../../../../hooks/useTranslation';
import { SecondaryButton, SELECT_CLASS } from '../workspaceUi';
import type { useChatPeople } from '../chat/chatPeople';
import { todayKey, statusLabel } from './taskText';
import { addDays, dayNumber, monday, moveDates, rangePlacement, taskRange, type DateMove } from './taskPlanning';

type Dates = { startDate: string; dueDate: string };
type Props = { tasks: ProjectTask[]; canEdit: boolean; busy: boolean; people: ReturnType<typeof useChatPeople>; onOpen: (task: ProjectTask) => void; onDates: (task: ProjectTask, dates: Dates) => void };

function Handle({ task, mode, disabled, label, className, children }: { task: ProjectTask; mode: DateMove; disabled: boolean; label: string; className: string; children?: React.ReactNode }) {
    const drag = useDraggable({ id: `${task.id}:${mode}`, data: { task, mode }, disabled });
    return <button type="button" ref={drag.setNodeRef} {...drag.attributes} {...drag.listeners} disabled={disabled} aria-label={label} className={`touch-none ${className}`}>{children}</button>;
}

export default function TaskPlanning({ tasks, canEdit, busy, people, onOpen, onDates }: Props) {
    const { t, locale } = useTranslation();
    const today = todayKey();
    const [first, setFirst] = useState(() => monday(today));
    const [zoom, setZoom] = useState('weeks');
    const [hideDone, setHideDone] = useState(false);
    const [preview, setPreview] = useState<{ id: string; dates: Dates } | null>(null);
    const count = zoom === 'weeks' ? 14 : 42;
    const dayWidth = zoom === 'weeks' ? 58 : 32;
    const days = useMemo(() => Array.from({ length: count }, (_, i) => addDays(first, i)), [first, count]);
    const format = (date: string, options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }) => new Date(`${date}T12:00:00Z`).toLocaleDateString(locale, { ...options, timeZone: 'UTC' });
    const visible = tasks.filter(task => !hideDone || task.status !== 'done');
    const scheduled = visible.filter(task => taskRange(task)).sort((a, b) => taskRange(a)!.start.localeCompare(taskRange(b)!.start) || a.title.localeCompare(b.title));
    const unplanned = visible.filter(task => !taskRange(task));
    const load = days.map(day => visible.filter(task => { const r = taskRange(task); return task.status !== 'done' && r && r.start <= day && r.end >= day; }).length);
    const maxLoad = Math.max(1, ...load);
    const overdue = visible.filter(task => task.status !== 'done' && task.dueDate && task.dueDate < today).length;
    const keyboard: KeyboardCoordinateGetter = (event, { currentCoordinates }) => {
        if (event.code === 'ArrowRight' || event.code === 'ArrowLeft') { event.preventDefault(); return { ...currentCoordinates, x: currentCoordinates.x + (event.code === 'ArrowRight' ? dayWidth : -dayWidth) }; }
        return undefined;
    };
    const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 5 } }), useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }), useSensor(KeyboardSensor, { coordinateGetter: keyboard }));
    const period = `${format(first)} – ${format(days[count - 1], { day: 'numeric', month: 'short', year: 'numeric' })}`;
    const todayIndex = dayNumber(today) - dayNumber(first);
    const grid = { width: count * dayWidth, backgroundImage: 'linear-gradient(to right, var(--border-subtle) 1px, transparent 1px)', backgroundSize: `${dayWidth}px 100%` };
    return <section className="space-y-4 min-w-0" aria-label={t('project_tasks.planning', 'Planning')} data-testid="task-planning">
        <div className="flex flex-wrap gap-3 items-center justify-between">
            <div><h2 className="m-0 text-xl font-semibold text-[var(--text-primary)]">{t('project_tasks.gantt_title', 'Make room for the work')}</h2><p className="m-0 mt-1 text-sm text-[var(--text-secondary)]">{t('project_tasks.gantt_hint', 'Move a bar to reschedule. Drag its edges to adjust the duration, or open a task to edit dates.')}</p></div>
            <div className="flex gap-2 text-xs text-[var(--text-secondary)]"><span className="rounded-lg bg-[var(--bg-secondary)] px-3 py-2">{t('project_tasks.planned_count', '{count} planned', { count: scheduled.length })}</span><span className="rounded-lg bg-[var(--bg-secondary)] px-3 py-2">{t('project_tasks.unplanned_count', '{count} unplanned', { count: unplanned.length })}</span>{overdue > 0 && <span className="rounded-lg bg-[var(--warning-bg)] text-[var(--warning-ink)] px-3 py-2">{t('project_tasks.overdue_count', '{count} overdue', { count: overdue })}</span>}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
            <SecondaryButton onClick={() => setFirst(addDays(first, -count))} aria-label={t('project_tasks.previous_period', 'Previous period')}><ChevronLeft className="w-4 h-4" /></SecondaryButton>
            <SecondaryButton onClick={() => setFirst(monday(today))}>{t('project_tasks.today', 'Today')}</SecondaryButton>
            <SecondaryButton onClick={() => setFirst(addDays(first, count))} aria-label={t('project_tasks.next_period', 'Next period')}><ChevronRight className="w-4 h-4" /></SecondaryButton>
            <span className="text-sm font-medium text-[var(--text-primary)]" aria-live="polite">{period}</span>
            <select className={`${SELECT_CLASS} sm:ml-auto`} value={zoom} onChange={e => setZoom(e.target.value)} aria-label={t('project_tasks.planning_zoom', 'Planning scale')}><option value="weeks">{t('project_tasks.two_weeks', 'Two weeks')}</option><option value="months">{t('project_tasks.six_weeks', 'Six weeks')}</option></select>
            <label className="flex gap-2 items-center text-xs text-[var(--text-secondary)]"><input type="checkbox" checked={hideDone} onChange={e => setHideDone(e.target.checked)} />{t('project_tasks.hide_completed', 'Hide completed')}</label>
        </div>
        <DndContext sensors={sensors} onDragMove={({ active, delta }) => {
            const data = active.data.current; if (!data) return;
            const dates = moveDates(data.task, data.mode, Math.round(delta.x / dayWidth));
            if (dates) setPreview({ id: data.task.id, dates });
        }} onDragCancel={() => setPreview(null)} onDragEnd={({ active, delta }) => {
            setPreview(null); const data = active.data.current; const offset = Math.round(delta.x / dayWidth);
            if (!data || !offset || busy || !canEdit) return;
            const dates = moveDates(data.task, data.mode, offset); if (dates) onDates(data.task, dates);
        }}>
            <div className="overflow-auto max-h-[65vh] rounded-2xl border border-[var(--border-default)] bg-[var(--bg-card)] custom-scrollbar" tabIndex={0} role="region" aria-label={t('project_tasks.gantt_chart', 'Gantt chart')}>
                <div className="min-w-max relative">
                    <div className="flex sticky top-0 z-30 bg-[var(--bg-card)] border-b border-[var(--border-default)]">
                        <div className="sticky left-0 z-40 w-[180px] sm:w-[260px] shrink-0 bg-[var(--bg-card)] p-4 text-xs font-semibold text-[var(--text-secondary)] border-r border-[var(--border-default)]">{t('project_tasks.task_and_owner', 'Task / owner')}</div>
                        <div className="flex" style={grid}>{days.map(day => <div key={day} style={{ width: dayWidth }} className={`shrink-0 py-2 text-center text-[11px] ${day === today ? 'bg-[var(--item-active-bg)] text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)]'}`}><span className="block text-[10px]">{format(day, { weekday: 'narrow' })}</span>{format(day, { day: 'numeric' })}{day.endsWith('-01') && <span className="block text-[9px]">{format(day, { month: 'short' })}</span>}</div>)}</div>
                    </div>
                    <div className="flex border-b border-[var(--border-default)]">
                        <div className="sticky left-0 z-20 w-[180px] sm:w-[260px] shrink-0 bg-[var(--bg-secondary)] px-4 py-3 border-r border-[var(--border-default)]"><span className="text-xs font-medium text-[var(--text-secondary)]">{t('project_tasks.daily_load', 'Active tasks per day')}</span><p className="text-[10px] text-[var(--text-tertiary)] m-0">{t('project_tasks.load_hint', 'Task count, not hours or capacity')}</p></div>
                        <div className="flex items-end" style={grid}>{load.map((n, i) => <div key={days[i]} style={{ width: dayWidth }} className="shrink-0 px-1 pb-1" title={`${format(days[i])}: ${n}`}><div style={{ height: 14 + n / maxLoad * 18 }} className={`text-center rounded-t text-[11px] pt-0.5 ${n ? 'bg-[var(--item-active-bg)] text-[var(--accent-primary)]' : 'text-[var(--text-tertiary)]'}`}>{n || '·'}</div></div>)}</div>
                    </div>
                    {scheduled.map(task => {
                        const range = taskRange(preview?.id === task.id ? preview.dates : task)!;
                        const position = rangePlacement(range.start, range.end, first, count);
                        const late = task.status !== 'done' && task.dueDate && task.dueDate < today;
                        const datesLabel = `${format(range.start)} – ${format(range.end)}`;
                        return <div key={task.id} className="flex border-b last:border-b-0 border-[var(--border-subtle)] group" data-testid={`planning-row-${task.id}`}>
                            <button type="button" onClick={() => onOpen(task)} className="sticky left-0 z-20 w-[180px] sm:w-[260px] shrink-0 bg-[var(--bg-card)] group-hover:bg-[var(--bg-secondary)] text-left px-4 py-3 border-r border-[var(--border-default)]">
                                <span className="block truncate text-[13px] font-medium text-[var(--text-primary)]">{task.title}</span><span className="block truncate text-[11px] text-[var(--text-tertiary)] mt-1">{task.assigneeIds.length ? task.assigneeIds.map(id => people.nameOf(id)).join(', ') : t('project_tasks.unassigned', 'Not assigned')} · {statusLabel(t, task.status)}</span>
                            </button>
                            <div className="relative shrink-0 min-h-[68px]" style={grid}>
                                {days.map((day, i) => [0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay()) ? <div key={day} aria-hidden="true" className="absolute inset-y-0 bg-[var(--bg-secondary)] opacity-60 pointer-events-none" style={{ left: i * dayWidth, width: dayWidth }} /> : null)}
                                {todayIndex >= 0 && todayIndex < count && <div aria-hidden="true" className="absolute inset-y-0 border-l-2 border-[var(--accent-primary)] opacity-40 pointer-events-none" style={{ left: (todayIndex + 0.5) * dayWidth }} />}
                                {position ? <div className={`absolute top-3 h-10 flex items-center rounded-lg border shadow-sm ${task.status === 'done' ? 'bg-[var(--bg-secondary)] border-[var(--border-default)] text-[var(--text-secondary)]' : late ? 'bg-[var(--warning-bg)] border-[var(--warning-ink)] text-[var(--warning-ink)]' : 'bg-[var(--item-active-bg)] border-[var(--accent-primary)] text-[var(--text-primary)]'}`} style={{ left: position.left * dayWidth + 2, width: position.width * dayWidth - 4 }} title={`${task.title} · ${datesLabel}`}>
                                    {!position.clippedStart && <Handle task={task} mode="start" disabled={!canEdit || busy} label={t('project_tasks.adjust_start', 'Adjust start: {title}', { title: task.title })} className="self-stretch shrink-0 w-3 cursor-ew-resize rounded-l-lg hover:bg-black/10 border-r border-current opacity-40" />}
                                    <Handle task={task} mode="move" disabled={!canEdit || busy} label={t('project_tasks.move_schedule', 'Move schedule: {title}', { title: task.title })} className="flex-1 min-w-0 px-1.5 text-left cursor-grab active:cursor-grabbing"><span className="flex items-center gap-1 text-xs truncate">{task.status === 'done' && <Check className="w-3 h-3 shrink-0" />}<span className="truncate">{task.title}</span></span>{position.width * dayWidth > 120 && <span className="block text-[10px] opacity-75 truncate">{datesLabel}</span>}</Handle>
                                    {!position.clippedEnd && <Handle task={task} mode="end" disabled={!canEdit || busy} label={t('project_tasks.adjust_end', 'Adjust end: {title}', { title: task.title })} className="self-stretch shrink-0 w-3 cursor-ew-resize rounded-r-lg hover:bg-black/10 border-l border-current opacity-40" />}
                                </div> : <button type="button" onClick={() => setFirst(monday(range.start))} className="absolute top-4 left-4 flex items-center gap-1 text-xs text-[var(--text-secondary)] hover:underline">{range.end < first ? <ArrowLeft className="w-3 h-3" /> : <ArrowRight className="w-3 h-3" />}{datesLabel}</button>}
                            </div>
                        </div>;
                    })}
                    {!scheduled.length && <p className="p-6 text-sm text-[var(--text-secondary)]">{t('project_tasks.no_planned', 'Give a task a start date or deadline to see it here.')}</p>}
                </div>
            </div>
        </DndContext>
        {preview && <p role="status" className="text-xs text-[var(--text-secondary)]">{format(preview.dates.startDate)} – {format(preview.dates.dueDate)}</p>}
        {unplanned.length > 0 && <section className="rounded-2xl border border-dashed border-[var(--border-default)] p-4"><h3 className="text-sm font-semibold text-[var(--text-primary)] m-0 mb-1">{t('project_tasks.unplanned_title', 'Still to schedule')}</h3><p className="text-xs text-[var(--text-secondary)] m-0 mb-3">{t('project_tasks.unplanned_hint', 'Open a task and choose its dates. It stays in the same Kanban column.')}</p><div className="flex flex-wrap gap-2">{unplanned.map(task => <button type="button" key={task.id} onClick={() => onOpen(task)} className="flex items-center gap-2 max-w-full px-3 py-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] text-sm text-[var(--text-primary)] hover:border-[var(--accent-primary)]"><CalendarDays className="w-4 h-4 shrink-0 text-[var(--text-tertiary)]" /><span className="truncate">{task.title}</span></button>)}</div></section>}
    </section>;
}
