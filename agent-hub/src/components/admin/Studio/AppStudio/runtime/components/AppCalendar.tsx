import { ChevronLeft, ChevronRight } from 'lucide-react';
import { SetStateAction, JSX, Dispatch, useMemo, useState } from 'react';
import useTranslation, { TranslateParams } from '@/hooks/useTranslation';
import { resolveBinding, walkPath } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';
import { isFill } from '../styleResolver.helpers';
import { ROLE_COLORS } from '../styleResolver.constants';
import { EmptyText, ErrorText, SkeletonLines, displayValue, useStickyBinding } from '../uiBits';
import type { BindingInput } from '../resolveBinding.types';
import type { NodeProps } from './appNode.types';

/** One event row as the binding returned it. */
type CalendarRow = Record<string, unknown>;

interface CalendarProps {
    source?: BindingInput;
    dateKey?: string;
    endDateKey?: string | null;
    titleKey?: string;
    colorKey?: string | null;
    view?: string;
    emptyText?: string;
}

/**
 * App Studio runtime — 'calendar'. Spec: server/appStudio/componentSpecs.js.
 *
 * A hand-rolled calendar over an array of objects (NO calendar dependency):
 *   month — a Monday-first month grid; each cell lists up to 3 event chips
 *   week  — the same cells for the current 7-day week
 *   list  — a flat, date-sorted agenda (the cheap/mobile fallback)
 * Events are dated by dateKey and optionally span through endDateKey (capped
 * at 60 days). Clicking a chip fires onRowClick with the row as form values.
 * The anchor date defaults to the first event so bound data is visible
 * immediately; prev/next buttons move by month or week.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SPAN_DAYS = 60;
const MAX_CHIPS_PER_DAY = 3;
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** d + n calendar days, LOCAL. Fixed-hour maths drifts an hour across a DST
 *  boundary, which duplicates a day and shifts the rest of the grid. */
function addDays(d: Date, n: number) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function parseDay(value: unknown) {
    if (value == null || value === '') return null;
    // 'YYYY-MM-DD' is a CALENDAR date, but Date() reads it as UTC midnight —
    // west of Greenwich that lands the event on the previous day.
    if (typeof value === 'string') {
        const m = DATE_ONLY_RE.exec(value.trim());
        if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    }
    const d = new Date(value as string | number | Date);
    if (Number.isNaN(d.getTime())) return null;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Bucket rows by local calendar day: Map(dayKey → [{ row, start }]). Exported for tests. */
export function bucketEvents(rows: CalendarRow[], dateKey: string, endDateKey: string | null) {
    const buckets = new Map<string, { row: CalendarRow; start: Date }[]>();
    for (const row of rows) {
        const start = parseDay(walkPath(row, dateKey));
        if (!start) continue;
        let end = endDateKey ? parseDay(walkPath(row, endDateKey)) : null;
        if (!end || end < start) end = start;
        const span = Math.min(Math.round((end.getTime() - start.getTime()) / DAY_MS), MAX_SPAN_DAYS);
        for (let i = 0; i <= span; i++) {
            const day = addDays(start, i);
            const key = dayKey(day);
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key)?.push({ row, start });
        }
    }
    return buckets;
}

/** Monday of the week containing d. */
function mondayOf(d: Date) {
    const day = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
}

