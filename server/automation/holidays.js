/**
 * Dutch public holidays, and the "skip holidays" rule for schedules.
 *
 * A schedule trigger may carry `schedule.skipHolidays: true` (Studio →
 * Automations handoff 5, "Op feestdagen overslaan"). The scheduler then never
 * fires on a Dutch public holiday, judged by the calendar date IN THE
 * SCHEDULE'S OWN TIME ZONE: "every weekday at 07:00 Europe/Amsterdam" skips
 * Koningsdag in Amsterdam, whatever UTC says.
 *
 * The list is the set of days Dutch employers commonly give off:
 *
 *   Nieuwjaarsdag      1 January
 *   Eerste Paasdag     Easter Sunday
 *   Tweede Paasdag     Easter Monday
 *   Koningsdag         27 April, or 26 April when the 27th is a Sunday
 *   Bevrijdingsdag     5 May, every year (not only the lustrum years)
 *   Hemelvaartsdag     Easter + 39 days
 *   Eerste Pinksterdag Easter + 49 days
 *   Tweede Pinksterdag Easter + 50 days
 *   Eerste Kerstdag    25 December
 *   Tweede Kerstdag    26 December
 *
 * Goede Vrijdag (Good Friday) is NOT a day off for most employers, so it is
 * off by default; `includeGoodFriday` adds it for a caller that wants it. The
 * schedule flag does not expose it (owner decision, handoff 5).
 *
 * Koningsdag follows the rule in force since 2014. Earlier years had
 * Koninginnedag on 30 April; nothing here needs the past, so it is not modelled.
 *
 * Holiday names are returned as a stable `key` plus an English `name`; the UI
 * translates the key (`routines.holidays.<key>`).
 *
 * Pure apart from a per-year and per-time-zone cache.
 */

'use strict';

const cron = require('./cron');

const DAY_MS = 86_400_000;

const NAMES = Object.freeze({
    new_years_day: "New Year's Day",
    good_friday: 'Good Friday',
    easter_sunday: 'Easter Sunday',
    easter_monday: 'Easter Monday',
    kings_day: "King's Day",
    liberation_day: 'Liberation Day',
    ascension_day: 'Ascension Day',
    whit_sunday: 'Whit Sunday',
    whit_monday: 'Whit Monday',
    christmas_day: 'Christmas Day',
    boxing_day: 'Second Day of Christmas',
});

const pad = (n) => String(n).padStart(2, '0');
const ymdOf = (ts) => {
    const d = new Date(ts);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

/**
 * Easter Sunday of a Gregorian year (the anonymous Gregorian algorithm,
 * Meeus/Jones/Butcher). Returns epoch ms of UTC midnight on that date.
 */
function easterSunday(year) {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return Date.UTC(year, month - 1, day);
}

const _yearCache = new Map();

/**
 * The Dutch public holidays of one year, in date order.
 *
 * @param {number} year
 * @param {{ includeGoodFriday?: boolean }} [opts]
 * @returns {Array<{ date: string, key: string, name: string }>}  date is YYYY-MM-DD
 */
function dutchHolidays(year, { includeGoodFriday = false } = {}) {
    if (!Number.isInteger(year) || year < 1583 || year > 9999) return [];
    const cacheKey = `${year}:${includeGoodFriday ? 1 : 0}`;
    const hit = _yearCache.get(cacheKey);
    if (hit) return hit.map(h => ({ ...h }));

    const easter = easterSunday(year);
    const kings = Date.UTC(year, 3, 27);
    const days = [
        ['new_years_day', Date.UTC(year, 0, 1)],
        ...(includeGoodFriday ? [['good_friday', easter - 2 * DAY_MS]] : []),
        ['easter_sunday', easter],
        ['easter_monday', easter + DAY_MS],
        // A Sunday 27 April moves to Saturday the 26th.
        ['kings_day', new Date(kings).getUTCDay() === 0 ? kings - DAY_MS : kings],
        ['liberation_day', Date.UTC(year, 4, 5)],
        ['ascension_day', easter + 39 * DAY_MS],
        ['whit_sunday', easter + 49 * DAY_MS],
        ['whit_monday', easter + 50 * DAY_MS],
        ['christmas_day', Date.UTC(year, 11, 25)],
        ['boxing_day', Date.UTC(year, 11, 26)],
    ];
    const list = days
        .map(([key, ts]) => ({ date: ymdOf(ts), key, name: NAMES[key] }))
        .sort((x, y) => x.date.localeCompare(y.date));
    _yearCache.set(cacheKey, list);
    return list.map(h => ({ ...h }));
}

/**
 * The holiday on a calendar date, or null.
 *
 * @param {string} ymd  'YYYY-MM-DD'
 */
function holidayOn(ymd, opts = {}) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    if (!m) return null;
    return dutchHolidays(Number(m[1]), opts).find(h => h.date === ymd) || null;
}

