// The next-run table. Every row was computed by BOTH former twins
// (server/utils/scheduleNextRun.js and agent-hub/src/utils/scheduleNextRun.js)
// before they were merged into nextRun.mjs; where they agreed, the row is
// the answer of both. The rows marked CHANGED are where the server used to
// differ from what the web UI showed as "next run", and now follows the UI.
//
// Hourly uses the process's local clock (setMinutes), so the table runs in UTC.
process.env.TZ = 'UTC';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');

const { computeScheduleNextRun } = require('./nextRun.mjs');

const CASES = [
    // [name, now, schedule, tz, expected]
    ['hourly without time', '2026-10-13T10:15:00Z', { repeatInterval: 'hourly' }, 'UTC', '2026-10-13T11:00:00.000Z'],
    ['hourly at HH:00', '2026-10-13T10:15:00Z', { repeatInterval: 'hourly', timeOfDay: '09:00' }, 'UTC', '2026-10-13T11:00:00.000Z'],
    // CHANGED: the server ignored the minutes and fired on the next whole hour (11:00).
    ['hourly at HH:30, before :30', '2026-10-13T10:15:00Z', { repeatInterval: 'hourly', timeOfDay: '09:30' }, 'UTC', '2026-10-13T10:30:00.000Z'],
    ['hourly at HH:30, after :30', '2026-10-13T10:45:00Z', { repeatInterval: 'hourly', timeOfDay: '09:30' }, 'UTC', '2026-10-13T11:30:00.000Z'],
    ['hourly exactly on the hour', '2026-10-13T10:00:00Z', { repeatInterval: 'hourly' }, 'UTC', '2026-10-13T11:00:00.000Z'],
    ['daily, time passed -> tomorrow', '2026-10-13T10:15:00Z', { repeatInterval: 'daily', timeOfDay: '08:00' }, 'UTC', '2026-10-14T08:00:00.000Z'],
    ['daily, later today', '2026-10-13T10:15:00Z', { repeatInterval: 'daily', timeOfDay: '12:00' }, 'UTC', '2026-10-13T12:00:00.000Z'],
    ['daily, default 08:00', '2026-10-13T06:00:00Z', { repeatInterval: 'daily' }, 'UTC', '2026-10-13T08:00:00.000Z'],
    ['daily in Amsterdam', '2026-10-13T10:15:00Z', { repeatInterval: 'daily', timeOfDay: '12:00' }, 'Europe/Amsterdam', '2026-10-14T10:00:00.000Z'],
    ['daily in Amsterdam across the DST end', '2026-10-24T09:00:00Z', { repeatInterval: 'daily', timeOfDay: '09:00' }, 'Europe/Amsterdam', '2026-10-25T08:00:00.000Z'],
    ['daily in New York', '2026-10-13T23:30:00Z', { repeatInterval: 'daily', timeOfDay: '20:00' }, 'America/New_York', '2026-10-14T00:00:00.000Z'],
    ['tz from schedule.timezone', '2026-10-13T10:15:00Z', { repeatInterval: 'daily', timeOfDay: '12:00', timezone: 'Europe/Amsterdam' }, undefined, '2026-10-14T10:00:00.000Z'],
    // CHANGED: the server threw "Invalid time value" on an hour without minutes.
    ['timeOfDay "9"', '2026-10-13T10:15:00Z', { repeatInterval: 'daily', timeOfDay: '9' }, 'UTC', '2026-10-14T09:00:00.000Z'],
    ['weekdays from Friday evening', '2026-10-16T18:00:00Z', { repeatInterval: 'weekdays', timeOfDay: '08:00' }, 'UTC', '2026-10-19T08:00:00.000Z'],
    ['weekly on Saturday', '2026-10-13T10:15:00Z', { repeatInterval: 'weekly', daysOfWeek: ['sat'], timeOfDay: '07:30' }, 'UTC', '2026-10-17T07:30:00.000Z'],
    ['biweekly mon+thu', '2026-10-13T10:15:00Z', { repeatInterval: 'biweekly', daysOfWeek: ['mon', 'thu'], timeOfDay: '07:30' }, 'UTC', '2026-10-15T07:30:00.000Z'],
    ['weekly without days', '2026-10-13T10:15:00Z', { repeatInterval: 'weekly', daysOfWeek: [], timeOfDay: '07:30' }, 'UTC', '2026-10-14T07:30:00.000Z'],
    ['weekly with corrupt days', '2026-10-13T10:15:00Z', { repeatInterval: 'weekly', daysOfWeek: ['xyz'], timeOfDay: '07:30' }, 'UTC', '2026-10-21T07:30:00.000Z'],
    ['monthly day 5 -> next month', '2026-10-13T10:15:00Z', { repeatInterval: 'monthly', dayOfMonth: 5, timeOfDay: '09:00' }, 'UTC', '2026-11-05T09:00:00.000Z'],
    ['monthly day 20, this month', '2026-10-13T10:15:00Z', { repeatInterval: 'monthly', dayOfMonth: 20, timeOfDay: '09:00' }, 'UTC', '2026-10-20T09:00:00.000Z'],
    ['monthly day 28', '2026-10-13T10:15:00Z', { repeatInterval: 'monthly', dayOfMonth: 28 }, 'UTC', '2026-10-28T08:00:00.000Z'],
    ['monthly without day -> today', '2026-10-13T06:00:00Z', { repeatInterval: 'monthly', timeOfDay: '09:00' }, 'UTC', '2026-10-13T09:00:00.000Z'],
    ['monthly today, time passed', '2026-10-13T10:15:00Z', { repeatInterval: 'monthly', dayOfMonth: 13, timeOfDay: '09:00' }, 'UTC', '2026-11-13T09:00:00.000Z'],
    ['monthly in December rolls the year', '2026-12-20T10:00:00Z', { repeatInterval: 'monthly', dayOfMonth: 3, timeOfDay: '09:00' }, 'UTC', '2027-01-03T09:00:00.000Z'],
    ['monthly day 0 -> today', '2026-10-13T06:00:00Z', { repeatInterval: 'monthly', dayOfMonth: 0, timeOfDay: '09:00' }, 'UTC', '2026-10-13T09:00:00.000Z'],
    ['monthly negative day clamps to 1', '2026-10-13T10:15:00Z', { repeatInterval: 'monthly', dayOfMonth: -4, timeOfDay: '09:00' }, 'UTC', '2026-11-01T09:00:00.000Z'],
    ['monthly in Amsterdam', '2026-10-13T10:15:00Z', { repeatInterval: 'monthly', dayOfMonth: 20, timeOfDay: '09:00' }, 'Europe/Amsterdam', '2026-10-20T07:00:00.000Z'],
    // CHANGED: the server clamped the day to 28 (2026-10-28, 2026-11-28, 2027-02-28).
    ['monthly day 31 in October', '2026-10-13T10:15:00Z', { repeatInterval: 'monthly', dayOfMonth: 31, timeOfDay: '09:00' }, 'UTC', '2026-10-31T09:00:00.000Z'],
    ['monthly day 31 skips November', '2026-11-13T10:15:00Z', { repeatInterval: 'monthly', dayOfMonth: 31, timeOfDay: '09:00' }, 'UTC', '2026-12-31T09:00:00.000Z'],
    ['monthly day 30 skips February', '2027-02-10T10:15:00Z', { repeatInterval: 'monthly', dayOfMonth: 30, timeOfDay: '09:00' }, 'UTC', '2027-03-30T09:00:00.000Z'],
    // CHANGED: the server threw on "noon" and rolled "25:99" over to 02:39 the next day.
    ['timeOfDay "noon" -> 08:00', '2026-10-13T06:00:00Z', { repeatInterval: 'daily', timeOfDay: 'noon' }, 'UTC', '2026-10-13T08:00:00.000Z'],
    ['timeOfDay "25:99" -> 08:00', '2026-10-13T06:00:00Z', { repeatInterval: 'daily', timeOfDay: '25:99' }, 'UTC', '2026-10-13T08:00:00.000Z'],
    ['no schedule at all', '2026-10-13T06:00:00Z', null, 'UTC', '2026-10-13T08:00:00.000Z'],
];

for (const [name, now, schedule, tz, expected] of CASES) {
    test(`next run: ${name}`, (t) => {
        t.after(() => mock.timers.reset());
        mock.timers.enable({ apis: ['Date'], now: new Date(now).getTime() });
        assert.equal(computeScheduleNextRun(schedule, tz), expected);
    });
}
