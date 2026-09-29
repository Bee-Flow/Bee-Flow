/**
 * BFSF-254 — calendar_create_event / calendar_update_event timezone handling.
 *
 * Google Calendar rejects a bare local dateTime with "Missing time zone
 * definition for start time"; before this fix neither the draft nor the
 * approved insert carried any timezone (and the default +1h end mixed a
 * Z-suffixed end with a naive start, silently shifting events even when
 * creation succeeded). Pins: tz precedence in drafts (args > dispatch context
 * > Europe/Amsterdam default), start/end always sent with timeZone, the
 * rollover-safe naive +1h default end, offset passthrough, all-day exemption,
 * and update-preserves-the-event's-stored-zone.
 *
 * './googleClient' is stubbed via installResolveStub (pattern:
 * googleClient.test.js) with a fake calendar client recording request bodies.
 *
 * Run: cd server && node --test integrations/calendarTools.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../testUtils/stubRequire');

// ── Fake calendar client ────────────────────────────────────────────
const calls = { insert: [], update: [], get: [] };
let currentEventFixture = {};

const fakeCalendar = {
    events: {
        list: async () => ({ data: { items: [] } }),
        insert: async (req) => { calls.insert.push(req); return { data: { id: 'ev1', summary: req.requestBody.summary, start: req.requestBody.start, end: req.requestBody.end, htmlLink: 'https://cal/x' } }; },
        get: async (req) => { calls.get.push(req); return { data: currentEventFixture }; },
        update: async (req) => { calls.update.push(req); return { data: { id: req.eventId, summary: req.requestBody.summary, start: req.requestBody.start, end: req.requestBody.end } }; },
        delete: async () => ({}),
    },
};

const restore = installResolveStub({
    './googleClient': { createGoogleApiClient: async () => fakeCalendar },
    '../auth/permissions': { loadConfig: async () => ({}) },
});

const { executeCalendarTool, executeCalendarAction } = require('./calendarTools');

test.after(() => restore());

function resetCalls() {
    calls.insert.length = 0;
    calls.update.length = 0;
    calls.get.length = 0;
    currentEventFixture = {};
}

const SESSION = { oauthProvider: 'google', accessToken: 'at' };

// ═══ Draft timezone precedence ══════════════════════════════════════

test('create draft: model timeZone > dispatch-context timezone > default', async () => {
    resetCalls();
    let r = await executeCalendarTool('calendar_create_event',
        { title: 'Standup', startTime: '2026-03-01T14:00:00', timeZone: 'Europe/Berlin' },
        SESSION, { timezone: 'America/New_York' });
    assert.strictEqual(r.draft.timeZone, 'Europe/Berlin', 'model-provided zone wins');

    r = await executeCalendarTool('calendar_create_event',
        { title: 'Standup', startTime: '2026-03-01T14:00:00' },
        SESSION, { timezone: 'America/New_York' });
    assert.strictEqual(r.draft.timeZone, 'America/New_York', 'browser zone from the dispatch context');

    r = await executeCalendarTool('calendar_create_event',
        { title: 'Standup', startTime: '2026-03-01T14:00:00' },
        SESSION, {});
    assert.strictEqual(r.draft.timeZone, 'Europe/Amsterdam', 'server default as last resort');
});

test('update draft: NO default zone — omitted means "preserve the event zone"', async () => {
    resetCalls();
    const r = await executeCalendarTool('calendar_update_event',
        { eventId: 'ev1', startTime: '2026-03-01T15:00:00' },
        SESSION, { timezone: 'America/New_York' });
    assert.strictEqual(r.draft.timeZone, null);
});

// ═══ Approved create ════════════════════════════════════════════════

test('create: naive start gets {dateTime, timeZone} and a rollover-safe naive +1h end', async () => {
    resetCalls();
    await executeCalendarAction({
        action: 'create', title: 'Late sync',
        startTime: '2026-03-01T23:30:00', timeZone: 'Europe/Amsterdam',
    }, SESSION);

    const body = calls.insert[0].requestBody;
    assert.deepStrictEqual(body.start, { dateTime: '2026-03-01T23:30:00', timeZone: 'Europe/Amsterdam' });
    // WALL-CLOCK +1h across the midnight rollover — never a Z-suffixed end
    // next to a naive start (which shifts the event by the UTC offset).
    assert.deepStrictEqual(body.end, { dateTime: '2026-03-02T00:30:00', timeZone: 'Europe/Amsterdam' });
});

test('create: offset-bearing start passes through unchanged, absolute +1h end', async () => {
    resetCalls();
    await executeCalendarAction({
        action: 'create', title: 'Call',
        startTime: '2026-03-01T14:00:00+01:00', timeZone: 'Europe/Amsterdam',
    }, SESSION);

    const body = calls.insert[0].requestBody;
    assert.strictEqual(body.start.dateTime, '2026-03-01T14:00:00+01:00', 'offset preserved (authoritative for Google)');
    assert.strictEqual(body.start.timeZone, 'Europe/Amsterdam');
    assert.strictEqual(new Date(body.end.dateTime).getTime(), new Date('2026-03-01T15:00:00+01:00').getTime(), 'exactly +1h absolute');
});

test('create: legacy draft without timeZone still sends the default (never bare)', async () => {
    resetCalls();
    await executeCalendarAction({ action: 'create', title: 'Old draft', startTime: '2026-06-16T12:00:00' }, SESSION);
    const body = calls.insert[0].requestBody;
    assert.strictEqual(body.start.timeZone, 'Europe/Amsterdam', 'the exact reported failure: no more bare dateTime');
    assert.ok(body.end.timeZone, 'end carries a zone too');
});

test('create: all-day events stay date-only without timezone', async () => {
    resetCalls();
    await executeCalendarAction({ action: 'create', title: 'Vacation', startTime: '2026-03-01', allDay: true, timeZone: 'Europe/Amsterdam' }, SESSION);
    const body = calls.insert[0].requestBody;
    assert.deepStrictEqual(body.start, { date: '2026-03-01' });
    assert.deepStrictEqual(body.end, { date: '2026-03-02' });
});

// ═══ Approved update ════════════════════════════════════════════════

test('update: preserves the event\'s stored timezone when the draft has none', async () => {
    resetCalls();
    currentEventFixture = {
        id: 'ev1', summary: 'Old',
        start: { dateTime: '2026-03-01T10:00:00', timeZone: 'America/Chicago' },
        end: { dateTime: '2026-03-01T11:00:00', timeZone: 'America/Chicago' },
    };
    await executeCalendarAction({ action: 'update', eventId: 'ev1', startTime: '2026-03-01T12:00:00', timeZone: null }, SESSION);
    const body = calls.update[0].requestBody;
    assert.deepStrictEqual(body.start, { dateTime: '2026-03-01T12:00:00', timeZone: 'America/Chicago' }, 'stored zone preserved');
});

test('update: an explicitly supplied zone wins; title-only updates never touch start/end', async () => {
    resetCalls();
    currentEventFixture = {
        id: 'ev1', summary: 'Old',
        start: { dateTime: '2026-03-01T10:00:00', timeZone: 'America/Chicago' },
        end: { dateTime: '2026-03-01T11:00:00', timeZone: 'America/Chicago' },
    };
    await executeCalendarAction({ action: 'update', eventId: 'ev1', startTime: '2026-03-01T12:00:00', timeZone: 'Europe/Amsterdam' }, SESSION);
    assert.strictEqual(calls.update[0].requestBody.start.timeZone, 'Europe/Amsterdam');

    resetCalls();
    currentEventFixture = {
        id: 'ev1', summary: 'Old',
        start: { dateTime: '2026-03-01T10:00:00', timeZone: 'America/Chicago' },
        end: { dateTime: '2026-03-01T11:00:00', timeZone: 'America/Chicago' },
    };
    await executeCalendarAction({ action: 'update', eventId: 'ev1', title: 'Renamed only', startTime: null, endTime: null, timeZone: null }, SESSION);
    const body = calls.update[0].requestBody;
    assert.strictEqual(body.summary, 'Renamed only');
    assert.deepStrictEqual(body.start, currentEventFixture.start, 'start untouched on a title-only update');
});
