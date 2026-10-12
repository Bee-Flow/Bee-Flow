// The timeline's view state and its controls. The state lives in a hook so the
// controls can sit on the Planning sub-nav row while the grid renders below it.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { ArrowRight, Check, ChevronLeft, ChevronRight, SlidersHorizontal } from 'lucide-react';
import type { ProjectTask } from '../../../../api/queries/projectTasks';
import { useTranslation } from '../../../../hooks/useTranslation';
import AnchoredMenuJs from '../../../shared/AnchoredMenu';
import { addDays, monday, type TimelineRelation } from './taskPlanning';
import { todayKey } from './taskText';
import { MENU_ITEM, MENU_SECTION, TOOLBAR_BUTTON } from './planningParts';
import { MENU_PANEL_CLASS } from './tasksMenu';

const AnchoredMenu = AnchoredMenuJs as unknown as ComponentType<Record<string, unknown>>;

export type Zoom = 'weeks' | 'months';
export type Dates = { startDate: string; dueDate: string };

export function useTimeline() {
    const { t, locale } = useTranslation();
    const today = todayKey();
    const [first, setFirst] = useState(() => monday(today));
    const [zoom, setZoom] = useState<Zoom>('weeks');
    const [hideDone, setHideDone] = useState(false);
    const [showLoad, setShowLoad] = useState(true);
    const [showLinks, setShowLinks] = useState(true);
    const [connectFrom, setConnectFrom] = useState<ProjectTask | null>(null);
    const count = zoom === 'weeks' ? 14 : 42;
    const dayWidth = zoom === 'weeks' ? 58 : 32;
    const days = useMemo(() => Array.from({ length: count }, (_, i) => addDays(first, i)), [first, count]);
    const format = useCallback((date: string, options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }) =>
        new Date(`${date}T12:00:00Z`).toLocaleDateString(locale, { ...options, timeZone: 'UTC' }), [locale]);
    const relationLabels: Record<TimelineRelation, string> = {
        depends_on: t('project_tasks.relation_depends_on', 'Depends on'),
        parent_child: t('project_tasks.relation_parent_child', 'Parent / child'),
        related: t('project_tasks.relation_related', 'Related'),
    };
    return {
        today, first, setFirst, zoom, setZoom, hideDone, setHideDone, showLoad, setShowLoad, showLinks, setShowLinks,
        connectFrom, setConnectFrom, count, dayWidth, days, format, relationLabels,
        period: `${format(first)} – ${format(days[count - 1], { day: 'numeric', month: 'short', year: 'numeric' })}`,
    };
}
export type Timeline = ReturnType<typeof useTimeline>;

const NAV_BUTTON = 'grid place-items-center w-8 h-full text-[var(--text-tertiary)] hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)] transition-colors';

function CheckRow({ checked, onChange, label }: { checked: boolean; onChange: (on: boolean) => void; label: string }) {
    return (
        <label className={`${MENU_ITEM} cursor-pointer has-[:focus-visible]:bg-[var(--item-hover-bg)]`}>
            <input type="checkbox" className="sr-only" checked={checked} onChange={e => onChange(e.target.checked)} />
            <span className="flex-1">{label}</span>
            {checked && <Check className="w-3.5 h-3.5 text-[var(--accent-primary)]" aria-hidden="true" />}
        </label>
    );
}