/** True when year/month/day (month 1-12) is a Dutch public holiday. */
function isDutchHoliday(year, month, day, opts = {}) {
    return !!holidayOn(`${year}-${pad(month)}-${pad(day)}`, opts);
}

/**
 * The calendar date of an instant in a time zone, as 'YYYY-MM-DD'. Throws a
 * RangeError for an unknown zone, exactly like the scheduler would.
 */
function localDate(ts, tz = 'Europe/Amsterdam') {
    const p = cron.partsInTz(typeof ts === 'number' ? ts : new Date(ts).getTime(), tz);
    return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** The holiday an instant falls on in `tz`, or null. */
function holidayAt(ts, tz = 'Europe/Amsterdam', opts = {}) {
    return holidayOn(localDate(ts, tz), opts);
}

/**
 * cron.nextRunAt with the holiday rule applied: with `skipHolidays` the answer
 * is the first match on a day that is not a Dutch public holiday in `tz`.
 * Without it, exactly cron.nextRunAt. Same null / throw contract.
 */
function nextScheduledRunAt(expr, tz = 'Europe/Amsterdam', fromTs = Date.now(), { skipHolidays = false } = {}) {
    if (!skipHolidays) return cron.nextRunAt(expr, tz, fromTs);
    return cron.nextRunAt(expr, tz, fromTs, { skipDate: (y, m, d) => isDutchHoliday(y, m, d) });
}

/**
 * The schedule config of one trigger of a definition: the primary trigger when
 * `triggerStepId` is empty or names it, else the matching `triggers[]` entry.
 */
function scheduleOf(definition, triggerStepId = null) {
    const primary = definition?.trigger || null;
    let trig = primary;
    if (triggerStepId && primary?.id !== triggerStepId) {
        trig = (Array.isArray(definition?.triggers) ? definition.triggers : [])
            .find(t => t && t.id === triggerStepId) || null;
    }
    return trig && trig.schedule && typeof trig.schedule === 'object' ? trig.schedule : null;
}

/** Does this trigger's schedule skip public holidays? Only a literal `true` does. */
function scheduleSkipsHolidays(definition, triggerStepId = null) {
    return scheduleOf(definition, triggerStepId)?.skipHolidays === true;
}

/**
 * The holidays a schedule would have fired on between `fromTs` and `untilTs`
 * (inclusive, local dates in `tz`): what "skip holidays" actually leaves out
 * in that window. Each date appears once, however often the cron fires on it.
 *
 * @returns {Array<{ date: string, key: string, name: string }>}
 */
function holidaysSkippedBetween(expr, tz, fromTs, untilTs) {
    const fromDate = localDate(fromTs, tz);
    const untilDate = localDate(untilTs, tz);
    const out = [];
    const firstYear = Number(fromDate.slice(0, 4));
    const lastYear = Number(untilDate.slice(0, 4));
    for (let y = firstYear; y <= lastYear; y++) {
        for (const h of dutchHolidays(y)) {
            if (h.date < fromDate || h.date > untilDate) continue;
            // Only this one day may match: the first run the cron has on it.
            const hit = cron.nextRunAt(expr, tz, fromTs, {
                skipDate: (yy, mm, dd) => `${yy}-${pad(mm)}-${pad(dd)}` !== h.date,
            });
            if (hit && localDate(hit, tz) === h.date) out.push(h);
        }
    }
    return out;
}

module.exports = {
    dutchHolidays,
    easterSunday: (year) => ymdOf(easterSunday(year)),
    holidayOn,
    holidayAt,
    isDutchHoliday,
    localDate,
    nextScheduledRunAt,
    scheduleOf,
    scheduleSkipsHolidays,
    holidaysSkippedBetween,
    HOLIDAY_NAMES: NAMES,
};
