import { Check, X } from 'lucide-react';
import React, { useMemo } from 'react';
import { formatCalDate, parseDay, resolveNow } from './calendarMath';
import { useTranslation } from '../../../../hooks/useTranslation';

/**
 * TimelinePhases — a framework's phased entry into force as one horizontal
 * track (Compliance Center redesign, Sep 2026; artboard 1e "AI Act —
 * fasering", now the framework page's Timeline tab).
 *
 * Time is an axis here, not a list: every phase sits at its PROPORTIONAL
 * position between the first and the last date, so a reader sees at a
 * glance that Art. 50 came two years after the literacy duty and that
 * Annex III is still a year out. The 72px track (measurements literal from
 * the artboard):
 *
 *   base line       2px `--bg-tertiary` at top 9px, full width
 *   progressed      2px `--text-primary` from the left edge to today
 *   markers 20px    done    = ink disc (`--text-primary`) with a Check glyph
 *                   missed  = `--error` disc with an X glyph
 *                   upcoming= 2px `--warning` ring on `--bg-card`
 *                   future  = 2px `--border-default` ring on `--bg-card`
 *   today           a 2px × 28px line in `--kind-compliance` with "today" in
 *                   9px uppercase beneath it — the only kind-coloured element
 *   labels 10px     the SHORT title (bold, truncated: 16ch, growing to 28ch
 *                   on a 1100px track), then the
 *                   date and `daysLeft` in warning ink ("79 d")
 *
 * The subtitle never prints on the track: as a nowrap line it ran over its
 * neighbours and off the card. It is in the label's tooltip and in the
 * screen-reader text (title + subtitle), and the calendar list under the
 * track prints it in full.
 *
 * Glyphs on the discs are `--bg-card`, not `--bg-primary`: the glass themes
 * set `--bg-primary: transparent`, which would make the check vanish.
 *
 * Positions are clamped to the track, and the first and last labels anchor
 * to their edge (left / right aligned) while every other label is centred
 * under its marker with `translateX(-50%)` — so the end labels never hang
 * outside the card. A single phase, or phases on one date, all sit at 0.
 *
 * Labels of phases that sit close together drop to a second (or third) row
 * instead of printing over each other. The track grows by one label row per
 * extra row.
 *
 * Narrow: the component is its own `@container`; below 640px the proportional
 * track gives way to a vertical stepper (one row per phase, with a "today"
 * divider), where a phone has room for the whole title.
 *
 * `state` is the CALLER's word (the server knows whether a passed phase was
 * met); this component never derives done/missed from the date alone.
 *
 * Props
 *   phases  [{ date, title, subtitle?, state: 'done'|'missed'|'upcoming'|'future', daysLeft? }]
 *   now     ms or Date; today's marker and the progressed segment follow it
 */
