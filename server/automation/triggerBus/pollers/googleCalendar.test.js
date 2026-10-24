// @typecheck
'use strict';

/**
 * Google Calendar pollers, driven through a fake ctx and a fake Calendar client.
 *
 * Run: node --test automation/triggerBus/pollers/googleCalendar.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { createGoogleCalendarPollers } = require('./googleCalendar');

function calCtx(list) {
    const updates = [];
    const calls = [];
    const ctx = {
        store: () => ({ updateSubscription: async (id, u) => { updates.push({ id, ...u }); } }),
        googleClient: () => ({ createGoogleApiClient: async () => ({ events: { list: async (p) => { calls.push(p); return list(p); } } }) }),
    };
    return { ctx, updates, calls };
}

test('event.changed bootstrap pages through to nextSyncToken, anchors it and delivers nothing', async () => {
    const { ctx, updates, calls } = calCtx((p) => (p.pageToken
        ? { data: { items: [{ id: 'e2' }], nextSyncToken: 'sync-1' } }
        : { data: { items: [{ id: 'e1' }], nextPageToken: 'p2' } }));
    const out = await createGoogleCalendarPollers(ctx)['event.changed']({ id: 'c1', lastCursor: null }, {});
    assert.deepStrictEqual(out, []);
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(updates, [{ id: 'c1', lastCursor: 'sync-1' }]);
});

test('event.changed with a 410 syncToken clears the cursor', async () => {
    const { ctx, updates } = calCtx(() => { throw Object.assign(new Error('Sync token is no longer valid'), { code: 410 }); });
    const out = await createGoogleCalendarPollers(ctx)['event.changed']({ id: 'c2', lastCursor: 'old' }, {});
    assert.deepStrictEqual(out, []);
    assert.deepStrictEqual(updates, [{ id: 'c2', lastCursor: null }]);
});

test('event.upcoming fires once per event inside the lead window and remembers it', async () => {
    const soon = new Date(Date.now() + 10 * 60_000).toISOString();
    const later = new Date(Date.now() + 18 * 60_000).toISOString();
    const items = [
        { id: 'soon', summary: 'Standup', start: { dateTime: soon } },
        { id: 'later', start: { dateTime: later } },
        { id: 'allday', start: { date: '2026-10-13' } },
        { id: 'done', start: { dateTime: soon } },
    ];
    const { ctx, updates } = calCtx(() => ({ data: { items } }));
    const sub = { id: 'u1', filter: { leadMinutes: 15 }, lastCursor: JSON.stringify({ firedIds: ['done'] }) };
    const out = await createGoogleCalendarPollers(ctx)['event.upcoming'](sub, {});
    assert.deepStrictEqual(out.map(e => e.eventId), ['soon']);
    assert.strictEqual(out[0].calendarId, 'primary');
    assert.deepStrictEqual(updates, [{ id: 'u1', lastCursor: JSON.stringify({ firedIds: ['done', 'soon'] }) }]);
});