export default function AppCalendar({ node }: NodeProps<CalendarProps>) {
    const { t } = useTranslation();
    const { mode, runAction, actionState, dataState, scope } = useRuntime();
    const {
        dateKey = 'date', endDateKey = null, titleKey = 'title',
        colorKey = null, view = 'month', emptyText = t('studio_apps_runtime.calendar.empty', 'No events yet.'),
    } = node.props || {};
    const { value: source, isLoading, error, errorCode } = useStickyBinding(
        resolveBinding(node.props?.source, { actionState, dataState, scope }),
    );

    const rows = useMemo(
        () => (Array.isArray(source) ? source : []).filter((r) => r && typeof r === 'object') as CalendarRow[],
        [source],
    );
    const buckets = useMemo(() => bucketEvents(rows, dateKey, endDateKey), [rows, dateKey, endDateKey]);

    // Anchor on the first dated event (deterministic for bound data), else today.
    const firstEventDay = useMemo(() => {
        for (const row of rows) {
            const d = parseDay(walkPath(row, dateKey));
            if (d) return d;
        }
        return null;
    }, [rows, dateKey]);
    const [anchorOverride, setAnchorOverride] = useState<Date | null>(null);
    // Which day has its full event list open (the "+N more" toggle).
    const [expandedDay, setExpandedDay] = useState<string | null>(null);
    const WEEKDAY_LABELS: Record<string, string> = {
        mon: t('studio_apps_runtime.calendar.weekday_mon', 'Mon'),
        tue: t('studio_apps_runtime.calendar.weekday_tue', 'Tue'),
        wed: t('studio_apps_runtime.calendar.weekday_wed', 'Wed'),
        thu: t('studio_apps_runtime.calendar.weekday_thu', 'Thu'),
        fri: t('studio_apps_runtime.calendar.weekday_fri', 'Fri'),
        sat: t('studio_apps_runtime.calendar.weekday_sat', 'Sat'),
        sun: t('studio_apps_runtime.calendar.weekday_sun', 'Sun'),
    };
    const anchor = anchorOverride || firstEventDay || new Date();

    if (error) return <ErrorText error={error} errorCode={errorCode} />;

    if (isLoading) return <SkeletonLines lines={4} />;
    if (rows.length === 0) return <EmptyText text={emptyText} />;
    // Rows arrived and NONE of them has a readable date: a wrong dateKey drew a
    // complete, entirely blank calendar that looked exactly like a quiet month.
    if (buckets.size === 0) {
        return (
            <EmptyText
                text={mode === 'edit'
                    ? t('studio_apps_runtime.calendar.no_usable_date', 'No row has a usable date in “{field}” — check which field holds the date.', { field: dateKey })
                    : emptyText}
            />
        );
    }

    const isRun = mode === 'run';
    const clickable = isRun && !!node.onRowClick;
    const fireRow = (row: CalendarRow) => { if (clickable && node.onRowClick) runAction(node.onRowClick, { formValues: row, item: row }); };

    const chip = (entry: { row: CalendarRow; }, i: string | number | bigint | null) => {
        const roleRaw = colorKey ? walkPath(entry.row, colorKey) : null;
        const color = typeof roleRaw === 'string' && ROLE_COLORS[roleRaw] ? ROLE_COLORS[roleRaw] : 'var(--app-primary)';
        return (
            <button
                key={i}
                type="button"
                data-app-calendar-event="true"
                onClick={() => fireRow(entry.row)}
                disabled={!clickable}
                className="w-full text-left text-[11px] font-medium truncate rounded px-1 py-0.5 disabled:cursor-default"
                style={{ color, background: 'color-mix(in srgb, currentColor 12%, transparent)' }}
                title={String(walkPath(entry.row, titleKey) ?? '')}
            >
                {displayValue(walkPath(entry.row, titleKey))}
            </button>
        );
    };

    // ── list view (cheap fallback) ─────────────────────────────────────────
    if (view === 'list') {
        const dated = rows
            .map((row) => ({ row, day: parseDay(walkPath(row, dateKey)) }))
            .filter((e): e is { row: CalendarRow; day: Date } => e.day !== null)
            .sort((a, b) => a.day.getTime() - b.day.getTime());
        if (dated.length === 0) return <EmptyText text={emptyText} />;
        return (
            <ol className="flex flex-col gap-1.5" data-app-calendar="list">
                {dated.map(({ row, day }, i) => (
                    <li key={i}>
                        <button
                            type="button"
                            data-app-calendar-event="true"
                            onClick={() => fireRow(row)}
                            disabled={!clickable}
                            className="w-full flex items-center gap-3 border px-2.5 py-1.5 text-left disabled:cursor-default [background:var(--bg-card)] [border-color:var(--border-default)] [border-radius:var(--app-radius)]"
                        >
                            <span className="text-xs tabular-nums shrink-0 text-[var(--text-muted)]">
                                {day.toLocaleDateString()}
                            </span>
                            <span className="text-sm font-medium truncate text-[var(--text-primary)]">
                                {displayValue(walkPath(row, titleKey))}
                            </span>
                        </button>
                    </li>
                ))}
            </ol>
        );
    }

    // ── month / week grids ─────────────────────────────────────────────────
    const isWeek = view === 'week';
    const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const gridStart = isWeek ? mondayOf(anchor) : mondayOf(monthStart);
    const dayCount = isWeek ? 7 : 42;
    const days = Array.from({ length: dayCount }, (_, i) => addDays(gridStart, i));

    const step = (dir: number) => {
        if (isWeek) setAnchorOverride(addDays(anchor, dir * 7));
        else setAnchorOverride(new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1));
    };
    const headingLabel = isWeek
        ? `${gridStart.toLocaleDateString()} – ${addDays(gridStart, 6).toLocaleDateString()}`
        : anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

    const todayKey = dayKey(new Date());

    // The calendar has always offered the `height` knob and never read it — a
    // control that does nothing is the same defect class this wave is clearing,
    // so it gets implemented rather than removed. The day grid grows; the
    // month/week header stays put.
    const fill = isFill(node);

    return (
        <div
            className={`w-full min-w-0 flex flex-col gap-2${fill ? ' app-fill h-full min-h-0' : ''}`}
            data-app-calendar={isWeek ? 'week' : 'month'}
        >
            <div className={`flex items-center justify-between gap-2${fill ? ' shrink-0' : ''}`}>
                <span className="text-sm font-semibold text-[var(--text-primary)]" data-app-calendar-heading="true">
                    {headingLabel}
                </span>
                <div className="flex items-center gap-1">
                    <button
                        type="button" onClick={() => step(-1)} aria-label={isWeek ? t('studio_apps_runtime.calendar.previous_week', 'Previous week') : t('studio_apps_runtime.calendar.previous_month', 'Previous month')}
                        className="inline-flex items-center px-1.5 py-1 border [border-color:var(--border-default)] [border-radius:var(--app-radius)] [color:var(--text-secondary)]"
                    >
                        <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                    <button
                        type="button" onClick={() => step(1)} aria-label={isWeek ? t('studio_apps_runtime.calendar.next_week', 'Next week') : t('studio_apps_runtime.calendar.next_month', 'Next month')}
                        className="inline-flex items-center px-1.5 py-1 border [border-color:var(--border-default)] [border-radius:var(--app-radius)] [color:var(--text-secondary)]"
                    >
                        <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                </div>
            </div>
            <div className={`grid grid-cols-7 gap-px text-center${fill ? ' shrink-0' : ''}`}>
                {WEEKDAYS.map((d) => (
                    <span key={d} className="text-[11px] font-medium py-1 text-[var(--text-muted)]">{WEEKDAY_LABELS[d]}</span>
                ))}
            </div>
            <AppCalendarSection fill={fill} days={days} buckets={buckets} isWeek={isWeek} anchor={anchor} todayKey={todayKey} expandedDay={expandedDay} chip={chip} setExpandedDay={setExpandedDay} t={t} />
        </div>
    );
}

