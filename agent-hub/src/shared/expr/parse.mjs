/**
 * Reading numbers and dates the way people and other systems write them.
 *
 * Used by functions.mjs. The readers are layered so that every value the
 * engine could already read keeps exactly the result it had: Number() reads a
 * number first, so '1.234' is still 1.234; the ISO patterns read a date first,
 * so '2026-09-02' is still that UTC day. Only a value that used to give null
 * ('12,5', '€ 1.554,25', a Gmail Date header, '1756720800') is now read too.
 * The one deliberate change to a result that was not null is a NUMBER below
 * 1e11, which is a unix timestamp in seconds (see epochFromNumber).
 *
 * Same rules as the rest of shared/expr: pure, total, no Intl, no Date.parse,
 * no ambient locale or zone, so Node and the browser read every value alike.
 */

// ── Numbers ────────────────────────────────────────────────────────────────

// Whitespace a number can carry: spaces, NBSP, and the narrow NBSP that Dutch
// and French formatting put between groups or after the € sign.
const SPACE = '[\\s\\u00a0\\u202f]';
const HAS_SPACE_RE = new RegExp(SPACE);
const SPACES_RE = new RegExp(SPACE, 'g');
// Spaces inside the digits group them in threes ('1 554,25'), or they are not
// one number ('12 5').
const SPACE_GROUPED_RE = new RegExp(`^\\d{1,3}(?:${SPACE}\\d{3})+(?:[.,]\\d+)?$`);

/**
 * A number written with a decimal comma, thousands separators or a euro sign:
 * '12,5' → 12.5, '1.554,25' → 1554.25, '€ 1.554,25' → 1554.25,
 * '1.234.567' → 1234567, '-€ 12,50' → -12.5, '1,234.5' → 1234.5.
 *
 * The decimal mark is the LAST separator, when it occurs once; so a lone
 * comma is a decimal comma ('1,234' → 1.234, the Dutch reading). One
 * exception: next to a euro sign, a lone separator with exactly three digits
 * after a 1-3 digit integer part that does not start with 0 groups thousands
 * ('€ 1.554' → 1554, '€ 1,554' → 1554), because an amount carries cents, not
 * three decimals. That is the reading execDataExtraction.coerceNumber gives
 * the same invoice text. A separator
 * that occurs more than once is a thousands separator, and thousands
 * separators (a space included) must split the digits into groups of three,
 * or the text is not a number ('1.23.4', '12 5' → null). Only strings are
 * read; anything else is null.
 *
 * Callers try Number() first and use this only when that gave NaN, which is
 * what keeps '1.234' at 1.234.
 * @param {unknown} text
 * @returns {number|null}
 */
export function parseLocaleNumber(text) {
    if (typeof text !== 'string') return null;
    let s = text.trim();
    let sign = 1;
    const takeSign = () => {
        if (s[0] === '-' || s[0] === '+') { sign = s[0] === '-' ? -1 : 1; s = s.slice(1).trim(); return true; }
        return false;
    };
    // The sign may stand on either side of the euro sign: '-€12,50', '€ -12,50'.
    const signed = takeSign();
    const euro = s.startsWith('€') || s.endsWith('€');
    if (s.startsWith('€')) s = s.slice(1).trim();
    else if (s.endsWith('€')) s = s.slice(0, -1).trim();
    if (!signed) takeSign();
    if (HAS_SPACE_RE.test(s)) {
        if (!SPACE_GROUPED_RE.test(s)) return null;
        s = s.replace(SPACES_RE, '');
    }
    if (!/^\d[\d.,]*\d$|^\d$/.test(s)) return null;

    const lastSep = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
    if (lastSep < 0) return sign * Number(s);
    const last = s[lastSep];
    const other = last === ',' ? '.' : ',';
    const lastCount = s.split(last).length - 1;
    let intPart = s;
    let fracPart = '';
    let groupMark = last;
    if (lastCount === 1 && euro && !s.includes(other)
        && /^[1-9]\d{0,2}$/.test(s.slice(0, lastSep)) && /^\d{3}$/.test(s.slice(lastSep + 1))) {
        // '€ 1.554': a lone separator next to a euro sign groups thousands
        // (see the doc above); the groups check below then reads it.
    } else if (lastCount === 1) {
        intPart = s.slice(0, lastSep);
        fracPart = s.slice(lastSep + 1);
        groupMark = other;
    } else if (s.includes(other)) {
        // The last separator repeats, so it groups — and then nothing is left
        // to be the decimal mark the other one would have to be.
        return null;
    }
    const groups = intPart.split(groupMark);
    if (groups.length > 1) {
        if (groups[0].length < 1 || groups[0].length > 3) return null;
        for (let i = 1; i < groups.length; i++) if (groups[i].length !== 3) return null;
    }
    const digits = groups.join('');
    if (!/^\d+$/.test(digits) || !/^\d*$/.test(fracPart)) return null;
    const n = Number(fracPart ? `${digits}.${fracPart}` : digits);
    return Number.isFinite(n) ? sign * n : null;
}

