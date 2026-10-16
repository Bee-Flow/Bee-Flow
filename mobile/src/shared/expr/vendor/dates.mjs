/**
 * Unit handling and calendar arithmetic behind dateAdd/dateDiff (UTC, pure,
 * deterministic, like everything in the shared expression language).
 */

export const UNIT_MS = { second: 1000, minute: 60000, hour: 3600000, day: 86400000, week: 604800000 };

/**
 * The unit of dateAdd/dateDiff: singular or plural ("hour", "hours"), any case.
 * Returns the singular key, or null for anything unknown. An unknown unit used
 * to count as days, so a typo or a plural silently gave a wrong number.
 */
export function normalizeDateUnit(unit) {
    if (typeof unit !== 'string') return null;
    const u = unit.trim().toLowerCase().replace(/s$/, '');
    return (Object.hasOwn(UNIT_MS, u) || u === 'month' || u === 'year') ? u : null;
}

export const DATE_UNITS_HELP = 'second, minute, hour, day, week, month or year (singular or plural)';

export function requireDateUnit(fnName, unit) {
    const u = normalizeDateUnit(unit);
    if (u == null) throw new Error(`${fnName}(): unknown unit ${JSON.stringify(unit)}; use ${DATE_UNITS_HELP}`);
    return u;
}

/** Calendar month arithmetic in UTC; the day clamps to the end of the target month (Jan 31 + 1 month = Feb 28/29). */
function addCalendarMonths(epoch, months) {
    const d = new Date(epoch);
    const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + months;
    const y = Math.floor(total / 12);
    const m = total - y * 12;
    const day = Math.min(d.getUTCDate(), new Date(Date.UTC(y, m + 1, 0)).getUTCDate());
    const t = new Date(epoch);
    t.setUTCFullYear(y, m, day);
    return t.getTime();
}

/** Whole calendar months from b to a, truncated toward zero. */
function wholeMonthsBetween(a, b) {
    const da = new Date(a); const db = new Date(b);
    let m = (da.getUTCFullYear() - db.getUTCFullYear()) * 12 + da.getUTCMonth() - db.getUTCMonth();
    const anchor = addCalendarMonths(b, m);
    if (m > 0 && anchor > a) m -= 1;
    else if (m < 0 && anchor < a) m += 1;
    return m;
}


/**
 * Parse-time check of a literal unit argument of dateAdd/dateDiff. Returns the
 * args untouched, or throws the caller's error type (the parser's ExprError).
 * @template T
 * @param {{ v: string, i: number }} tk the function-name token
 * @param {T} args
 * @param {new (message: string, index: number) => Error} ErrorType
 * @returns {T}
 */
export function checkDateUnit(tk, args, ErrorType) {
    if (tk.v !== 'dateAdd' && tk.v !== 'dateDiff') return args;
    const unit = /** @type {any} */ (args)[2];
    if (!unit || unit.kind !== 'str' || normalizeDateUnit(unit.v) != null) return args;
    throw new ErrorType(`${tk.v}(): unknown unit "${unit.v}"; use ${DATE_UNITS_HELP}`, tk.i);
}

const MAX_EPOCH = 8.64e15;

/** ISO string of `epoch + n units`; a fractional month/year amount is truncated toward zero (1.9 months adds 1), other units take fractions. Null when the result is outside what a Date holds. */
export function addToEpoch(epoch, n, unit) {
    const out = (unit === 'month' || unit === 'year')
        ? addCalendarMonths(epoch, Math.trunc(n) * (unit === 'year' ? 12 : 1))
        : epoch + n * UNIT_MS[unit];
    return Number.isFinite(out) && Math.abs(out) <= MAX_EPOCH ? new Date(out).toISOString() : null;
}

/** Whole `unit`s from b to a, truncated toward zero (never -0). */
export function epochDiff(a, b, unit) {
    if (unit === 'month') return wholeMonthsBetween(a, b) || 0;
    if (unit === 'year') return Math.trunc(wholeMonthsBetween(a, b) / 12) || 0;
    return Math.trunc((a - b) / UNIT_MS[unit]) || 0;
}
