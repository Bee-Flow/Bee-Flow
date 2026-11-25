// @typecheck strict
/**
 * Working days in the shared expression language: Monday to Friday, in UTC like every other date helper here.
 *
 *   workdaysBetween(a, b)  the working days after a's day, up to and including b's day: a mail of Friday answered on
 *                          Monday took 1, answered the same day 0. Negative when b is before a. The time of day does
 *                          not count, only the calendar day.
 *   addWorkdays(date, n)   the date n working days later (n < 0: earlier), the time of day kept. From a Saturday, one
 *                          working day later is Monday; zero leaves the date as it is.
 *
 * Public holidays are working days here: which days are holidays depends on the country and the region, and a pure,
 * deterministic function has no calendar to ask. A goal that should skip them says so in its own steps.
 *
 * Pure, null-safe, deterministic: text that is not a date gives null, never an error.
 */

import { toEpoch } from './dates.mjs';

const DAY_MS = 86_400_000;
/** More working days than this in one step is no calendar question (about 400 years). */
const MAX_WORKDAYS = 100_000;

/** 0 = Sunday … 6 = Saturday, for a day number counted from 1970-01-01 (a Thursday). */
const weekdayOf = (/** @type {number} */ day) => (((day + 4) % 7) + 7) % 7;
const isWorkday = (/** @type {number} */ day) => { const w = weekdayOf(day); return w !== 0 && w !== 6; };

/** Working days among the day numbers from + 1 … to (from <= to). */
function countAfter(/** @type {number} */ from, /** @type {number} */ to) {
    const span = to - from;
    let count = Math.floor(span / 7) * 5;
    for (let day = from + 1 + Math.floor(span / 7) * 7; day <= to; day++) if (isWorkday(day)) count += 1;
    return count;
}

/**
 * The working days from a's day to b's day.
 * @param {unknown} a @param {unknown} b
 * @returns {number | null}
 */
export function workdaysBetween(a, b) {
    const ea = toEpoch(a);
    const eb = toEpoch(b);
    if (ea == null || eb == null) return null;
    const da = Math.floor(ea / DAY_MS);
    const db = Math.floor(eb / DAY_MS);
    return db >= da ? countAfter(da, db) : -countAfter(db, da);
}

/**
 * `date` moved by n working days, as an ISO string.
 * @param {unknown} date @param {unknown} n
 * @returns {string | null}
 */
export function addWorkdays(date, n) {
    const epoch = toEpoch(date);
    const steps = typeof n === 'number' ? n : n == null || n === '' ? NaN : Number(n);
    if (epoch == null || !Number.isFinite(steps) || Math.abs(steps) > MAX_WORKDAYS) return null;
    let left = Math.trunc(steps);
    if (left === 0) return new Date(epoch).toISOString();
    const dir = left > 0 ? 1 : -1;
    let day = Math.floor(epoch / DAY_MS);
    const timeOfDay = epoch - day * DAY_MS;
    // Whole weeks at once, then day by day: five working days are always seven calendar days.
    const weeks = Math.floor((Math.abs(left) - 1) / 5);
    day += dir * weeks * 7;
    left -= dir * weeks * 5;
    while (left !== 0) {
        day += dir;
        if (isWorkday(day)) left -= dir;
    }
    const out = day * DAY_MS + timeOfDay;
    return toEpoch(out) == null ? null : new Date(out).toISOString();
}

export const WORKDAY_FUNCTIONS = {
    workdaysBetween: (/** @type {unknown} */ a, /** @type {unknown} */ b) => workdaysBetween(a, b),
    addWorkdays: (/** @type {unknown} */ date, /** @type {unknown} */ n) => addWorkdays(date, n),
};

/** Their doc entries. `since: 3`: vocabulary the app definition's schema version 3 brings (collections.mjs says why). */
export const WORKDAY_FUNCTION_DOCS = [
    { name: 'workdaysBetween', signature: 'workdaysBetween(a, b)', description: 'Working days (Monday to Friday, UTC) after the day of a up to the day of b: Friday to Monday is 1, the same day 0. Public holidays count as working days.', since: 3 },
    { name: 'addWorkdays', signature: 'addWorkdays(date, n)', description: 'The ISO date n working days (Monday to Friday) later, or earlier for a negative n; from a weekend, 1 is the next Monday. Public holidays count as working days.', since: 3 },
];