export default function TimelinePhases({ phases, now, className = '', testId = 'timeline-phases' }) {
    const { t, resolvedLocale } = useTranslation();
    const locale = resolvedLocale || 'en';
    const nowMs = resolveNow(now);

    const layout = useMemo(() => layoutPhases(phases, nowMs), [phases, nowMs]);
    if (!layout) return null;
    const { items, todayPct, rows } = layout;
    const todayWord = t('compliance.tl_today', 'today');
    const dateOf = (p) => formatCalDate(p.date, { locale, year: 'always' });
    const countdown = (p) => (hasDays(p) ? t('compliance.tl_days_left', '{days} d', { days: p.daysLeft }) : null);
    // Today sits after the last phase that is not later than today.
    const todayIndex = items.filter(p => p.ms <= (parseDay(nowMs) ?? nowMs)).length;

    return (
        <div className={`@container ${className}`} data-testid={testId}>
            <div className={`relative ${TRACK_HEIGHT[rows - 1]} @max-[640px]:hidden`} data-testid={`${testId}-track`} role="list" data-rows={rows}>
                <div className="absolute left-0 right-0 top-[9px] h-[2px] bg-[var(--bg-tertiary)]" aria-hidden="true" />
                <div
                    className="absolute left-0 top-[9px] h-[2px] bg-[var(--text-primary)]"
                    style={{ width: `${todayPct}%` }}
                    data-testid={`${testId}-progress`}
                    aria-hidden="true"
                />

                {items.map((p, i) => {
                    const first = i === 0;
                    const last = i === items.length - 1 && items.length > 1;
                    const anchor = first ? 'left' : last ? 'right' : 'center';
                    const pos = anchor === 'left' ? { left: 0 }
                        : anchor === 'right' ? { right: 0 }
                            : { left: `${p.pct}%`, transform: 'translateX(-50%)' };
                    const align = ALIGN[anchor];
                    const full = p.subtitle ? `${p.title} — ${p.subtitle}` : p.title;
                    const days = countdown(p);
                    return (
                        <div
                            key={`${p.date}-${i}`}
                            role="listitem"
                            className={`absolute top-0 flex flex-col gap-[6px] ${align}`}
                            style={pos}
                            data-testid={`${testId}-phase`}
                            data-state={p.state}
                            data-pct={p.pct}
                        >
                            <Marker state={p.state} />
                            <span
                                className={`flex flex-col ${align} text-[10px] leading-[13px] text-[var(--text-secondary)] ${LABEL_OFFSET[p.row]}`}
                                title={full}
                                data-row={p.row}
                                data-testid={`${testId}-label`}
                            >
                                <b className={`block ${TITLE_CAP} truncate font-semibold text-[var(--text-primary)]`} aria-hidden="true">{p.title}</b>
                                <span className="sr-only">{full}</span>
                                <span className="whitespace-nowrap">
                                    {dateOf(p)}
                                    {days ? <>{' · '}<span className="text-[var(--warning-ink)]" data-testid={`${testId}-days`}>{days}</span></> : null}
                                </span>
                            </span>
                        </div>
                    );
                })}

                <div
                    className="absolute top-[-4px] flex flex-col items-center"
                    style={{ left: `${todayPct}%`, transform: 'translateX(-50%)' }}
                    data-testid={`${testId}-today`}
                    aria-hidden="true"
                >
                    <span className="w-[2px] h-[28px] bg-[var(--kind-compliance)]" />
                    <span className="mt-[2px] text-[9px] font-semibold uppercase tracking-[.06em] whitespace-nowrap text-[var(--kind-compliance)]">
                        {todayWord}
                    </span>
                </div>
            </div>

            <ol className="hidden @max-[640px]:flex flex-col m-0 p-0 list-none" data-testid={`${testId}-stepper`}>
                {items.map((p, i) => {
                    const days = countdown(p);
                    const step = (
                        <li key={`${p.date}-${i}`} className="relative flex gap-2.5 pb-3 last:pb-0" data-testid={`${testId}-step`} data-state={p.state}>
                            {i < items.length - 1 && <span className="absolute left-[9px] top-5 bottom-0 w-[2px] bg-[var(--bg-tertiary)]" aria-hidden="true" />}
                            <Marker state={p.state} />
                            <span className="min-w-0 flex flex-col text-[11px] leading-4" title={p.subtitle || undefined}>
                                <span className="font-semibold text-[var(--text-primary)]">{p.title}</span>
                                {p.subtitle ? <span className="sr-only">{p.subtitle}</span> : null}
                                <span className="text-[var(--text-secondary)]">
                                    {dateOf(p)}
                                    {days ? <>{' · '}<span className="text-[var(--warning-ink)]">{days}</span></> : null}
                                </span>
                            </span>
                        </li>
                    );
                    if (i !== todayIndex) return step;
                    return [<TodayStep key="today" label={todayWord} testId={`${testId}-step-today`} />, step];
                })}
                {todayIndex === items.length && <TodayStep label={todayWord} testId={`${testId}-step-today`} />}
            </ol>
        </div>
    );
}

const hasDays = (p) => p.daysLeft !== undefined && p.daysLeft !== null;

