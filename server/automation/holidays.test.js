'use strict';

/**
 * Dutch public holidays and the schedule "skip holidays" rule.
 *
 * Run: node --test automation/holidays.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const h = require('./holidays');

const dates = (year, opts) => Object.fromEntries(h.dutchHolidays(year, opts).map(x => [x.key, x.date]));

test('Easter Sunday matches the published dates across the cycle', () => {
    const known = {
        2008: '2008-03-23', 2011: '2011-04-24', 2019: '2019-04-21', 2024: '2024-03-31',
        2025: '2025-04-20', 2026: '2026-04-05', 2027: '2027-03-28', 2028: '2028-04-16',
        2038: '2038-04-25', 2285: '2285-03-22',
    };
    for (const [year, date] of Object.entries(known)) {
        assert.equal(h.easterSunday(Number(year)), date, `Easter ${year}`);
    }
});

test('2026: every holiday on its date, moveable feasts from Easter', () => {
    assert.deepEqual(dates(2026), {
        new_years_day: '2026-01-01',
        easter_sunday: '2026-04-05',
        easter_monday: '2026-04-06',
        kings_day: '2026-04-27',
        liberation_day: '2026-05-05',
        ascension_day: '2026-05-14',
        whit_sunday: '2026-05-24',
        whit_monday: '2026-05-25',
        christmas_day: '2026-12-25',
        boxing_day: '2026-12-26',
    });
});

test('2024 and 2025: Easter in March and late April', () => {
    const y24 = dates(2024);
    assert.equal(y24.easter_monday, '2024-04-01');
    assert.equal(y24.ascension_day, '2024-05-09');
    assert.equal(y24.whit_monday, '2024-05-20');
    const y25 = dates(2025);
    assert.equal(y25.easter_monday, '2025-04-21');
    assert.equal(y25.ascension_day, '2025-05-29');
    assert.equal(y25.whit_sunday, '2025-06-08');
    assert.equal(y25.whit_monday, '2025-06-09');
});

test('Koningsdag moves to 26 April when the 27th is a Sunday', () => {
    for (const year of [2025, 2026, 2030, 2031, 2036]) {
        const sunday = new Date(Date.UTC(year, 3, 27)).getUTCDay() === 0;
        assert.equal(dates(year).kings_day, sunday ? `${year}-04-26` : `${year}-04-27`, `Koningsdag ${year}`);
    }
    assert.equal(dates(2025).kings_day, '2025-04-26');
    assert.equal(dates(2031).kings_day, '2031-04-26');
});

test('Bevrijdingsdag is every year, not only lustrum years', () => {
    for (const year of [2024, 2025, 2026, 2027]) assert.equal(dates(year).liberation_day, `${year}-05-05`);
});

test('Goede Vrijdag is off by default and available on request', () => {
    assert.equal(dates(2026).good_friday, undefined);
    assert.equal(dates(2026, { includeGoodFriday: true }).good_friday, '2026-04-03');
    assert.equal(h.holidayOn('2026-04-03'), null);
});

test('holidayOn / isDutchHoliday / names', () => {
    assert.deepEqual(h.holidayOn('2026-12-26'), { date: '2026-12-26', key: 'boxing_day', name: 'Second Day of Christmas' });
    assert.equal(h.isDutchHoliday(2026, 5, 14), true);
    assert.equal(h.isDutchHoliday(2026, 5, 15), false);
    assert.equal(h.holidayOn('not a date'), null);
    assert.deepEqual(h.dutchHolidays(1200), []);
    // A caller mutating the result does not poison the cache.
    h.dutchHolidays(2026)[0].date = 'x';
    assert.equal(dates(2026).new_years_day, '2026-01-01');
});

test('the holiday is judged by the date in the schedule time zone', () => {
    // 00:30 on 25 December in Amsterdam is still 24 December in UTC.
    const ts = Date.parse('2026-12-24T23:30:00Z');
    assert.equal(h.holidayAt(ts, 'Europe/Amsterdam')?.key, 'christmas_day');
    assert.equal(h.holidayAt(ts, 'UTC'), null);
});

test('nextScheduledRunAt skips Koningsdag for a weekday schedule', () => {
    const from = Date.parse('2026-04-24T12:00:00Z'); // Friday
    const plain = h.nextScheduledRunAt('0 7 * * 1-5', 'Europe/Amsterdam', from);
    assert.equal(plain, '2026-04-27T05:00:00.000Z');
    const skipped = h.nextScheduledRunAt('0 7 * * 1-5', 'Europe/Amsterdam', from, { skipHolidays: true });
    assert.equal(skipped, '2026-04-28T05:00:00.000Z');
});

test('nextScheduledRunAt skips both Easter days for a daily schedule', () => {
    const from = Date.parse('2026-04-04T12:00:00Z');
    assert.equal(h.nextScheduledRunAt('0 9 * * *', 'Europe/Amsterdam', from), '2026-04-05T07:00:00.000Z');
    assert.equal(h.nextScheduledRunAt('0 9 * * *', 'Europe/Amsterdam', from, { skipHolidays: true }), '2026-04-07T07:00:00.000Z');
});

test('an every-minute schedule leaves the whole holiday out, in the local calendar', () => {
    // 22:59Z on 24 December is 23:59 in Amsterdam; the next minute is local
    // midnight, i.e. Christmas Day, and the whole of 25 and 26 December is out.
    const from = Date.parse('2026-12-24T22:58:30Z');
    assert.equal(h.nextScheduledRunAt('* * * * *', 'Europe/Amsterdam', from, { skipHolidays: true }), '2026-12-24T22:59:00.000Z');
    const next = h.nextScheduledRunAt('* * * * *', 'Europe/Amsterdam', Date.parse('2026-12-24T22:59:00Z'), { skipHolidays: true });
    assert.equal(next, '2026-12-26T23:00:00.000Z'); // 00:00 on 27 December, Amsterdam
});

test('a schedule that only ever fires on a holiday never fires when skipping', () => {
    assert.equal(h.nextScheduledRunAt('0 9 25 12 *', 'Europe/Amsterdam', Date.parse('2026-06-01T00:00:00Z'), { skipHolidays: true }), null);
    assert.ok(h.nextScheduledRunAt('0 9 25 12 *', 'Europe/Amsterdam', Date.parse('2026-06-01T00:00:00Z')));
});

test('scheduleOf / scheduleSkipsHolidays read the primary and the extra triggers', () => {
    const def = {
        trigger: { id: 't1', kind: 'schedule', schedule: { cron: '0 7 * * 1-5', skipHolidays: true } },
        triggers: [
            { id: 't2', kind: 'schedule', schedule: { cron: '0 8 * * *' } },
            { id: 't3', kind: 'schedule', schedule: { cron: '0 9 * * *', skipHolidays: 'yes' } },
        ],
    };
    assert.equal(h.scheduleSkipsHolidays(def), true);
    assert.equal(h.scheduleSkipsHolidays(def, 't1'), true);
    assert.equal(h.scheduleSkipsHolidays(def, 't2'), false);
    assert.equal(h.scheduleSkipsHolidays(def, 't3'), false, 'only a literal true switches it on');
    assert.equal(h.scheduleSkipsHolidays(def, 'missing'), false);
    assert.equal(h.scheduleSkipsHolidays(null), false);
});

test('holidaysSkippedBetween lists each skipped holiday once, only when the cron would fire', () => {
    const from = Date.parse('2026-04-01T00:00:00Z');
    const until = Date.parse('2026-05-31T00:00:00Z');
    const weekdays = h.holidaysSkippedBetween('0 7 * * 1-5', 'Europe/Amsterdam', from, until).map(x => x.key);
    // Easter Sunday and Whit Sunday are Sundays: a weekday schedule never fires there.
    assert.deepEqual(weekdays, ['easter_monday', 'kings_day', 'liberation_day', 'ascension_day', 'whit_monday']);
    const everyMinute = h.holidaysSkippedBetween('* * * * *', 'Europe/Amsterdam', from, until).map(x => x.key);
    assert.deepEqual(everyMinute, ['easter_sunday', 'easter_monday', 'kings_day', 'liberation_day', 'ascension_day', 'whit_sunday', 'whit_monday']);
});
