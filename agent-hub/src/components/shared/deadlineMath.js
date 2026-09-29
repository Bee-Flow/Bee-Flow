/**
 * deadlineMath — ONE clock for every compliance deadline (Compliance Center
 * redesign, Sep 2026).
 *
 * Three private countdowns used to live in the hub — the DSR inbox's 30-day
 * `Countdown`, the incident page's 72-hour `DeadlineCountdown`, the training
 * page's `DueBadge` — each with its own rounding and its own idea of "urgent".
 * A deadline that reads "3 days" on one screen and "2 days" on the next is
 * the kind of disagreement a supervisory authority does not forgive, so the
 * arithmetic is one pure function and every surface (the row clock, the
 * drawer block, the rail meta, the header pill) renders what it returns.
 *
 * The caller decides what URGENT means (`urgentBelowMs`): a DSR is urgent
 * with 5 days left, an incident with 24 hours, a CRA early warning with 6 —
 * those numbers are regulation, not presentation, and belong beside the data
 * that carries the due date (GET /deadlines sends `state` along for exactly
 * that reason; when it does, DeadlineClock lets the server win).
 *
 * Pure, React-free and without a single English word on purpose: the labels
 * live in DeadlineClock.jsx behind t(), this file only knows numbers.
 */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/**
 * The unit rule: a window of a week or more is a calendar affair and counts
 * in DAYS (the 30-day DSR clock, even when 3 days are left); anything shorter
 * is a stopwatch and counts in HOURS (72 h breach notification, 24 h CRA
 * early warning) — "still 2 days" on a 72-hour clock hides a third of it.
 */
export const DAYS_WINDOW_MS = 7 * DAY_MS;

export const CLOCK_STATES = Object.freeze(['ok', 'urgent', 'overdue', 'done', 'none']);

/** Date | epoch ms | ISO string → epoch ms, or null for anything unreadable. */
export function toMs(value) {
    if (value === null || value === undefined || value === '') return null;
    const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
}

function ceilUnits(ms, unitMs) {
    return Math.ceil(Math.abs(ms) / unitMs);
}

function clamp01(n) {
    if (!Number.isFinite(n)) return 0;
    return Math.min(1, Math.max(0, n));
}

/**
 * clockState({ dueAt, startedAt, now, urgentBelowMs, doneAt, unit })
 *   → { state, pct, remainingMs, unit, value, overdueValue, completedInDays }
 *
 *   state        'ok' | 'urgent' | 'overdue' | 'done' | 'none'
 *   pct          elapsed share of the window, clamped 0..1; 1 once overdue or
 *                done; 0 when the window has no known start (nothing honest to
 *                draw — the label carries the meaning, the bar stays empty)
 *   remainingMs  dueAt − now (negative once overdue); null without a due date
 *   unit         'days' | 'hours' per the window rule above; an explicit
 *                `unit` option overrides it for callers that know better
 *   value        |remaining| in that unit, rounded UP — "still 18 days" for
 *                17 d 6 h, "overdue by 3 days" for 2 d 10 h late
 *   overdueValue the same number when overdue, else 0
 *   completedInDays  for 'done': whole days from startedAt to doneAt (ceil,
 *                min 1 — a request closed the same day was not done in 0
 *                days); null when the start is unknown
 *
 * No dueAt → 'none' (a register with nothing open). doneAt → 'done', whatever
 * the due date says: a closed clock stops ticking.
 */
export function clockState({ dueAt, startedAt, now, urgentBelowMs, doneAt, unit: unitOverride } = {}) {
    const due = toMs(dueAt);
    const start = toMs(startedAt);
    const done = toMs(doneAt);
    const nowMs = toMs(now) ?? Date.now();

    if (done !== null) {
        const completedInDays = start !== null && done >= start ? Math.max(1, ceilUnits(done - start, DAY_MS)) : null;
        const late = due !== null && done > due;
        const unit = resolveUnit(unitOverride, start, due);
        return {
            state: 'done',
            pct: 1,
            remainingMs: due !== null ? due - done : null,
            unit,
            value: completedInDays,
            overdueValue: late ? ceilUnits(done - due, unit === 'days' ? DAY_MS : HOUR_MS) : 0,
            completedInDays,
        };
    }

    if (due === null) {
        return { state: 'none', pct: 0, remainingMs: null, unit: null, value: null, overdueValue: 0, completedInDays: null };
    }

    const remainingMs = due - nowMs;
    const unit = resolveUnit(unitOverride, start, due);
    const unitMs = unit === 'days' ? DAY_MS : HOUR_MS;
    const value = ceilUnits(remainingMs, unitMs);
    const overdue = remainingMs < 0;
    const urgent = !overdue && Number.isFinite(urgentBelowMs) && urgentBelowMs > 0 && remainingMs <= urgentBelowMs;

    let pct;
    if (overdue) pct = 1;
    else if (start !== null && due > start) pct = clamp01((nowMs - start) / (due - start));
    else pct = 0;

    return {
        state: overdue ? 'overdue' : urgent ? 'urgent' : 'ok',
        pct,
        remainingMs,
        unit,
        value,
        overdueValue: overdue ? value : 0,
        completedInDays: null,
    };
}

/**
 * Days when the window is a week or longer; hours when it is shorter. A
 * deadline whose start is unknown is a date on a calendar, not a stopwatch
 * (a training due date, an obligation) — days.
 */
function resolveUnit(override, start, due) {
    if (override === 'days' || override === 'hours') return override;
    if (start !== null && due !== null && due > start) return due - start >= DAYS_WINDOW_MS ? 'days' : 'hours';
    return 'days';
}

/** `pct` from the server (0..1, or 0..100 from a lax producer) → 0..1, or null when unusable. */
export function normalisePct(pct) {
    if (pct === null || pct === undefined) return null;
    const n = Number(pct);
    if (!Number.isFinite(n)) return null;
    return clamp01(n > 1 ? n / 100 : n);
}

/** A `state` from the server is only trusted when it is one of ours. */
export function isClockState(state) {
    return CLOCK_STATES.includes(state);
}
