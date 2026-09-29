import React, { useMemo } from 'react';
import { Check, X } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { parseDay, resolveNow } from './calendarMath';

/**
 * TimelinePhases — a framework's phased entry into force as one horizontal
 * track (Compliance Center redesign, Sep 2026; artboard 1e "AI Act —
 * fasering", also the framework page's Tijdlijn tab).
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
 *   labels 10px     bold date, subtitle in `--text-secondary`, `daysLeft` in
 *                   warning ink ("79 d")
 *
 * Glyphs on the discs are `--bg-card`, not `--bg-primary`: the glass themes
 * set `--bg-primary: transparent`, which would make the check vanish.
 *
 * Positions are clamped to the track, and the first and last labels anchor
 * to their edge (left / right aligned) while every other label is centred
 * under its marker with `translateX(-50%)` — so the end labels never hang
 * outside the card. A single phase, or phases on one date, all sit at 0.
 *
 * `state` is the CALLER's word (the server knows whether a passed phase was
 * met); this component never derives done/missed from the date alone.
 *
 * Props
 *   phases  [{ date, title, subtitle?, state: 'done'|'missed'|'upcoming'|'future', daysLeft? }]
 *   now     ms or Date; today's marker and the progressed segment follow it
 */
export default function TimelinePhases({ phases, now, className = '', testId = 'timeline-phases' }) {
    const { t } = useTranslation();
    const nowMs = resolveNow(now);

    const layout = useMemo(() => layoutPhases(phases, nowMs), [phases, nowMs]);
    if (!layout) return null;
    const { items, todayPct } = layout;

    return (
        <div className={`relative h-[72px] ${className}`} data-testid={testId} role="list">
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
                const align = anchor === 'left' ? 'items-start text-left'
                    : anchor === 'right' ? 'items-end text-right' : 'items-center text-center';
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
                        <span className="text-[10px] leading-[13px] text-[var(--text-secondary)] whitespace-nowrap">
                            <b className="font-semibold text-[var(--text-primary)]">{p.title}</b>
                            {p.subtitle ? <><br />{p.subtitle}</> : null}
                            {p.daysLeft !== undefined && p.daysLeft !== null ? (
                                <>
                                    {p.subtitle ? ' · ' : <br />}
                                    <span style={{ color: 'var(--warning-ink)' }}>
                                        {t('compliance.tl_days_left', '{days} d', { days: p.daysLeft })}
                                    </span>
                                </>
                            ) : null}
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
                    {t('compliance.tl_today', 'today')}
                </span>
            </div>
        </div>
    );
}

const GLYPH = { width: 11, height: 11, color: 'var(--bg-card)' };

function Marker({ state }) {
    const base = 'grid place-items-center w-5 h-5 rounded-full box-border shrink-0';
    if (state === 'done') {
        return <span className={`${base} bg-[var(--text-primary)]`}><Check style={GLYPH} aria-hidden="true" /></span>;
    }
    if (state === 'missed') {
        return <span className={`${base}`} style={{ background: 'var(--error)' }}><X style={GLYPH} aria-hidden="true" /></span>;
    }
    if (state === 'upcoming') {
        return <span className={`${base} bg-[var(--bg-card)]`} style={{ border: '2px solid var(--warning)' }} />;
    }
    return <span className={`${base} bg-[var(--bg-card)]`} style={{ border: '2px solid var(--border-default)' }} />;
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
    return {
        items: dated.map(p => ({ ...p, pct: pctOf(p.ms) })),
        todayPct: pctOf(parseDay(nowMs) ?? nowMs),
    };
}
