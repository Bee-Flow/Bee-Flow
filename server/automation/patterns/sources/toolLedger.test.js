'use strict';

/**
 * Run: cd server && node --test automation/patterns/sources/toolLedger.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { collectToolLedger, appOf } = require('./toolLedger');

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 3, 18, 0);
const win = { now: NOW, since: NOW - 90 * DAY };

test('maps ledger rows to tool events, keyed by conversation', async () => {
    const calls = [];
    const rows = [
        { tool_name: 'gmail_search', integration_type: 'gmail', timestamp: new Date(NOW - 3 * DAY), conversation_id: 'c1' },
        { tool_name: 'sheets_append_rows', integration_type: 'google_sheets', timestamp: new Date(NOW - 3 * DAY + 60_000), conversation_id: 'c1' },
    ];
    const events = await collectToolLedger({
        userId: 'u1', ...win,
        deps: { getManualToolEvents: async (p) => { calls.push(p); return rows; } },
    });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].userId, 'u1');
    assert.strictEqual(calls[0].since.getTime(), win.since);
    assert.deepStrictEqual(events.map((e) => [e.source, e.objectType, e.app, e.verb, e.sessionKey]), [
        ['ledger', 'tool', 'gmail', 'gmail_search', 'c1'],
        ['ledger', 'tool', 'google_sheets', 'sheets_append_rows', 'c1'],
    ]);
    assert.ok(events.every((e) => e.template === null && e.templateId === null));
});

test('drops rows outside the window, without a tool, or with an unusable name', async () => {
    const rows = [
        { tool_name: 'gmail_search', integration_type: 'gmail', timestamp: new Date(NOW - 120 * DAY) },
        { tool_name: '', integration_type: 'gmail', timestamp: new Date(NOW - DAY) },
        { tool_name: 'weird tool/name', integration_type: 'x', timestamp: new Date(NOW - DAY) },
        { tool_name: 'outlook_search', integration_type: null, timestamp: (NOW - DAY) / 1000 },
    ];
    const events = await collectToolLedger({ userId: 'u1', ...win, deps: { getManualToolEvents: async () => rows } });
    assert.deepStrictEqual(events.map((e) => [e.app, e.verb, e.sessionKey]), [['outlook', 'outlook_search', null]]);
});

test('no user, no read', async () => {
    let called = false;
    const events = await collectToolLedger({ userId: '', ...win, deps: { getManualToolEvents: async () => { called = true; return []; } } });
    assert.deepStrictEqual(events, []);
    assert.strictEqual(called, false);
});

test('appOf prefers the ledger integration id', () => {
    assert.strictEqual(appOf({ integration_type: 'Nextcloud_Mail', tool_name: 'nextcloud_mail_search' }), 'nextcloud_mail');
    assert.strictEqual(appOf({ integration_type: null, tool_name: 'drive_list_files' }), 'drive');
});