/** Labels closer than this (in % of the track) go to separate rows. */
const MIN_LABEL_GAP_PCT = 24;
/** How far a first-row label keeps from the "today" word. */
const TODAY_GAP_PCT = 11;
const MAX_LABEL_ROWS = 3;
// One label row is two 13px lines plus breathing room (30px). Literal classes
// so Tailwind sees them: the track grows by a row, a label drops by its row.
const TRACK_HEIGHT = Object.freeze(['h-[72px]', 'h-[102px]', 'h-[132px]']);
const LABEL_OFFSET = Object.freeze(['', 'mt-[30px]', 'mt-[60px]']);
// The title's cap grows with the track but stays under 16 % of it: two
// labels 24 % apart then never touch, even when one is anchored to an edge
// (cap + cap/2 ≤ 24 %). Literal classes so Tailwind sees them.
const TITLE_CAP = 'max-w-[16ch] @min-[900px]:max-w-[23ch] @min-[1000px]:max-w-[25ch] @min-[1100px]:max-w-[28ch]';
const ALIGN = Object.freeze({ left: 'items-start text-left', right: 'items-end text-right', center: 'items-center text-center' });

const GLYPH = { width: 11, height: 11, color: 'var(--bg-card)' };

function Marker({ state }) {
    const base = 'relative grid place-items-center w-5 h-5 rounded-full box-border shrink-0';
    if (state === 'done') {
        return <span className={`${base} bg-[var(--text-primary)]`}><Check style={GLYPH} aria-hidden="true" /></span>;
    }
    if (state === 'missed') {
        return <span className={`${base} bg-[var(--error)]`}><X style={GLYPH} aria-hidden="true" /></span>;
    }
    if (state === 'upcoming') {
        return <span className={`${base} bg-[var(--bg-card)] border-2 border-[var(--warning)]`} />;
    }
    return <span className={`${base} bg-[var(--bg-card)] border-2 border-[var(--border-default)]`} />;
}

/** The stepper's "today" divider: a short kind-coloured rule with the word. */
function TodayStep({ label, testId }) {
    return (
        <li className="relative flex items-center gap-2.5 pb-3" data-testid={testId} aria-hidden="true">
            <span className="absolute left-[9px] top-0 bottom-0 w-[2px] bg-[var(--bg-tertiary)]" />
            <span className="relative w-5 h-[2px] bg-[var(--kind-compliance)]" />
            <span className="text-[9px] font-semibold uppercase tracking-[.06em] text-[var(--kind-compliance)]">{label}</span>
        </li>
    );
}

/**
 * Positions (0–100, clamped) for each parseable phase, in date order, plus
 * today's position on the same scale. Null when no phase has a date.
 * Exported for the test; the component is the only production caller.
 */
export function layoutPhases(phases, nowMs) {
    const dated = (Array.isArray(phases) ? phases : [])
        .map(p => ({ ...p, ms: parseDay(p?.date) }))
        .filter(p => p.ms !== null)
        .sort((a, b) => a.ms - b.ms);
    if (!dated.length) return null;
    const t0 = dated[0].ms;
    const t1 = dated[dated.length - 1].ms;
    const span = t1 - t0;
    const pctOf = (ms) => {
        if (span <= 0) return 0;
        return Math.round(Math.max(0, Math.min(1, (ms - t0) / span)) * 1000) / 10;
    };
    const todayPct = pctOf(parseDay(nowMs) ?? nowMs);
    // Greedy rows: each label takes the first row where it keeps
    // MIN_LABEL_GAP_PCT from every label already there. The "today" word sits
    // at the height of the first row, so that row also keeps TODAY_GAP_PCT
    // from today. MAX_LABEL_ROWS caps the height; a label that fits in no row
    // goes to the last one. TITLE_CAP keeps a label under 16 % of the track,
    // so 24 % apart clears even an edge-anchored label. An edge label runs
    // its whole width toward the middle, so it keeps twice the gap from today.
    const placed = [];
    const fits = (row, pct, edge) => (placed[row] || []).every(q => Math.abs(pct - q) >= MIN_LABEL_GAP_PCT)
        && (row !== 0 || Math.abs(pct - todayPct) >= TODAY_GAP_PCT * (edge ? 2 : 1));
    const items = dated.map((p, i) => {
        const pct = pctOf(p.ms);
        const edge = i === 0 || i === dated.length - 1;
        let row = 0;
        while (row < MAX_LABEL_ROWS - 1 && !fits(row, pct, edge)) row += 1;
        (placed[row] = placed[row] || []).push(pct);
        return { ...p, pct, row };
    });
    return { items, todayPct, rows: Math.max(1, placed.length) };
}
