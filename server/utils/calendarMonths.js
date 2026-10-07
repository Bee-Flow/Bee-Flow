'use strict';

/**
 * Calendar-month arithmetic for statutory clocks ("within one month", "at
 * least six months"). A month is a calendar month, not 30 days, and when the
 * target month is too short for the start day the result is that month's last
 * day: 31 Jan + 1 month = 28 Feb (29 in a leap year). That is how Reg. (EEC,
 * Euratom) No 1182/71 Art. 3(2)(c) counts a period in months, and how the EDPB
 * applies it to GDPR Art. 12(3). A bare `setUTCMonth` overflows instead
 * (31 Jan + 1 month = 3 Mar), which runs a legal deadline past its end.
 *
 * UTC throughout, so the time of day is kept and DST never shifts a clock.
 * Negative `months` count backwards with the same clamp (31 Aug - 6 = 28 Feb),
 * which is what Postgres does for `ts - INTERVAL '6 months'`.
 *
 * @param {Date|string|number} date
 * @param {number} months whole months, may be negative
 * @returns {Date}
 */
function addCalendarMonths(date, months) {
    const d = new Date(date instanceof Date ? date.getTime() : date);
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + months);
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, lastDay));
    return d;
}

module.exports = { addCalendarMonths };