function AppCalendarSection({ fill, days, buckets, isWeek, anchor, todayKey, expandedDay, chip, setExpandedDay, t }: { fill: boolean; days: Date[]; buckets: Map<string, { row: CalendarRow; start: Date; }[]>; isWeek: boolean; anchor: Date; todayKey: string; expandedDay: string | null; chip: (entry: { row: CalendarRow; }, i: string | number | bigint | null) => JSX.Element; setExpandedDay: Dispatch<SetStateAction<string | null>>; t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; }) {
    return <div
        className={`grid grid-cols-7 gap-px border${fill ? ' flex-1 min-h-0 overflow-y-auto' : ' overflow-hidden'} [background:var(--border-subtle,var(--border-default))] [border-color:var(--border-default)] [border-radius:var(--app-radius)]`}
    >
        {days.map((day) => {
            const key = dayKey(day);
            const entries = buckets.get(key) || [];
            const inMonth = isWeek || day.getMonth() === anchor.getMonth();
            return (
                <div
                    key={key}
                    data-app-calendar-day={key}
                    className="min-h-[72px] p-1 flex flex-col gap-0.5"
                    // The whole cell used to fade to 0.45, on top of
                    // tokens that are already low-contrast — the day
                    // numbers and the still-clickable chips went well
                    // past unreadable. Only the day number dims now.
                    style={{ background: inMonth ? 'var(--bg-card)' : 'var(--bg-secondary)' }}
                >
                    <span
                        className={`text-[11px] tabular-nums self-end ${key === todayKey ? 'font-bold' : ''}`}
                        style={{ color: key === todayKey ? 'var(--app-primary)' : (inMonth ? 'var(--text-secondary)' : 'var(--text-muted)') }}
                    >
                        {day.getDate()}
                    </span>
                    {(expandedDay === key ? entries : entries.slice(0, MAX_CHIPS_PER_DAY)).map((entry, i) => chip(entry, i))}
                    {entries.length > MAX_CHIPS_PER_DAY ? (
                        // Was an inert <span>: the 4th and later events
                        // on a day could not be reached at all.
                        <button
                            type="button"
                            onClick={() => setExpandedDay(expandedDay === key ? null : key)}
                            className="text-[11px] px-1 text-left underline decoration-dotted focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--text-secondary)] [color:var(--text-secondary)]!"
                            aria-expanded={expandedDay === key}
                        >
                            {t('studio_apps_runtime.calendar.more', '+{n} more', { n: entries.length - MAX_CHIPS_PER_DAY })}
                        </button>
                    ) : null}
                </div>
            );
        })}
    </div>;
}
