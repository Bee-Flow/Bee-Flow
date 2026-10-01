// One 40px timeline row: the task on the left, its bar on the right. The bar
// moves as a whole and resizes from its edges; a knob on its right edge starts
// (or finishes) a dependency.

import React from 'react';
import { ArrowLeft, ArrowRight, Check, Link2 } from 'lucide-react';
import { useDraggable } from '@dnd-kit/core';
import type { ProjectTask } from '../../../../api/queries/projectTasks';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { useChatPeople } from '../chat/chatPeople';
import { monday, rangePlacement, taskRange, type DateMove } from './taskPlanning';
import { Faces, StatusDot } from './planningParts';
import type { Dates, Timeline } from './TimelineControls';

function Handle({ task, mode, disabled, label, className, children, onClick }: {
    task: ProjectTask; mode: DateMove; disabled: boolean; label: string; className: string; children?: React.ReactNode; onClick?: () => void;
}) {
    const drag = useDraggable({ id: `${task.id}:${mode}`, data: { task, mode }, disabled });
    return <button type="button" ref={drag.setNodeRef} {...drag.attributes} {...drag.listeners} onClick={onClick} disabled={disabled} aria-label={label} className={`touch-none ${className}`}>{children}</button>;
}

const GRIP = <span aria-hidden="true" className="block w-0.5 h-3 mx-auto rounded-full bg-current opacity-50" />;
const EDGE = 'self-stretch shrink-0 w-2 cursor-ew-resize opacity-0 group-hover/bar:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity disabled:cursor-default';
const TONE = {
    neutral: 'bg-[var(--bg-secondary)] border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]',
    done: 'bg-[color-mix(in_srgb,var(--success)_14%,var(--bg-card))] border-[color-mix(in_srgb,var(--success)_35%,var(--bg-card))] text-[var(--success-ink)]',
    late: 'bg-[color-mix(in_srgb,var(--warning)_14%,var(--bg-card))] border-[color-mix(in_srgb,var(--warning)_40%,var(--bg-card))] text-[var(--warning-ink)]',
};

type RowProps = {
    task: ProjectTask; shown: Dates | ProjectTask; timeline: Timeline; people: ReturnType<typeof useChatPeople>; tooltip: string;
    canEdit: boolean; busy: boolean; previewing: boolean; onOpen: () => void; onDependency?: (task: ProjectTask, predecessor: ProjectTask) => void;
};

/** The knob on a bar's right edge: starts a dependency, or makes this task depend on the one picked first. */
function ConnectKnob({ task, timeline, busy, onConnect, inline = false }: { task: ProjectTask; timeline: Timeline; busy: boolean; onConnect: () => void; inline?: boolean }) {
    const { t } = useTranslation();
    const { connectFrom } = timeline;
    const label = connectFrom
        ? t('project_tasks.connect_dependency', 'Make {title} depend on the selected task', { title: task.title })
        : t('project_tasks.start_dependency', 'Connect dependency from {title}', { title: task.title });
    const tone = !connectFrom ? 'border-[var(--border-default)] opacity-0 group-hover/bar:opacity-100 group-focus-within/bar:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100'
        : connectFrom.id === task.id ? 'opacity-100 border-[var(--info-ink)]' : 'opacity-100 border-[var(--accent-primary)]';
    return (
        <button type="button" disabled={busy} onClick={onConnect} aria-label={label} title={label} aria-pressed={connectFrom?.id === task.id}
            className={`${inline ? 'relative' : 'absolute -right-2 top-1/2 -translate-y-1/2'} z-20 grid place-items-center w-4 h-4 rounded-full border bg-[var(--bg-card)] text-[var(--info-ink)] transition-opacity disabled:opacity-50 focus-visible:opacity-100 ${tone}`}>
            <Link2 className="w-2.5 h-2.5" aria-hidden="true" />
        </button>
    );
}

function barTone(task: ProjectTask, today: string) {
    if (task.status === 'done') return TONE.done;
    return task.dueDate && task.dueDate < today ? TONE.late : TONE.neutral;
}

