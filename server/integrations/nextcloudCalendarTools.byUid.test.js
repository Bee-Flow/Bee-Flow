'use strict';

/**
 * get / update / delete of an event whose file is not named `<UID>.ics`.
 *
 * The tools address an event as `<calendar>/<UID>.ics`. That holds for events
 * this tool or the Nextcloud web UI created, but not in general: an invitation
 * Nextcloud delivers to an attendee is stored as `sabredav-<random>.ics` and
 * keeps the organiser's UID, and other clients pick their own file names. For
 * those, list_events showed the event and get / update / delete answered
 * "Event not found". On a 404 the event is now looked up by its UID.
 *
 * Run: cd server && node --test integrations/nextcloudCalendarTools.byUid.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
require('../testUtils/routeHarness').recordDb();
const ncClient = require('./nextcloudClient');
const { executeNextcloudCalendarTool } = require('./nextcloudCalendarTools');

const BASE = 'https://nc.test';
const UID = 'invite-42@organiser.example';
const STORED_PATH = '/remote.php/dav/calendars/u1/personal/sabredav-1b7c0e5a.ics';

const ICS = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Other//EN',
    'BEGIN:VEVENT', `UID:${UID}`, 'DTSTAMP:20260101T000000Z',
    'DTSTART:20261120T090000Z', 'DTEND:20261120T100000Z', 'SUMMARY:Kwartaaloverleg',
    'ORGANIZER;CN=Boss:mailto:boss@organiser.example',
    'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n');

const found = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:response><d:href>${STORED_PATH}</d:href>
    <d:propstat><d:prop><d:getetag>"e7"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;
const nothing = '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>';

/** A calendar where the event lives under STORED_PATH only. */
async function run(tool, args, { exists = true } = {}) {
    /** @type {{ method: string, url: string, body?: string, headers?: Record<string, string> }[]} */
    const calls = [];
    const orig = ncClient.resolveAuth;
    ncClient.resolveAuth = async () => /** @type {any} */ ({
        baseUrl: BASE, uid: 'u1', authError: 'AUTH',
        fetch: async (url, options = {}) => {
            const method = options.method || 'GET';
            calls.push({ method, url, body: options.body, headers: options.headers });
            const reply = (status, text = '', etag = null) => ({ status, ok: status >= 200 && status < 300, headers: { get: (h) => (String(h).toLowerCase() === 'etag' ? etag : null) }, text: async () => text });
            if (method === 'REPORT') return reply(207, exists ? found : nothing);
            if (new URL(url).pathname !== STORED_PATH) return reply(404);
            if (method === 'GET') return reply(200, ICS, '"e7"');
            return reply(204);
        },
    });
    try {
        return { out: await executeNextcloudCalendarTool(tool, args, 'u1', {}), calls };
    } finally {
        ncClient.resolveAuth = orig;
    }
}

test('get_event finds an invitation stored under another file name', async () => {
    const { out, calls } = await run('nextcloud_calendar_get_event', { calendar: 'personal', uid: UID });
    assert.equal(out.error, undefined);
    assert.equal(out.summary, 'Kwartaaloverleg');
    assert.equal(out.uid, UID);
    const report = calls.find((c) => c.method === 'REPORT');
    assert.equal(report.url, `${BASE}/remote.php/dav/calendars/u1/personal/`);
    assert.match(report.body, /<c:prop-filter name="UID">\s*<c:text-match collation="i;octet">invite-42@organiser\.example<\/c:text-match>/);
});

test('the UID is XML-escaped in the lookup', async () => {
    const { calls } = await run('nextcloud_calendar_get_event', { calendar: 'personal', uid: 'a<b>&"c' }, { exists: false });
    assert.match(calls.find((c) => c.method === 'REPORT').body, />a&lt;b&gt;&amp;"c<\/c:text-match>/);
});

test('update_event writes back to the file the event is really in, guarded by its etag', async () => {
    const { out, calls } = await run('nextcloud_calendar_update_event', { calendar: 'personal', uid: UID, location: 'Zaal 2' });
    assert.equal(out.success, true);
    const put = calls.find((c) => c.method === 'PUT');
    assert.equal(new URL(put.url).pathname, STORED_PATH);
    assert.equal(put.headers['If-Match'], '"e7"');
    assert.match(put.body, /LOCATION:Zaal 2/);
});

test('delete_event deletes the file the event is really in', async () => {
    const { out, calls } = await run('nextcloud_calendar_delete_event', { calendar: 'personal', uid: UID });
    assert.equal(out.success, true);
    assert.deepEqual(calls.filter((c) => c.method === 'DELETE').map((c) => new URL(c.url).pathname),
        ['/remote.php/dav/calendars/u1/personal/invite-42%40organiser.example.ics', STORED_PATH]);
});

test('an event that is in the calendar under no name is still "not found"', async () => {
    for (const tool of ['nextcloud_calendar_get_event', 'nextcloud_calendar_update_event', 'nextcloud_calendar_delete_event']) {
        const { out } = await run(tool, { calendar: 'personal', uid: 'gone@nc.test', location: 'x' }, { exists: false });
        assert.match(out.error, /Event not found: gone@nc\.test/);
    }
});

test('a lookup answer that points outside the calendar is not followed', async () => {
    const orig = ncClient.resolveAuth;
    const urls = [];
    ncClient.resolveAuth = async () => /** @type {any} */ ({
        baseUrl: BASE, uid: 'u1', authError: 'AUTH',
        fetch: async (url, options = {}) => {
            urls.push(`${options.method || 'GET'} ${url}`);
            if (options.method === 'REPORT') {
                return { status: 207, ok: true, headers: { get: () => null }, text: async () => found.replace(STORED_PATH, '/remote.php/dav/files/u1/secret.ics') };
            }
            return { status: 404, ok: false, headers: { get: () => null }, text: async () => '' };
        },
    });
    try {
        const out = await executeNextcloudCalendarTool('nextcloud_calendar_delete_event', { calendar: 'personal', uid: UID }, 'u1', {});
        assert.match(out.error, /Event not found/);
        assert.ok(!urls.some((u) => u.includes('/files/')), urls.join('\n'));
    } finally {
        ncClient.resolveAuth = orig;
    }
});
