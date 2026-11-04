// @typecheck
'use strict';

/**
 * nextcloud_calendar_create_event / _update_event against a scripted fetch.
 * The PUT body is the thing under test: an update must edit the stored ICS in
 * place (keeping RRULE, VALARM, ORGANIZER, ...), and times must be validated.
 *
 * Run: cd server && node --test integrations/nextcloudCalendarTools.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const ncClient = require('./nextcloudClient');
const { executeNextcloudCalendarTool } = require('./nextcloudCalendarTools');

const BASE = 'https://nc.test';

const STORED = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Other//EN',
    'BEGIN:VEVENT', 'UID:ev1@nc.test', 'DTSTAMP:20260101T000000Z',
    'DTSTART;TZID=Europe/Amsterdam:20261020T090000',
    'DTEND;TZID=Europe/Amsterdam:20261020T100000',
    'SUMMARY:Weekly sync', 'LOCATION:Room 1',
    'RRULE:FREQ=WEEKLY;COUNT=4', 'STATUS:CONFIRMED', 'CATEGORIES:WORK',
    'ORGANIZER;CN=Boss:mailto:boss@example.test',
    'ATTENDEE;CN=Pat;ROLE=CHAIR;PARTSTAT=ACCEPTED:mailto:pat@example.test',
    'X-TALK-LINK:https://nc.test/call/abc123',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'DESCRIPTION:Reminder', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n');

async function run(tool, args, { putStatus = 201, getText = STORED } = {}) {
    const puts = [];
    const orig = ncClient.resolveAuth;
    ncClient.resolveAuth = async () => ({
        baseUrl: BASE, uid: 'u1', authError: 'AUTH',
        fetch: async (url, options = {}) => {
            if (options.method === 'PUT') {
                puts.push(options.body);
                return { status: putStatus, ok: putStatus < 300, headers: { get: () => null }, text: async () => '<d:error>x</d:error>' };
            }
            return { status: 200, ok: true, headers: { get: () => '"e"' }, text: async () => getText };
        },
    });
    try {
        return { out: await executeNextcloudCalendarTool(tool, args, 'u1', {}), puts };
    } finally {
        ncClient.resolveAuth = orig;
    }
}

const unfold = (s) => s.replace(/\r\n[ \t]/g, '');

test('update keeps RRULE, VALARM, ORGANIZER, STATUS, X-props, attendee state and TZID', async () => {
    const { out, puts } = await run('nextcloud_calendar_update_event', { calendar: 'personal', uid: 'ev1@nc.test', summary: 'Renamed' });
    assert.equal(out.success, true);
    const ics = unfold(puts[0]);
    assert.match(ics, /SUMMARY:Renamed/);
    assert.match(ics, /RRULE:FREQ=WEEKLY;COUNT=4/);
    assert.match(ics, /BEGIN:VALARM/);
    assert.match(ics, /ORGANIZER;CN=Boss:mailto:boss@example.test/);
    assert.match(ics, /STATUS:CONFIRMED/);
    assert.match(ics, /X-TALK-LINK:https:\/\/nc.test\/call\/abc123/);
    assert.match(ics, /PARTSTAT=ACCEPTED/);
    assert.match(ics, /DTSTART;TZID=Europe\/Amsterdam:20261020T090000/);
});

test('update with an empty string clears the field', async () => {
    const { puts } = await run('nextcloud_calendar_update_event', { calendar: 'personal', uid: 'ev1@nc.test', location: '' });
    assert.doesNotMatch(unfold(puts[0]), /LOCATION/);
});

test('update with a new start moves the event, keeps its duration and its TZID, bumps SEQUENCE', async () => {
    const { out, puts } = await run('nextcloud_calendar_update_event', { calendar: 'personal', uid: 'ev1@nc.test', start: '2026-10-20T12:00:00Z' });
    assert.equal(out.success, true);
    const ics = unfold(puts[0]);
    // 12:00Z on 2026-10-20 is 14:00 in Amsterdam (CEST).
    assert.match(ics, /DTSTART;TZID=Europe\/Amsterdam:20261020T140000/);
    assert.match(ics, /DTEND;TZID=Europe\/Amsterdam:20261020T150000/);
    assert.match(ics, /SEQUENCE:1/);
});

test('moving a series that has exceptions is refused', async () => {
    const withExdate = STORED.replace('STATUS:CONFIRMED', 'STATUS:CONFIRMED\r\nEXDATE;TZID=Europe/Amsterdam:20261027T090000');
    const { out, puts } = await run('nextcloud_calendar_update_event', { calendar: 'personal', uid: 'ev1@nc.test', start: '2026-10-20T12:00:00Z' }, { getText: withExdate });
    assert.match(out.error, /exceptions/i);
    assert.equal(puts.length, 0);
});

test('update rejects an end before the start', async () => {
    const { out, puts } = await run('nextcloud_calendar_update_event', { calendar: 'personal', uid: 'ev1@nc.test', end: '2026-10-20T06:00:00Z' });
    assert.match(out.error, /end/i);
    assert.equal(puts.length, 0);
});

test('create rejects an end before the start and an invalid date, without throwing', async () => {
    const a = await run('nextcloud_calendar_create_event', { calendar: 'personal', summary: 's', start: '2026-10-20T10:00:00Z', end: '2026-10-20T09:00:00Z' });
    assert.match(a.out.error, /end/i);
    const b = await run('nextcloud_calendar_create_event', { calendar: 'personal', summary: 's', start: 'not a date' });
    assert.match(b.out.error, /start/i);
    assert.equal(a.puts.length + b.puts.length, 0);
});

test('all-day create ends the next day (exclusive DTEND) and keeps the local date', async () => {
    const { puts } = await run('nextcloud_calendar_create_event', { calendar: 'personal', summary: 's', start: '2026-10-27', allDay: true });
    const ics = unfold(puts[0]);
    assert.match(ics, /DTSTART;VALUE=DATE:20261027/);
    assert.match(ics, /DTEND;VALUE=DATE:20261028/);
    const { puts: p2 } = await run('nextcloud_calendar_create_event', { calendar: 'personal', summary: 's', start: '2026-10-25T00:00:00+02:00', allDay: true });
    assert.match(unfold(p2[0]), /DTSTART;VALUE=DATE:20261025/);
});

test('create attendees carry no CN equal to the address', async () => {
    const { puts } = await run('nextcloud_calendar_create_event', { calendar: 'personal', summary: 's', start: '2026-10-20T10:00:00Z', attendees: ['a@example.test'] });
    assert.doesNotMatch(unfold(puts[0]), /CN=a@example/i);
    assert.match(unfold(puts[0]), /mailto:a@example.test/);
});

test('a 403 on write becomes a readable read-only message', async () => {
    const { out } = await run('nextcloud_calendar_create_event', { calendar: 'contact_birthdays', summary: 's', start: '2026-10-20T10:00:00Z' }, { putStatus: 403 });
    assert.match(out.error, /read-only|permission/i);
    assert.doesNotMatch(out.error, /<d:error>/);
});

// ── Recurring events in a range: one entry per occurrence ────────────────────

// What SabreDAV answers to a calendar-query WITH <c:expand>: every occurrence
// in the range its own VEVENT in UTC, with a RECURRENCE-ID; a moved
// occurrence keeps its RECURRENCE-ID and carries the new start.
const EXPANDED = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Sabre//EN',
    'BEGIN:VEVENT', 'UID:weekly@nc.test', 'DTSTAMP:20260101T000000Z',
    'DTSTART:20261104T090000Z', 'DTEND:20261104T100000Z', 'RECURRENCE-ID:20261104T090000Z',
    'SUMMARY:Daily sync', 'DESCRIPTION:https://nc.test/call/abc123', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:weekly@nc.test', 'DTSTAMP:20260101T000000Z',
    'DTSTART:20261105T140000Z', 'DTEND:20261105T150000Z', 'RECURRENCE-ID:20261105T090000Z',
    'SUMMARY:Daily sync', 'DESCRIPTION:https://nc.test/call/abc123', 'END:VEVENT',
    'END:VCALENDAR', '',
].join('\r\n');

const multistatus = (ics) => `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:response><d:href>/remote.php/dav/calendars/u1/personal/weekly.ics</d:href>
    <d:propstat><d:prop><d:getetag>"e1"</d:getetag><cal:calendar-data>${ics.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</cal:calendar-data></d:prop>
    <d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;

async function report(tool, args, ics) {
    const bodies = [];
    const orig = ncClient.resolveAuth;
    ncClient.resolveAuth = async () => ({
        baseUrl: BASE, uid: 'u1', authError: 'AUTH',
        fetch: async (url, options = {}) => {
            if (options.method === 'REPORT') bodies.push(options.body);
            return { status: 207, ok: true, headers: { get: () => null }, text: async () => multistatus(ics) };
        },
    });
    try {
        return { out: await executeNextcloudCalendarTool(tool, args, 'u1', {}), bodies };
    } finally {
        ncClient.resolveAuth = orig;
    }
}

test('list_events asks the server to expand recurrences over the requested range', async () => {
    const { bodies } = await report('nextcloud_calendar_list_events',
        { calendar: 'personal', start: '2026-11-04T00:00:00Z', end: '2026-11-06T00:00:00Z' }, EXPANDED);
    assert.equal(bodies.length, 1);
    assert.match(bodies[0], /<c:calendar-data><c:expand start="20261104T000000Z" end="20261106T000000Z"\/><\/c:calendar-data>/);
    assert.match(bodies[0], /<c:time-range start="20261104T000000Z" end="20261106T000000Z"\/>/);
});

test('list_events returns each occurrence with its own start and recurrence id', async () => {
    const { out } = await report('nextcloud_calendar_list_events',
        { calendar: 'personal', start: '2026-11-04T00:00:00Z', end: '2026-11-06T00:00:00Z' }, EXPANDED);
    assert.deepEqual(out.events.map((e) => [e.uid, e.dtstart, e.recurrenceId, e.talkToken]), [
        ['weekly@nc.test', '2026-11-04T09:00:00.000Z', '2026-11-04T09:00:00.000Z', 'abc123'],
        ['weekly@nc.test', '2026-11-05T14:00:00.000Z', '2026-11-05T09:00:00.000Z', 'abc123'],
    ]);
});

test('a search without a range asks for the stored objects, unexpanded', async () => {
    const { out, bodies } = await report('nextcloud_calendar_search_events', { query: 'sync', calendar: 'personal' }, STORED);
    assert.match(bodies[0], /<c:calendar-data\/>/);
    assert.doesNotMatch(bodies[0], /expand/);
    assert.equal(out.events[0].recurrenceId, null, 'a master VEVENT has no recurrence id');
});
