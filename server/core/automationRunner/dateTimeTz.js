// @typecheck strict
/**
 * Strict date reading and timezone-aware fields for the datetime step.
 *
 * Why not `new Date(string)`: it rolls an impossible calendar date over
 * ("2026-02-30" becomes 2026-03-02) and reads a zone-less string in the SERVER's
 * timezone, which is invisible on a UTC container and wrong anywhere else. ISO
 * shaped strings are therefore read here, field by field, and a date that does
 * not exist is refused. Any other string still goes to `new Date` as before.
 */

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/;

/** Values of the step's `epochUnit`. */
const EPOCH_UNITS = new Set(['auto', 'seconds', 'ms']);

/**
 * Epoch values below this are seconds (1e11 s is year 5138; 1e11 ms is 1973).
 * Consequence: a NEGATIVE millisecond epoch between 1966 and 1970 also reads as
 * seconds under `epochUnit: auto`; set `epochUnit: ms` for such dates.
 */
const EPOCH_SECONDS_BELOW = 1e11;

const formatters = new Map();

/** @param {unknown} tz @returns {string} the IANA name to use ('UTC' when none is set) */
function resolveTimezone(tz) {
    if (tz == null || (typeof tz === 'string' && !tz.trim())) return 'UTC';
    if (typeof tz !== 'string') throw timezoneError(tz);
    const name = tz.trim();
    if (name.toUpperCase() === 'UTC') return 'UTC';
    try {
        formatterFor(name);
    } catch {
        throw timezoneError(name);
    }
    return name;
}

/** @param {unknown} tz */
function timezoneError(tz) {
    const err = new Error(`datetime: unknown timezone "${String(tz)}"; use an IANA name such as Europe/Amsterdam or UTC`);
    /** @type {any} */ (err).errorClass = 'datetime_timezone_invalid';
    return err;
}

/** @param {string} tz */
function formatterFor(tz) {
    let f = formatters.get(tz);
    if (!f) {
        f = new Intl.DateTimeFormat('en-US', {
            timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
            hour: 'numeric', minute: 'numeric', second: 'numeric',
        });
        formatters.set(tz, f);
    }
    return f;
}

/**
 * Calendar fields of an instant on the wall clock of `tz`.
 * @param {Date} date @param {string} tz
 */
function partsInZone(date, tz) {
    /** @type {number} */
    let y; let /** @type {number} */ mo; let /** @type {number} */ d; let /** @type {number} */ h; let /** @type {number} */ mi; let /** @type {number} */ s;
    if (tz === 'UTC') {
        y = date.getUTCFullYear(); mo = date.getUTCMonth() + 1; d = date.getUTCDate();
        h = date.getUTCHours(); mi = date.getUTCMinutes(); s = date.getUTCSeconds();
    } else {
        /** @type {Record<string, number>} */
        const p = {};
        for (const part of formatterFor(tz).formatToParts(date)) {
            if (part.type !== 'literal') p[part.type] = Number(part.value);
        }
        ({ year: y, month: mo, day: d, hour: h, minute: mi, second: s } = p);
    }
    return { year: y, month: mo, day: d, hour: h, minute: mi, second: s, dayOfWeek: new Date(Date.UTC(y, mo - 1, d)).getUTCDay() };
}

/**
 * Offset of `tz` from UTC at an instant, in ms (whole seconds).
 * @param {number} ms
 * @param {string} tz
 */
function offsetAt(ms, tz) {
    const p = partsInZone(new Date(ms), tz);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant at which the wall clock of `tz` reads the given fields. In the
 * hour that does not exist (spring forward) this lands one hour later, in the
 * hour that happens twice (fall back) on the first occurrence.
 * @param {number} wallMs the fields as if they were UTC
 * @param {string} tz
 */
function wallToInstant(wallMs, tz) {
    if (tz === 'UTC') return wallMs;
    // The offsets in force a day before and after; a candidate instant counts
    // when the zone really has that offset there. Two valid ones means the hour
    // happens twice: take the first. None means the hour was skipped: use the
    // offset from before the change, which lands one hour later.
    const before = offsetAt(wallMs - 86_400_000, tz);
    const after = offsetAt(wallMs + 86_400_000, tz);
    const valid = [before, after].map((o) => wallMs - o).filter((t) => offsetAt(t, tz) === wallMs - t);
    return valid.length ? Math.min(...valid) : wallMs - before;
}

/** @param {number} y @param {number} m 1-12 */
function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

/**
 * Read an ISO-shaped string. Returns a Date, null for an impossible date, and
 * undefined when the string is not ISO shaped (the caller falls back).
 * @param {string} s @param {string} tz
 * @returns {Date | null | undefined}
 */
function parseIsoStrict(s, tz) {
    const m = ISO_RE.exec(s);
    if (!m) return undefined;
    const y = +m[1]; const mo = +m[2]; const d = +m[3];
    const h = m[4] ? +m[4] : 0; const mi = m[5] ? +m[5] : 0; const sec = m[6] ? +m[6] : 0;
    if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
    if (h > 23 || mi > 59 || sec > 59) return null;
    const msPart = m[7] ? Math.floor(Number(`0.${m[7]}`) * 1000) : 0;
    const wall = Date.UTC(y, mo - 1, d, h, mi, sec, msPart);
    const zone = m[8];
    /** @type {number} */
    let epoch;
    if (!zone) epoch = wallToInstant(wall, tz);
    else if (zone === 'Z') epoch = wall;
    else {
        const digits = zone.slice(1).replace(':', '');
        const offMin = (+digits.slice(0, 2)) * 60 + (digits.length > 2 ? +digits.slice(2, 4) : 0);
        epoch = wall - (zone[0] === '-' ? -1 : 1) * offMin * 60000;
    }
    const out = new Date(epoch);
    return Number.isNaN(out.getTime()) ? null : out;
}

/**
 * Any datetime input to a Date, or null when it cannot be read.
 * @param {unknown} v
 * @param {{ tz: string, epochUnit?: string }} opts epochUnit: 'auto' (default), 'seconds' or 'ms'
 */
function toDateStrict(v, { tz, epochUnit }) {
    if (v == null) return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
    if (typeof v === 'number') {
        if (!Number.isFinite(v)) return null;
        const seconds = epochUnit === 'seconds' || ((epochUnit == null || epochUnit === 'auto') && Math.abs(v) < EPOCH_SECONDS_BELOW);
        const d = new Date(seconds ? v * 1000 : v);
        return Number.isNaN(d.getTime()) ? null : d;
    }
    if (typeof v === 'string') {
        const s = v.trim();
        const iso = parseIsoStrict(s, tz);
        if (iso !== undefined) return iso;
        const d = new Date(s);
        return Number.isNaN(d.getTime()) ? null : d;
    }
    return null;
}

/**
 * Add whole days keeping the wall-clock time in `tz` (a day across a DST change
 * is 23 or 25 hours long).
 * @param {Date} date @param {number} days @param {string} tz
 */
function addWallDays(date, days, tz) {
    const p = partsInZone(date, tz);
    const wall = Date.UTC(p.year, p.month - 1, p.day + Math.trunc(days), p.hour, p.minute, p.second, date.getUTCMilliseconds());
    const whole = wallToInstant(wall, tz);
    // Fractional days: the remainder is plain elapsed time.
    return new Date(whole + (days - Math.trunc(days)) * 86_400_000);
}

module.exports = { resolveTimezone, partsInZone, toDateStrict, addWallDays, EPOCH_UNITS, EPOCH_SECONDS_BELOW };
