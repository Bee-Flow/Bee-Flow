/**
 * BFSF-254 (Microsoft twin) — ms_calendar_update_event time zone + notes.
 *
 * Two silent-corruption bugs lived in executeMsCalendarAction:
 *
 *  1. The update branch stamped `timeZone: 'UTC'` on every time change. The
 *     update draft carries no zone (the tool never emitted one, and the
 *     approval card only injects the browser zone on CREATE), so an approved
 *     reschedule wrote the user's naive wall-clock time as UTC — shifting the
 *     meeting by the user's offset and permanently rewriting the event's
 *     stored zone, with attendees notified of the wrong time.
 *  2. The draft carries the notes as `description`, but both branches read
 *     `draft.body` / `changes.body`. The description was therefore never sent,
 *     and a notes-only update produced an empty `PATCH {}` that still reported
 *     "updated successfully".
 *
 * './msGraphClient' is stubbed via installResolveStub (pattern:
 * calendarTools.test.js) with a fake Graph recording every request.
 *
 * Run: cd server && node --test integrations/msCalendarTools.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../testUtils/stubRequire');

// ── Fake Graph client ───────────────────────────────────────────────
const calls = [];
let storedEvent = {};

const restore = installResolveStub({
    './msGraphClient': {
        isMicrosoftConnected: () => true,
        graphFetch: async (path, session, options = {}) => {
            const method = options.method || 'GET';
            calls.push({ path, method, body: options.body ? JSON.parse(options.body) : null });
            if (method === 'GET') return storedEvent;
            return { id: 'AAA', subject: storedEvent.subject || 'Standup' };
        },
        GRAPH_BASE: 'https://graph.microsoft.com/v1.0',
    },
});

const {
    MS_CALENDAR_TOOLS,
    executeMsCalendarTool,
    executeMsCalendarAction,
} = require('./msCalendarTools');

test.after(() => restore());

const SESSION = { oauthProvider: 'microsoft', accessToken: 'at' };

const AMSTERDAM_EVENT = {
    id: 'AAA',
    subject: 'Standup',
    start: { dateTime: '2026-09-01T09:00:00.0000000', timeZone: 'Europe/Amsterdam' },
    end: { dateTime: '2026-09-01T09:30:00.0000000', timeZone: 'Europe/Amsterdam' },
};

function reset(fixture = AMSTERDAM_EVENT) {
    calls.length = 0;
    storedEvent = fixture;
}

const patchOf = () => calls.find(c => c.method === 'PATCH').body;

// ═══ Time zone ══════════════════════════════════════════════════════

test('update: a reschedule keeps the event\'s stored zone instead of stamping UTC', async () => {
    reset();
    const { draft } = await executeMsCalendarTool('ms_calendar_update_event',
        { eventId: 'AAA', startTime: '2026-09-01T14:00:00', endTime: '2026-09-01T15:00:00' }, SESSION);
    assert.strictEqual(draft.timeZone, undefined, 'update draft carries no zone of its own');

    await executeMsCalendarAction('update', draft, SESSION);
    const patch = patchOf();
    assert.strictEqual(patch.start.timeZone, 'Europe/Amsterdam', 'stored start zone preserved (was UTC)');
    assert.strictEqual(patch.end.timeZone, 'Europe/Amsterdam', 'stored end zone preserved');
    assert.strictEqual(patch.start.dateTime, '2026-09-01T14:00:00', 'wall-clock time passed through unchanged');
});

test('update: an explicit timeZone from the model wins and skips the read', async () => {
    reset();
    const { draft } = await executeMsCalendarTool('ms_calendar_update_event',
        { eventId: 'AAA', startTime: '2026-09-01T14:00:00', timeZone: 'America/New_York' }, SESSION);
    assert.strictEqual(draft.timeZone, 'America/New_York');

    await executeMsCalendarAction('update', draft, SESSION);
    assert.strictEqual(patchOf().start.timeZone, 'America/New_York');
    assert.strictEqual(calls.filter(c => c.method === 'GET').length, 0, 'no lookup needed when the caller is explicit');
});

test('update: UTC remains the fallback when the stored zone cannot be read', async () => {
    reset({});
    await executeMsCalendarAction('update',
        { action: 'update', _provider: 'microsoft', eventId: 'AAA', startTime: '2026-09-01T14:00:00' }, SESSION);
    assert.strictEqual(patchOf().start.timeZone, 'UTC');
});

test('update: a subject-only change never reads or touches start/end', async () => {
    reset();
    await executeMsCalendarAction('update',
        { action: 'update', _provider: 'microsoft', eventId: 'AAA', title: 'Renamed' }, SESSION);
    assert.strictEqual(calls.filter(c => c.method === 'GET').length, 0, 'no event read without a time change');
    const patch = patchOf();
    assert.strictEqual(patch.subject, 'Renamed');
    assert.ok(!('start' in patch) && !('end' in patch), 'stored times and zones left alone');
});

test('ms_calendar_update_event advertises timeZone so the model can be explicit', () => {
    const update = MS_CALENDAR_TOOLS.find(t => t.function.name === 'ms_calendar_update_event');
    assert.ok(update.function.parameters.properties.timeZone, 'timeZone parameter declared');
});

// ═══ Notes / description ════════════════════════════════════════════

test('create: the draft\'s description reaches Graph as the event body', async () => {
    reset();
    const { draft } = await executeMsCalendarTool('ms_calendar_create_event', {
        subject: 'Standup',
        startTime: '2026-09-01T10:00:00',
        endTime: '2026-09-01T10:30:00',
        body: 'Agenda: sprint review',
        timeZone: 'Europe/Amsterdam',
    }, SESSION);
    assert.strictEqual(draft.description, 'Agenda: sprint review', 'draft key is `description`');

    await executeMsCalendarAction('create', draft, SESSION);
    const posted = calls.find(c => c.method === 'POST').body;
    assert.deepStrictEqual(posted.body, { contentType: 'Text', content: 'Agenda: sprint review' });
});

test('update: a notes-only change PATCHes the body instead of sending {}', async () => {
    reset();
    const { draft } = await executeMsCalendarTool('ms_calendar_update_event',
        { eventId: 'AAA', body: 'new notes' }, SESSION);
    const result = await executeMsCalendarAction('update', draft, SESSION);
    assert.deepStrictEqual(patchOf(), { body: { contentType: 'Text', content: 'new notes' } });
    assert.strictEqual(result.success, true);
});

test('update: an empty body clears the notes rather than being ignored', async () => {
    reset();
    const { draft } = await executeMsCalendarTool('ms_calendar_update_event',
        { eventId: 'AAA', body: '' }, SESSION);
    await executeMsCalendarAction('update', draft, SESSION);
    assert.deepStrictEqual(patchOf().body, { contentType: 'Text', content: '' });
});

// ═══ No-op guard ════════════════════════════════════════════════════

test('update: a change-nothing draft errors instead of reporting success', async () => {
    reset();
    await assert.rejects(
        () => executeMsCalendarAction('update', { action: 'update', _provider: 'microsoft', eventId: 'AAA' }, SESSION),
        /No changes to apply/,
    );
    assert.strictEqual(calls.filter(c => c.method === 'PATCH').length, 0, 'no empty PATCH is sent');
});
