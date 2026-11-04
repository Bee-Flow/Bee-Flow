'use strict';

/**
 * core/meetingNotes/talkCalendar.js: the Upcoming list of Talk meetings. The
 * CalDAV query expands a recurring series, and every occurrence shares its uid
 * and room, so the dedupe key has to tell the occurrences apart (or a weekly
 * meeting showed once), while the same event in two calendars stays one row.
 * The calendar client goes in through the integration-client registry, the
 * scope guard through a swap on its module object: no module-system mocks.
 *
 * Run: cd server && node --test core/meetingNotes/talkCalendar.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { makeSwaps } = require('../../testUtils/swaps');
const { registerIntegrationClients } = require('../integrations/integrationClients');
const ncScopeGuard = require('../integrations/ncScopeGuard');

const fx = { calendars: [], events: {} };
const { swap, restore } = makeSwaps();
test.before(() => {
    swap(ncScopeGuard, 'guardedNcCall', async (_name, _args, _ctx, fn) => fn());
    registerIntegrationClients({
        nextcloudCalendar: () => ({
            executeNextcloudCalendarTool: async (name, args) => (name === 'nextcloud_calendar_list'
                ? { calendars: fx.calendars }
                : { events: fx.events[args.calendar] || [] }),
        }),
    });
});
test.after(restore);

const { listUpcomingTalkMeetings } = require('./talkCalendar');

test('every occurrence of a recurring Talk meeting is listed; one event in two calendars once', async () => {
    const weekly = (start) => ({ uid: 'series-1', summary: 'Weekly', dtstart: start, recurrenceId: start, talkToken: 'room1' });
    fx.calendars = [{ slug: 'personal' }, { slug: 'shared' }];
    fx.events = {
        personal: [weekly('2026-11-05T09:00:00Z'), weekly('2026-11-12T09:00:00Z')],
        shared: [weekly('2026-11-05T09:00:00Z')],
    };
    const rows = await listUpcomingTalkMeetings({ session: {}, userId: 'u1', windowHours: 24 * 14 });
    assert.deepStrictEqual(rows.map((r) => [r.uid, r.recurrenceId, r.start]), [
        ['series-1', '2026-11-05T09:00:00Z', '2026-11-05T09:00:00Z'],
        ['series-1', '2026-11-12T09:00:00Z', '2026-11-12T09:00:00Z'],
    ]);
});

test('a single event carries recurrenceId null', async () => {
    fx.calendars = [{ slug: 'personal' }];
    fx.events = { personal: [{ uid: 'one', summary: 'Once', dtstart: '2026-11-05T09:00:00Z', talkToken: 'room2' }] };
    const [row] = await listUpcomingTalkMeetings({ session: {}, userId: 'u1' });
    assert.strictEqual(row.recurrenceId, null);
    assert.strictEqual(row.talkToken, 'room2');
});
