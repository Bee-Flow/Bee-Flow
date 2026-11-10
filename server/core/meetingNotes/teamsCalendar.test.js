/**
 * teamsCalendar tests: which Graph user the calendar listing reads. A
 * delegated session reads `/me/calendarView`; a session that names a Graph
 * user path (the option B app-token seam) reads `/users/<object id>/calendarView`;
 * any other path is refused before Graph is called.
 *
 * Graph is injected through init() as a `graphFetch` stub.
 *
 * Run: cd server && node --test core/meetingNotes/teamsCalendar.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const calendar = require('./teamsCalendar');

const calls = [];
calendar.init({
    graphFetch: async (p, _session, options) => {
        calls.push({ path: p, options });
        return { value: [{ id: 'ev1', onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/x' }, start: {}, end: {} }] };
    },
});

test.beforeEach(() => { calls.length = 0; });

const OID = '0f0e0d0c-0b0a-4908-8706-050403020100';

test('a delegated session lists /me/calendarView, as before', async () => {
    await calendar.listUpcomingTeamsMeetings({ session: { accessToken: 'fixture-access-token' } });
    assert.equal(calls.length, 1);
    assert.match(calls[0].path, /^\/me\/calendarView\?startDateTime=/);
    assert.equal(calls[0].options.headers.Prefer, 'outlook.timezone="UTC"');
});

test('a session with a /users/<guid> path lists that user\'s calendar, upcoming and recently ended', async () => {
    const session = { accessToken: 'fixture-access-token', graphUserPath: `/users/${OID}`, appOnly: true };
    const upcoming = await calendar.listUpcomingTeamsMeetings({ session });
    assert.deepEqual(upcoming.map((m) => m.eventId), ['ev1']);
    await calendar.listRecentlyEndedTeamsMeetings({ session, lookbackHours: 168, graceMinutes: 0 });
    assert.equal(calls.length, 2);
    for (const call of calls) assert.ok(call.path.startsWith(`/users/${OID}/calendarView?startDateTime=`), call.path);
    assert.match(decodeURIComponent(calls[1].path), /\$orderby=start\/dateTime desc/);
});

test('any other Graph user path is refused before Graph is called', async () => {
    for (const bad of ['/users/member@fixture.test', `/users/${OID}/calendar`, '/me/../users', '']) {
        await assert.rejects(
            calendar.listUpcomingTeamsMeetings({ session: { accessToken: 'fixture-access-token', graphUserPath: bad } }),
            (err) => err.code === 'failed',
            bad,
        );
    }
    assert.equal(calls.length, 0);
});
