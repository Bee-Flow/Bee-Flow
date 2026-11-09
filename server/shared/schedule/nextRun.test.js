// The next-run table. Every row was computed by BOTH former twins
// (server/utils/scheduleNextRun.js and agent-hub/src/utils/scheduleNextRun.js)
// before they were merged into nextRun.mjs; where they agreed, the row is
// the answer of both. The rows marked CHANGED are where the server used to
// differ from what the web UI showed as "next run", and now follows the UI.
//
// The table runs in UTC so a missing tz argument resolves the same everywhere.
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
    // Regressions: later days are calendar days in the zone, not "+24 hours".
    // Friday before the EU DST start (29 March): Monday 08:00 CEST is 06:00Z; it was 07:00Z (09:00 local).
    ['weekly across the DST start keeps HH:MM', '2026-03-27T12:00:00Z', { repeatInterval: 'weekly', daysOfWeek: ['mon'], timeOfDay: '08:00' }, 'Europe/Amsterdam', '2026-03-30T06:00:00.000Z'],
    ['weekdays across the DST end keeps HH:MM', '2026-10-23T12:00:00Z', { repeatInterval: 'weekdays', timeOfDay: '08:00' }, 'Europe/Amsterdam', '2026-10-26T07:00:00.000Z'],
    // On the 25-hour day "now + 24h" is still today: 00:15 has passed at 00:30, the answer was 00:15 TODAY (in the past).
    ['daily on the 25-hour day rolls to tomorrow', '2026-10-24T22:30:00Z', { repeatInterval: 'daily', timeOfDay: '00:15' }, 'Europe/Amsterdam', '2026-10-25T23:15:00.000Z'],
    // Hourly reads :MM on the zone's clock: 17:40 in Kolkata (+05:30), the next :00 there is 12:30Z; it was 13:00Z (18:30 local).
    ['hourly in a half-hour zone', '2026-03-27T12:10:00Z', { repeatInterval: 'hourly', timeOfDay: '09:00' }, 'Asia/Kolkata', '2026-03-27T12:30:00.000Z'],
    ['hourly with an unknown zone still answers', '2026-10-13T10:15:00Z', { repeatInterval: 'hourly', timeOfDay: '09:30' }, 'Not/AZone', '2026-10-13T10:30:00.000Z'],
    ['hourly at :15 in a half-hour zone', '2026-03-27T12:10:00Z', { repeatInterval: 'hourly', timeOfDay: '09:15' }, 'Asia/Kolkata', '2026-03-27T12:45:00.000Z'],
];

for (const [name, now, schedule, tz, expected] of CASES) {
    test(`next run: ${name}`, (t) => {
        t.after(() => mock.timers.reset());
        mock.timers.enable({ apis: ['Date'], now: new Date(now).getTime() });
        assert.equal(computeScheduleNextRun(schedule, tz), expected);
    });
}