// ── Dates ──────────────────────────────────────────────────────────────────
// ISO first. A bare 'YYYY-MM-DDTHH:MM:SS' (no zone) is read as UTC by hand,
// because `new Date(isoWithoutZone)` is LOCAL time in browsers but UTC for a
// date-only string, which would break the identity between client and server.
//
// The month/day parts accept one or two digits and `/` as well as `-`, because
// '2026-9-2' and '2026/09/02' are what spreadsheets, CSV exports and hand-typed
// values look like, and both name one unambiguous UTC day.
//
// There is deliberately NO `Date.parse` fallback. It used to be in
// functions.mjs and broke the determinism promise twice over:
// `Date.parse('2026-9-2')` is read in the LOCAL zone, so the same expression
// rendered "2 september" on a UTC server and "1 september" in a browser in
// Amsterdam; and for prose ('Sep 2, 2026') its result is engine-defined, so V8
// and JavaScriptCore need not agree. What IS read besides ISO is read by the
// fixed grammars below (RFC 2822, a unix timestamp), the same in every engine.
const DATE_ONLY = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/;
const DATE_TIME = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

// RFC 2822 (e-mail Date headers, RSS feeds): an optional weekday, the day, an
// English month name, a four-digit year, the time with optional seconds, and
// a zone. A trailing comment such as '(CEST)' is allowed and ignored.
const RFC2822 = /^(?:[A-Za-z]{3},?\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4}|[A-Za-z]{1,3})?\s*(?:\([^)]*\))?$/;
const MONTHS_EN = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// The zone names RFC 2822 defines (section 4.3), in minutes east of UTC.
const NAMED_ZONES = {
    ut: 0, utc: 0, gmt: 0, z: 0,
    edt: -240, est: -300, cdt: -300, cst: -360, mdt: -360, mst: -420, pdt: -420, pst: -480,
};

// The widest instant a JS Date can hold. Past it every getUTC* reads NaN, and
// a month or weekday table indexed on NaN throws. A nanosecond epoch
// (Prometheus, Kubernetes, many webhooks) is the everyday way to land here:
// 1.76e18 is a perfectly finite number.
const MAX_EPOCH = 8.64e15;

/**
 * Below this a NUMBER is a unix timestamp in seconds, not milliseconds:
 * 1e11 ms is 3 March 1973, 1e11 s is the year 5138. A millisecond timestamp
 * from before March 1973 is the one reading this gives up.
 */
export const EPOCH_SECONDS_BELOW = 1e11;

/** An epoch only when it is one a Date can actually represent. */
function inRange(epoch) {
    return Number.isFinite(epoch) && Math.abs(epoch) <= MAX_EPOCH ? epoch : null;
}

/** '+0200' / '+02:00' / '-0530' as minutes east of UTC. */
function offsetMinutes(zone) {
    const sign = zone[0] === '-' ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    return sign * ((+digits.slice(0, 2)) * 60 + (+digits.slice(2, 4)));
}

/** The result shape: the instant, and the zone the text wrote it in. */
function at(epoch, offset) {
    const e = inRange(epoch);
    return e == null ? null : { epoch: e, offset: offset || null };
}

function readRfc2822(s) {
    const m = RFC2822.exec(s);
    if (!m) return null;
    const [, d, monthName, y, h, mi, se, zone] = m;
    const mo = MONTHS_EN.indexOf(monthName.toLowerCase()) + 1;
    if (!mo || +d < 1 || +d > new Date(Date.UTC(+y, mo, 0)).getUTCDate()) return null;
    if (+h > 23 || +mi > 59 || (se && +se > 60)) return null;
    let offset = 0;
    if (zone) {
        if (/^[+-]\d{4}$/.test(zone)) offset = offsetMinutes(zone);
        else if (Object.prototype.hasOwnProperty.call(NAMED_ZONES, zone.toLowerCase())) offset = NAMED_ZONES[zone.toLowerCase()];
        else return null;
    }
    return at(Date.UTC(+y, mo - 1, +d, +h, +mi, se ? +se : 0) - offset * 60000, offset);
}

/**
 * A number as an epoch in milliseconds. Below EPOCH_SECONDS_BELOW it is a
 * unix timestamp in SECONDS, so 1756720800 is 1 September 2025 instead of
 * 21 January 1970.
 * @param {number} n
 */
export function epochFromNumber(n) {
    return Math.abs(n) < EPOCH_SECONDS_BELOW ? n * 1000 : n;
}

/**
 * A date as { epoch, offset }: the instant in milliseconds, and the zone the
 * value was written in, in minutes east of UTC (null for UTC or no zone).
 * Null when the value is not a date this module can read the same way in
 * every engine.
 *
 * Reads, in this order: a number (a unix timestamp; seconds below 1e11), an
 * ISO date or date-time, a ten- or thirteen-digit unix timestamp written as
 * text, and an RFC 2822 date ('Tue, 01 Sep 2026 10:00:00 +0200').
 * @param {unknown} value
 * @returns {{ epoch: number, offset: number|null } | null}
 */
export function parseDate(value) {
    if (value == null) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? at(epochFromNumber(value), null) : null;
    const s = String(value).trim();
    let m = DATE_ONLY.exec(s);
    if (m) return at(Date.UTC(+m[1], +m[2] - 1, +m[3]), null);
    m = DATE_TIME.exec(s);
    if (m) {
        const [, y, mo, d, h, mi, se, zone] = m;
        const offset = zone && zone !== 'Z' ? offsetMinutes(zone) : 0;
        return at(Date.UTC(+y, +mo - 1, +d, +h, +mi, se ? +se : 0) - offset * 60000, offset);
    }
    if (/^\d{10}$/.test(s)) return at(Number(s) * 1000, null);
    if (/^\d{13}$/.test(s)) return at(Number(s), null);
    return readRfc2822(s);
}