/** The bar itself, with its two resize edges and the move handle between them. */
function TimelineBar({ task, timeline, canEdit, busy, previewing, position, datesLabel, onConnect }: Pick<RowProps, 'task' | 'timeline' | 'canEdit' | 'busy' | 'previewing'> & {
    position: NonNullable<ReturnType<typeof rangePlacement>>; datesLabel: string; onConnect?: () => void;
}) {
    const { t } = useTranslation();
    const { dayWidth, today, connectFrom } = timeline;
    const box = { left: position.left * dayWidth + 2, width: position.width * dayWidth - 4 };
    const locked = !canEdit || busy;
    const candidate = !!connectFrom && connectFrom.id !== task.id;
    return (
        <div className={`group/bar absolute top-1.5 h-7 flex items-center rounded-md border text-[12px] transition-colors ${barTone(task, today)} ${connectFrom?.id === task.id ? 'ring-2 ring-[var(--accent-primary)]' : ''}`}
            style={box} title={`${task.title} · ${datesLabel}`}>
            {previewing && <span aria-hidden="true" className="absolute -top-6 left-0 z-40 whitespace-nowrap rounded bg-[var(--bg-tooltip)] text-[var(--text-tooltip)] text-[11px] px-1.5 py-0.5 tabular-nums pointer-events-none">{datesLabel}</span>}
            {!position.clippedStart && <Handle task={task} mode="start" disabled={locked} label={t('project_tasks.adjust_start', 'Adjust start: {title}', { title: task.title })} className={`${EDGE} rounded-l-md`}>{GRIP}</Handle>}
            <Handle task={task} mode="move" disabled={locked} label={t('project_tasks.move_schedule', 'Move schedule: {title}', { title: task.title })}
                onClick={candidate ? onConnect : undefined}
                className={`flex-1 min-w-0 h-full flex items-center gap-1 px-1.5 text-left ${locked ? '' : 'cursor-grab active:cursor-grabbing'}`}>
                {task.status === 'done' && <Check className="w-3 h-3 shrink-0" aria-hidden="true" />}
                <span className="truncate font-medium">{task.title}</span>
                {box.width > 160 && <span className="ml-auto pl-1.5 shrink-0 text-[11px] tabular-nums opacity-70">{datesLabel}</span>}
            </Handle>
            {!position.clippedEnd && <Handle task={task} mode="end" disabled={locked} label={t('project_tasks.adjust_end', 'Adjust end: {title}', { title: task.title })} className={`${EDGE} rounded-r-md`}>{GRIP}</Handle>}
            {canEdit && onConnect && <ConnectKnob task={task} timeline={timeline} busy={busy} onConnect={onConnect} />}
        </div>
    );
}

export default function TimelineRow({ task, shown, timeline, people, tooltip, canEdit, busy, previewing, onOpen, onDependency }: RowProps) {
    const { first, count, dayWidth, format, connectFrom, setConnectFrom, setFirst } = timeline;
    const range = taskRange(shown)!;
    const position = rangePlacement(range.start, range.end, first, count);
    const datesLabel = `${format(range.start)} – ${format(range.end)}`;
    const candidate = !!connectFrom && connectFrom.id !== task.id;
    const connect = () => {
        if (!connectFrom) setConnectFrom(task);
        else { if (connectFrom.id !== task.id) onDependency?.(task, connectFrom); setConnectFrom(null); }
    };
    const lane = { width: count * dayWidth };
    const before = range.end < first;
    return (
        <div className="group/row flex h-10 border-b last:border-b-0 border-[var(--border-subtle)]" data-testid={`planning-row-${task.id}`}>
            <button type="button" onClick={onOpen} title={tooltip}
                className="sticky left-0 z-20 w-[220px] sm:w-[260px] shrink-0 flex items-center gap-2 px-3 bg-[var(--bg-card)] group-hover/row:bg-[var(--bg-secondary)] text-left border-r border-[var(--border-subtle)] transition-colors">
                <StatusDot status={task.status} />
                <span className="flex-1 min-w-0 truncate text-[13px] font-medium text-[var(--text-primary)]">{task.title}</span>
                <Faces ids={task.assigneeIds} people={people} />
            </button>
            <div className={`relative shrink-0 h-10 transition-colors ${candidate ? 'group-hover/row:bg-[color-mix(in_srgb,var(--accent-primary)_6%,transparent)]' : ''}`} style={lane}>
                {position ? (
                    <TimelineBar task={task} timeline={timeline} canEdit={canEdit} busy={busy} previewing={previewing} position={position} datesLabel={datesLabel}
                        onConnect={onDependency ? connect : undefined} />
                ) : (
                    // Off-range: a chip that jumps to the task's period, plus the connect knob so it can still take part in a dependency.
                    <div className={`absolute top-2 flex items-center gap-1.5 ${before ? 'left-2' : 'right-2 flex-row-reverse'}`}>
                        <button type="button" onClick={() => setFirst(monday(range.start))}
                            className="inline-flex items-center gap-1 h-6 px-2 rounded-md text-[11.5px] tabular-nums text-[var(--text-tertiary)] hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-secondary)] transition-colors">
                            {before && <ArrowLeft className="w-3 h-3" aria-hidden="true" />}
                            {datesLabel}
                            {!before && <ArrowRight className="w-3 h-3" aria-hidden="true" />}
                        </button>
                        {canEdit && onDependency && <ConnectKnob task={task} timeline={timeline} busy={busy} onConnect={connect} inline />}
                    </div>
                )}
            </div>
        </div>
    );
}
