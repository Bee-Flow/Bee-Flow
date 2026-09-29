import React, { useEffect, useState } from 'react';
import { Timer } from 'lucide-react';
import useTranslation from '../../hooks/useTranslation';
import { TONES, toneOfClock } from './statusTone';
import { clockState, isClockState, normalisePct } from './deadlineMath';

/**
 * DeadlineClock — the one termijn-component of the Compliance Center
 * (artboards 1a/1c/1h and the rail): 30 days, 72 hours, 24 hours, one look.
 *
 * Four variants, one vocabulary:
 *   row     the 104px column of a register table / the Deadlines card —
 *           11px semibold label in the tone's INK with a Timer glyph, then a
 *           3px bar filled to the elapsed share in the tone's RAW colour;
 *   block   the drawer's headline (1c) — padded box on an 8 % tint of the
 *           raw tone, 15px/700 label, 4px bar, optional meta line as children
 *           ("received 12 Aug 14:02 · due 11 Sep · not extended");
 *   inline  text only — the attention list's meta, the header pill;
 *   rail    Timer + the shortest possible value ("1", "41 h") beside a rail
 *           row's count.
 *
 * The arithmetic is deadlineMath.clockState; the caller passes the regulation
 * (`urgentBelowMs`: 5 days for a DSR, 24 h for an incident, 6 h for a CRA
 * early warning). When the server already judged the clock (GET /deadlines
 * sends `state` and `pct`), those WIN over the local math — the server holds
 * the extension and the authority's own clock, the browser holds a possibly
 * wrong wall clock. The label's number still comes from the math, because
 * the server sends no words.
 *
 * A closed clock has no bar: 'done' and 'none' render as quiet tertiary text
 * ("completed in 18 days", "no open deadline"), the rail variant renders
 * nothing at all for them — a rail row shows OPEN clocks.
 *
 * `useNow(60 s)` keeps the labels right without a refetch; a 72-hour clock
 * that still said "still 41 hours" an hour later would be lying.
 */

/** The wall clock, re-read every `intervalMs` (0 or less: read once). */
export function useNow(intervalMs = 60_000) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!(intervalMs > 0)) return undefined;
        const id = setInterval(() => setNow(Date.now()), intervalMs);
        return () => clearInterval(id);
    }, [intervalMs]);
    return now;
}

/**
 * The sentence for a resolved clock. Exported so a host that has no room for
 * the component (a `title`, a toast) can still say the same thing.
 */
export function clockLabel(t, { state, unit, value, completedInDays }, doneLabel) {
    if (state === 'none') return t('compliance.clock_none', 'no open deadline');
    if (state === 'done') {
        if (doneLabel) return doneLabel;
        if (completedInDays !== null && completedInDays !== undefined) {
            return t('compliance.clock_done_in_days', 'completed in {days} days', { days: completedInDays });
        }
        return t('compliance.clock_done', 'completed');
    }
    const n = value ?? 0;
    if (state === 'overdue') {
        return unit === 'hours'
            ? t('compliance.clock_hours_overdue', 'overdue by {hours} hours', { hours: n })
            : t('compliance.clock_days_overdue', 'overdue by {days} days', { days: n });
    }
    return unit === 'hours'
        ? t('compliance.clock_hours_left', 'still {hours} hours', { hours: n })
        : t('compliance.clock_days_left', 'still {days} days', { days: n });
}

/** The rail's short form: a bare day count, or "{n} h". */
export function clockShortLabel(t, { unit, value }) {
    const n = value ?? 0;
    return unit === 'hours'
        ? t('compliance.clock_short_hours', '{hours} h', { hours: n })
        : t('compliance.clock_short_days', '{days}', { days: n });
}

/** Local math + the server's verdict, merged: state/pct from the server when it sent one. */
export function resolveClock({ dueAt, startedAt, doneAt, state, pct, urgentBelowMs, now }) {
    const math = clockState({ dueAt, startedAt, doneAt, now, urgentBelowMs });
    const serverPct = normalisePct(pct);
    const resolvedState = isClockState(state) ? state : math.state;
    // A server 'done'/'none' with local numbers still attached would print
    // "still 3 days" under a closed clock — the closed states draw no number.
    const closed = resolvedState === 'done' || resolvedState === 'none';
    return {
        ...math,
        state: resolvedState,
        pct: closed ? (resolvedState === 'done' ? 1 : 0) : (serverPct ?? (resolvedState === 'overdue' ? 1 : math.pct)),
    };
}

export default function DeadlineClock({
    dueAt = null,
    startedAt = null,
    doneAt = null,
    state = undefined,
    pct = undefined,
    urgentBelowMs = undefined,
    variant = 'row',
    doneLabel = undefined,
    className = '',
    testId = undefined,
    children = null,
}) {
    const { t } = useTranslation();
    const now = useNow();
    const clock = resolveClock({ dueAt, startedAt, doneAt, state, pct, urgentBelowMs, now });
    const tone = toneOfClock(clock.state);
    const { raw, ink } = TONES[tone];
    const label = clockLabel(t, clock, doneLabel);
    const closed = clock.state === 'done' || clock.state === 'none';
    const data = {
        'data-testid': testId,
        'data-state': clock.state,
        'data-unit': clock.unit || undefined,
        'data-tone': tone,
    };

    if (variant === 'rail') {
        if (closed) return null;
        return (
            <span
                {...data}
                className={`inline-flex items-center gap-[3px] text-[11px] font-semibold tabular-nums ${className}`.trim()}
                style={{ color: ink }}
                title={label}
            >
                <Timer size={11} aria-hidden="true" />
                {clockShortLabel(t, clock)}
            </span>
        );
    }

    if (variant === 'inline') {
        return (
            <span {...data} className={`text-[11px] font-semibold ${className}`.trim()} style={{ color: ink }}>
                {label}
            </span>
        );
    }

    if (variant === 'block') {
        return (
            <div
                {...data}
                className={`flex flex-col gap-1.5 p-3 rounded-[10px] ${className}`.trim()}
                style={{ background: `color-mix(in srgb, ${raw} 8%, transparent)` }}
            >
                <div className="flex items-center gap-1.5 text-[15px] font-bold leading-tight" style={{ color: ink }}>
                    {!closed && <Timer size={15} aria-hidden="true" />}
                    {label}
                </div>
                {!closed && (
                    <div className="h-1 rounded-sm overflow-hidden bg-[var(--bg-card)]" aria-hidden="true">
                        <div className="h-full" data-testid={testId ? `${testId}-bar` : undefined} style={{ width: `${clock.pct * 100}%`, background: raw }} />
                    </div>
                )}
                {children && <div className="text-[11px] text-[var(--text-secondary)]">{children}</div>}
            </div>
        );
    }

    // row (default)
    if (closed) {
        return (
            <div {...data} className={`text-[11px] ${className}`.trim()} style={{ color: ink }}>
                {label}
            </div>
        );
    }
    return (
        <div {...data} className={`flex flex-col gap-1 min-w-0 ${className}`.trim()}>
            <div className="flex items-center gap-1 text-[11px] font-semibold whitespace-nowrap" style={{ color: ink }}>
                <Timer size={11} aria-hidden="true" className="flex-shrink-0" />
                <span className="truncate">{label}</span>
            </div>
            <div className="h-[3px] rounded-sm overflow-hidden bg-[var(--bg-tertiary)]" aria-hidden="true">
                <div className="h-full" data-testid={testId ? `${testId}-bar` : undefined} style={{ width: `${clock.pct * 100}%`, background: raw }} />
            </div>
        </div>
    );
}
