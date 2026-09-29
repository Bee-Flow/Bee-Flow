/**
 * gmeetCalendar tests — Meet-code extraction (URLs, entry-point URIs, bare
 * codes, non-Meet links) and the upcoming/recently-ended window filtering.
 *
 * The googleapis calendar client is stubbed via the Module resolve hook.
 *
 * Run: cd server && node --test core/meetingNotes/gmeetCalendar.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── Mutable fixtures ─────────────────────────────────────────────────
const fx = {
    items: [],
    listCalls: [],
    clientOpts: null,
};

const fakeCalendar = {
    events: {
        list: async (params) => {
            fx.listCalls.push(params);
            return { data: { items: fx.items } };
        },
    },
};

const MOCKS = {
    '../../integrations/googleClient': {
        createGoogleApiClient: async (session, opts) => {
            fx.clientOpts = opts;
            if (!session?.accessToken) throw new Error(opts?.notConnectedError || 'Not connected');
            return fakeCalendar;
        },
    },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:gmeetcal:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /meetingNotes[\\/]gmeetCalendar\.js$/.test(parent.filename) && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const { extractMeetCode, listUpcomingMeetMeetings, listRecentlyEndedMeetMeetings } = require('./gmeetCalendar');

test.after(() => { Module._resolveFilename = originalResolve; });

function resetFx() {
    fx.items = [];
    fx.listCalls.length = 0;
    fx.clientOpts = null;
}

const session = { accessToken: 'at', refreshToken: 'rt' };

function meetEvent({ id, endMs, startMs, link = 'https://meet.google.com/abc-defg-hij' }) {
    return {
        id,
        summary: id,
        hangoutLink: link,
        start: { dateTime: new Date(startMs ?? (endMs - 1800_000)).toISOString() },
        end: endMs != null ? { dateTime: new Date(endMs).toISOString() } : undefined,
        organizer: { email: 'org@example.com' },
    };
}

// ── extractMeetCode ──────────────────────────────────────────────────

test('extractMeetCode: full URLs, entry-point URIs, bare codes', () => {
    assert.equal(extractMeetCode('https://meet.google.com/abc-defg-hij'), 'abc-defg-hij');
    assert.equal(extractMeetCode('https://meet.google.com/abc-defg-hij?authuser=0&hs=187'), 'abc-defg-hij');
    assert.equal(extractMeetCode('https://meet.google.com/abc-defg-hij/'), 'abc-defg-hij');
    assert.equal(extractMeetCode('meet.google.com/abc-defg-hij'), 'abc-defg-hij');
    assert.equal(extractMeetCode('abc-defg-hij'), 'abc-defg-hij');
    assert.equal(extractMeetCode('ABC-DEFG-HIJ'), 'abc-defg-hij');
    assert.equal(extractMeetCode('  https://meet.google.com/zzz-zzzz-zzz  '), 'zzz-zzzz-zzz');
});

test('extractMeetCode: non-Meet input → null', () => {
    assert.equal(extractMeetCode('https://zoom.us/j/123456'), null);
    assert.equal(extractMeetCode('https://meet.google.com/lookup/team-standup'), null);
    assert.equal(extractMeetCode('https://meet.google.com/abcd-efg-hij'), null); // wrong grouping
    assert.equal(extractMeetCode('abc-defg-hijk'), null); // extra letter
    assert.equal(extractMeetCode('tel:+31-20-1234567'), null);
    assert.equal(extractMeetCode(''), null);
    assert.equal(extractMeetCode(null), null);
    assert.equal(extractMeetCode(undefined), null);
});

// ── listUpcomingMeetMeetings ─────────────────────────────────────────

test('listUpcomingMeetMeetings: filters to Meet events, maps hangoutLink and entryPoints uri', async () => {
    resetFx();
    const start = Date.now() + 3600_000;
    fx.items = [
        {
            id: 'e1', iCalUID: 'ical-1', summary: 'Standup',
            hangoutLink: 'https://meet.google.com/abc-defg-hij',
            start: { dateTime: new Date(start).toISOString() },
            end: { dateTime: new Date(start + 1800_000).toISOString() },
            organizer: { email: 'tom@example.com', self: true },
            attendees: [
                { email: 'tom@example.com', displayName: 'Tom', self: true },
                { email: 'ext@example.org' },
            ],
        },
        {
            id: 'e2', summary: 'Client call',
            conferenceData: { entryPoints: [{ uri: 'https://meet.google.com/zzz-zzzz-zzz?hs=122' }] },
            start: { dateTime: new Date(start).toISOString() },
            end: { dateTime: new Date(start + 3600_000).toISOString() },
            organizer: { email: 'ext@example.org' },
        },
        { id: 'e3', summary: 'No conference', start: { dateTime: new Date(start).toISOString() } },
        {
            id: 'e4', summary: 'Zoom call',
            conferenceData: { entryPoints: [{ uri: 'https://zoom.us/j/1' }] },
            start: { dateTime: new Date(start).toISOString() },
        },
    ];

    const rows = await listUpcomingMeetMeetings({ session, windowHours: 12 });
    assert.deepEqual(rows.map(r => r.eventId), ['e1', 'e2']);

    assert.deepEqual(rows[0], {
        eventId: 'e1',
        iCalUID: 'ical-1',
        title: 'Standup',
        start: fx.items[0].start.dateTime,
        end: fx.items[0].end.dateTime,
        organizerEmail: 'tom@example.com',
        organizerSelf: true,
        attendees: [
            { email: 'tom@example.com', displayName: 'Tom', self: true },
            { email: 'ext@example.org', displayName: null, self: false },
        ],
        meetingCode: 'abc-defg-hij',
        meetLink: 'https://meet.google.com/abc-defg-hij',
    });
    assert.equal(rows[1].meetingCode, 'zzz-zzzz-zzz');
    assert.equal(rows[1].organizerSelf, false);
    assert.equal(rows[1].iCalUID, null);

    assert.deepEqual(fx.clientOpts && { api: fx.clientOpts.api, version: fx.clientOpts.version }, { api: 'calendar', version: 'v3' });
    const params = fx.listCalls[0];
    assert.equal(params.calendarId, 'primary');
    assert.equal(params.singleEvents, true);
    assert.equal(params.orderBy, 'startTime');
    const now = Date.now();
    assert.ok(Math.abs(Date.parse(params.timeMin) - now) < 5000, 'timeMin ≈ now');
    assert.ok(Math.abs(Date.parse(params.timeMax) - (now + 12 * 3600_000)) < 5000, 'timeMax ≈ now + windowHours');
});

// ── listRecentlyEndedMeetMeetings ────────────────────────────────────

test('listRecentlyEndedMeetMeetings: grace + lookback window filtering', async () => {
    resetFx();
    const now = Date.now();
    fx.items = [
        meetEvent({ id: 'just-ended', endMs: now - 2 * 60_000 }),      // inside grace → excluded
        meetEvent({ id: 'done', endMs: now - 30 * 60_000 }),           // → included
        meetEvent({ id: 'ongoing', endMs: now + 30 * 60_000 }),        // still running → excluded
        meetEvent({ id: 'ancient', endMs: now - 30 * 3600_000 }),      // beyond lookback → excluded
        meetEvent({ id: 'no-end', endMs: null, startMs: now - 3600_000 }), // no end → excluded
    ];

    const rows = await listRecentlyEndedMeetMeetings({ session, lookbackHours: 24, graceMinutes: 5 });
    assert.deepEqual(rows.map(r => r.eventId), ['done']);

    const params = fx.listCalls[0];
    assert.ok(Math.abs(Date.parse(params.timeMin) - (now - 24 * 3600_000)) < 5000, 'timeMin ≈ now - lookback');
    assert.ok(Math.abs(Date.parse(params.timeMax) - now) < 5000, 'timeMax ≈ now');
    assert.equal(params.singleEvents, true);
    assert.equal(params.orderBy, 'startTime');
});

test('list functions propagate not-connected errors', async () => {
    resetFx();
    await assert.rejects(
        () => listUpcomingMeetMeetings({ session: {} }),
        /Not connected to Google/,
    );
    await assert.rejects(
        () => listRecentlyEndedMeetMeetings({ session: {} }),
        /Not connected to Google/,
    );
});
