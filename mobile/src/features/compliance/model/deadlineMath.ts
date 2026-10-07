/**
 * One clock for every compliance deadline: port of
 * agent-hub/src/components/shared/deadlineMath.js (pinned by a differential
 * test), plus `resolveClock` from shared/DeadlineClock.jsx, the merge where
 * the server's `state` and `pct` win over the local maths.
 *
 * Pure and without a single English word: the labels are in clockLabels.ts.
 */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/** A window of a week or more counts in days; anything shorter in hours. */
export const DAYS_WINDOW_MS = 7 * DAY_MS;

/** An hours clock more than 48 hours late counts in days from then on. */
export const OVERDUE_IN_DAYS_AFTER_MS = 48 * HOUR_MS;

export const CLOCK_STATES = Object.freeze(['ok', 'urgent', 'overdue', 'done', 'none'] as const);

export type ClockStateName = (typeof CLOCK_STATES)[number];
export type ClockUnit = 'days' | 'hours';
export type TimeLike = Date | number | string | null | undefined;

export interface ClockResult {
    state: ClockStateName;
    pct: number;
    remainingMs: number | null;
    unit: ClockUnit | null;
    value: number | null;
    overdueValue: number;
    completedInDays: number | null;
}

export interface ClockInput {
    dueAt?: TimeLike;
    startedAt?: TimeLike;
    now?: TimeLike;
    urgentBelowMs?: number;
    doneAt?: TimeLike;
    unit?: ClockUnit;
}

/** Date | epoch ms | ISO string → epoch ms, or null for anything unreadable. */
export function toMs(value: TimeLike): number | null {
    if (value === null || value === undefined || value === '') return null;
    const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
}

/** `value` plus whole calendar months (UTC), the end clamped to the target month's last day. */
export function addCalendarMonths(value: TimeLike, months: number): number | null {
    const ms = toMs(value);
    if (ms === null || !Number.isInteger(months)) return null;
    const d = new Date(ms);
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + months);
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, lastDay));
    return d.getTime();
}

const ceilUnits = (ms: number, unitMs: number) => Math.ceil(Math.abs(ms) / unitMs);

function clamp01(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return Math.min(1, Math.max(0, n));
}

function resolveUnit(override: ClockUnit | undefined, start: number | null, due: number | null): ClockUnit {
    if (override === 'days' || override === 'hours') return override;
    if (start !== null && due !== null && due > start) return due - start >= DAYS_WINDOW_MS ? 'days' : 'hours';
    return 'days';
}

function doneClock(done: number, start: number | null, due: number | null, override: ClockUnit | undefined): ClockResult {
    const completedInDays = start !== null && done >= start ? Math.max(1, ceilUnits(done - start, DAY_MS)) : null;
    const late = due !== null && done > due;
    const unit = resolveUnit(override, start, due);
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

function isUrgent(remainingMs: number, urgentBelowMs: number | undefined): boolean {
    return urgentBelowMs !== undefined && Number.isFinite(urgentBelowMs) && urgentBelowMs > 0 && remainingMs <= urgentBelowMs;
}

/** The elapsed share of the window; 0 when its start is unknown. */
function elapsedShare(start: number | null, due: number, nowMs: number): number {
    return start !== null && due > start ? clamp01((nowMs - start) / (due - start)) : 0;
}

/** The state of one deadline: see the web file for the full contract. */
export function clockState({ dueAt, startedAt, now, urgentBelowMs, doneAt, unit: unitOverride }: ClockInput = {}): ClockResult {
    const due = toMs(dueAt);
    const start = toMs(startedAt);
    const done = toMs(doneAt);
    const nowMs = toMs(now) ?? Date.now();

    if (done !== null) return doneClock(done, start, due, unitOverride);
    if (due === null) return { state: 'none', pct: 0, remainingMs: null, unit: null, value: null, overdueValue: 0, completedInDays: null };

    const remainingMs = due - nowMs;
    let unit = resolveUnit(unitOverride, start, due);
    if (unit === 'hours' && unitOverride !== 'hours' && -remainingMs > OVERDUE_IN_DAYS_AFTER_MS) unit = 'days';
    const value = ceilUnits(remainingMs, unit === 'days' ? DAY_MS : HOUR_MS);
    const overdue = remainingMs < 0;
    const urgent = !overdue && isUrgent(remainingMs, urgentBelowMs);
    const pct = overdue ? 1 : elapsedShare(start, due, nowMs);
    return { state: overdue ? 'overdue' : urgent ? 'urgent' : 'ok', pct, remainingMs, unit, value, overdueValue: overdue ? value : 0, completedInDays: null };
}

/** `pct` from the server (0..1, or 0..100 from a lax producer) → 0..1, or null when unusable. */
export function normalisePct(pct: unknown): number | null {
    if (pct === null || pct === undefined) return null;
    const n = Number(pct);
    if (!Number.isFinite(n)) return null;
    return clamp01(n > 1 ? n / 100 : n);
}

/** A `state` from the server is only trusted when it is one of ours. */
export function isClockState(state: unknown): state is ClockStateName {
    return typeof state === 'string' && (CLOCK_STATES as readonly string[]).includes(state);
}

export interface ResolveInput extends ClockInput {
    state?: unknown;
    pct?: unknown;
}

/** Local maths and the server's verdict, merged: state and pct from the server when it sent them. */
export function resolveClock({ dueAt, startedAt, doneAt, state, pct, urgentBelowMs, now }: ResolveInput): ClockResult {
    const math = clockState({ dueAt, startedAt, doneAt, now, urgentBelowMs });
    const serverPct = normalisePct(pct);
    const resolvedState = isClockState(state) ? state : math.state;
    const closed = resolvedState === 'done' || resolvedState === 'none';
    return {
        ...math,
        state: resolvedState,
        pct: closed ? (resolvedState === 'done' ? 1 : 0) : (serverPct ?? (resolvedState === 'overdue' ? 1 : math.pct)),
    };
}