/** Period navigation and the Display menu: scale, what to show, and the legend. */
export default function TimelineControls({ timeline }: { timeline: Timeline }) {
    const { t } = useTranslation();
    const { first, setFirst, count, today, period, zoom, setZoom, relationLabels } = timeline;
    const [open, setOpen] = useState(false);
    const anchor = useRef<HTMLButtonElement>(null);
    const panel = useRef<HTMLDivElement>(null);
    // The panel is portalled to <body>, so Tab from the trigger would never reach
    // it: move focus in on open, and hand it back to the trigger on close.
    useEffect(() => {
        if (open) panel.current?.querySelector<HTMLElement>('button, input')?.focus();
    }, [open]);
    const close = () => {
        const inside = !!panel.current?.contains(document.activeElement);
        setOpen(false);
        if (inside) anchor.current?.focus();
    };
    const onPanelKey = (e: React.KeyboardEvent) => {
        if (e.key !== 'Tab' || !panel.current) return;
        const items = Array.from(panel.current.querySelectorAll<HTMLElement>('button, input'));
        const edge = e.shiftKey ? items[0] : items[items.length - 1];
        if (document.activeElement === edge) { e.preventDefault(); close(); }
    };
    const scales: [Zoom, string][] = [['weeks', t('project_tasks.two_weeks', 'Two weeks')], ['months', t('project_tasks.six_weeks', 'Six weeks')]];
    return (
        <>
            <div className="inline-flex items-center h-8 rounded-lg border border-[var(--border-subtle)] overflow-hidden">
                <button type="button" className={NAV_BUTTON} onClick={() => setFirst(addDays(first, -count))}
                    aria-label={t('project_tasks.previous_period', 'Previous period')} title={t('project_tasks.previous_period', 'Previous period')}>
                    <ChevronLeft className="w-4 h-4" aria-hidden="true" />
                </button>
                <button type="button" onClick={() => setFirst(monday(today))}
                    className="h-full px-2.5 border-x border-[var(--border-subtle)] text-[12.5px] text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)] transition-colors">
                    {t('project_tasks.today', 'Today')}
                </button>
                <button type="button" className={NAV_BUTTON} onClick={() => setFirst(addDays(first, count))}
                    aria-label={t('project_tasks.next_period', 'Next period')} title={t('project_tasks.next_period', 'Next period')}>
                    <ChevronRight className="w-4 h-4" aria-hidden="true" />
                </button>
            </div>
            <span className="text-[13px] font-medium tabular-nums text-[var(--text-primary)] whitespace-nowrap" aria-live="polite">{period}</span>
            <button ref={anchor} type="button" className={TOOLBAR_BUTTON} onClick={() => setOpen(o => !o)} aria-haspopup="dialog" aria-expanded={open}>
                <SlidersHorizontal className="w-4 h-4" aria-hidden="true" />{t('project_tasks.display', 'Display')}
            </button>
            <AnchoredMenu open={open} onClose={close} anchorRef={anchor} align="right" width={256} role="dialog"
                aria-label={t('project_tasks.display', 'Display')} className={MENU_PANEL_CLASS}>
                <div ref={panel} onKeyDown={onPanelKey}>
                <div className={MENU_SECTION}>{t('project_tasks.planning_zoom', 'Planning scale')}</div>
                <div role="radiogroup" aria-label={t('project_tasks.planning_zoom', 'Planning scale')}>
                    {scales.map(([value, label]) => (
                        <button key={value} type="button" role="radio" aria-checked={zoom === value} className={MENU_ITEM} onClick={() => setZoom(value)}>
                            <span className="flex-1">{label}</span>
                            {zoom === value && <Check className="w-3.5 h-3.5 text-[var(--accent-primary)]" aria-hidden="true" />}
                        </button>
                    ))}
                </div>
                <div className="my-1 border-t border-[var(--border-subtle)]" />
                <CheckRow checked={timeline.hideDone} onChange={timeline.setHideDone} label={t('project_tasks.hide_completed', 'Hide completed')} />
                <CheckRow checked={timeline.showLoad} onChange={timeline.setShowLoad} label={t('project_tasks.show_workload', 'Show workload row')} />
                <CheckRow checked={timeline.showLinks} onChange={timeline.setShowLinks} label={t('project_tasks.show_connections', 'Show connections')} />
                <div className="my-1 border-t border-[var(--border-subtle)]" />
                <div className={MENU_SECTION}>{t('project_tasks.legend', 'Legend')}</div>
                <ul className="m-0 px-2.5 pb-1 space-y-1.5 list-none" aria-label={t('project_tasks.relationship_legend', 'Relationship legend')}>
                    {(Object.entries(relationLabels) as [TimelineRelation, string][]).map(([relation, label]) => (
                        <li key={relation} className="flex items-center gap-2 text-[12.5px] text-[var(--text-secondary)]">
                            <span aria-hidden="true" className="task-timeline-relation-swatch" data-relation={relation}>{relation === 'depends_on' && <ArrowRight className="w-7 h-3" />}</span>
                            {label}
                        </li>
                    ))}
                </ul>
                <p className="m-0 px-2.5 pt-1 pb-2 text-[11.5px] leading-snug text-[var(--text-tertiary)]">
                    {t('project_tasks.timeline_legend_hint', 'Arrows point to the dependent task. A warning colour means the dates overlap.')}
                </p>
                </div>
            </AnchoredMenu>
        </>
    );
}
