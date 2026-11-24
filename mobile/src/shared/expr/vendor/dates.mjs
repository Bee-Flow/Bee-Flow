// @typecheck
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

// The widest instant a JS Date can hold. Past it every getUTC* reads NaN, and
// the month/weekday tables of functions.mjs would be indexed on NaN. A
// nanosecond epoch (Prometheus, Kubernetes, Cassandra, plenty of webhooks) is
// the everyday way to land here: 1.76e18 is a perfectly finite number.
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

// "2026-02-30" or "10:61" name no instant; Date.UTC would roll them over into
// the next month/hour, so they read as not a date instead.
export function validFields(y, mo, d, h, mi, s) {
    return mo >= 1 && mo <= 12 && d >= 1 && d <= new Date(Date.UTC(y, mo, 0)).getUTCDate() && h <= 23 && mi <= 59 && s <= 59;
}

// How a date is read: shared by functions.mjs and workdays.mjs.
// ── Deterministic ISO date helpers (UTC-only) ──────────────────────────────
// Dates are ISO strings. We parse to a UTC instant MANUALLY so a bare
// 'YYYY-MM-DDTHH:MM:SS' (no zone) means the same thing in every JS engine —
// `new Date(isoWithoutZone)` is LOCAL-time in browsers but UTC for date-only,
// which would break client/server identity. Everything below is UTC.
//
// The month/day parts accept ONE or two digits and `/` as well as `-`, because
// '2026-9-2' and '2026/09/02' are what spreadsheets, CSV exports and hand-typed
// values actually look like, and both name one unambiguous UTC day.
//
// There is deliberately NO `Date.parse` fallback for anything else. It used to
// be here, and it is the one thing in this file that broke the header's
// determinism promise twice over: `Date.parse('2026-9-2')` is read in the
// LOCAL zone, so the same expression on the same data rendered "2 september"
// on a UTC server and "1 september" in a browser in Amsterdam — a whole day of
// drift between the builder's preview and the run that follows it. And for
// non-ISO text ('Sep 2, 2026') its result is engine-defined, so V8 and
// JavaScriptCore need not even agree on whether it parses. Text we cannot read
// deterministically is not read at all: `formatDate` then returns '', exactly
// as it already did for 'not a date'.
const DATE_ONLY = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/;
const DATE_TIME = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

/** An epoch only when it is one a Date can actually represent. */
function inRange(epoch) {
    return Number.isFinite(epoch) && Math.abs(epoch) <= MAX_EPOCH ? epoch : null;
}

/** The UTC instant of an ISO date or date-time (or an epoch number), or null when it names none. */
export function toEpoch(iso) {
    if (iso == null) return null;
    if (typeof iso === 'number') return inRange(iso);
    const s = String(iso).trim();
    let m = DATE_ONLY.exec(s);
    if (m) return validFields(+m[1], +m[2], +m[3], 0, 0, 0) ? inRange(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
    m = DATE_TIME.exec(s);
    if (!m) return null;
    const [, y, mo, d, h, mi, se, zone] = m;
    if (!validFields(+y, +mo, +d, +h, +mi, se ? +se : 0)) return null;
    let epoch = Date.UTC(+y, +mo - 1, +d, +h, +mi, se ? +se : 0);
    if (zone && zone !== 'Z') {
        const sign = zone[0] === '-' ? -1 : 1;
        const zz = zone.slice(1).replace(':', '');
        epoch -= sign * ((+zz.slice(0, 2)) * 60 + (+zz.slice(2, 4))) * 60000;
    }
    return inRange(epoch);
}
