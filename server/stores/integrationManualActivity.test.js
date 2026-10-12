'use strict';

/**
 * The "Find repeating work" reads on integration_activity_log, against a real
 * Postgres (pglite). Every filter is a privacy or correctness rule, so each
 * one gets a row that it alone must keep out.
 *
 * Run: cd server && node --test stores/integrationManualActivity.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { pgliteDb } = require('../testUtils/pgliteDb');
const { makeManualActivityReader, MANUAL_SOURCES } = require('./integrationManualActivity');

const { pg, db } = pgliteDb();
const reader = makeManualActivityReader(db);

const DAY = 86400_000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

before(async () => {
    // The columns these reads touch, as the store's ladder declares them.
    await pg.exec(`
        CREATE TABLE integration_activity_log (
            id SERIAL PRIMARY KEY,
            timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            organization_id TEXT, user_id TEXT, acting_user_id TEXT, conversation_id TEXT,
            tool_name TEXT NOT NULL, integration_type TEXT, source TEXT DEFAULT 'unknown',
            data_summary TEXT, automation_id TEXT, is_dry_run BOOLEAN DEFAULT false,
            status TEXT NOT NULL DEFAULT 'success'
        )
    `);
    const rows = [
        // [user, tool, source, daysAgo, extra]
        ['u1', 'gmail_search', 'agent_chat', 10, {}],
        ['u1', 'sheets_append', 'direct_chat', 9, { conversation_id: 'c1' }],
        ['u1', 'outlook_list_recent', 'agent_stream', 8, {}],
        ['u1', 'gmail_search', 'pattern_scan', 7, {}],                 // the scan's own read
        ['u1', 'gmail_search', 'automation', 7, {}],                      // not a chat source
        ['u1', 'gmail_search', 'agent_chat', 6, { status: 'error' }],  // failed call
        ['u1', 'gmail_search', 'agent_chat', 6, { is_dry_run: true }], // dry run
        ['u1', 'drive_upload', 'agent_chat', 5, { automation_id: 'a1' }],
        ['u1', 'gmail_search', 'agent_chat', 120, {}],                 // outside the window
        ['u2', 'gmail_search', 'agent_chat', 4, { organization_id: 'o1', acting_user_id: 'u1' }], // colleague / borrowed
        ['u2', 'teams_post', 'automation', 4, { automation_id: 'a2' }],
    ];
    for (const [user, tool, source, d, extra] of rows) {
        await pg.query(
            `INSERT INTO integration_activity_log
                (user_id, tool_name, integration_type, source, timestamp, conversation_id, status, is_dry_run, automation_id, organization_id, acting_user_id, data_summary)
             VALUES ($1, $2, split_part($2, '_', 1), $3, $4, $5, $6, $7, $8, $9, $10, 'subject: secret')`,
            [user, tool, source, ago(d), extra.conversation_id || null, extra.status || 'success', !!extra.is_dry_run,
                extra.automation_id || null, extra.organization_id || null, extra.acting_user_id || null],
        );
    }
});
after(() => pg.close());

test('the source allow-list is the three chat paths', () => {
    assert.deepStrictEqual([...MANUAL_SOURCES], ['agent_chat', 'agent_stream', 'direct_chat']);
});

test('only the user\'s own successful, live, manual chat calls in the window, oldest first', async () => {
    const rows = await reader.getManualToolEvents({ userId: 'u1', since: ago(90) });
    assert.deepStrictEqual(rows.map(r => r.tool_name), ['gmail_search', 'sheets_append', 'outlook_list_recent']);
    assert.deepStrictEqual(Object.keys(rows[0]).sort(), ['conversation_id', 'integration_type', 'timestamp', 'tool_name']);
    assert.strictEqual(rows[1].conversation_id, 'c1');
    assert.strictEqual(rows[1].integration_type, 'sheets');
});

test('a borrowed connection never counts for the lender (acting_user_id is ignored)', async () => {
    const rows = await reader.getManualToolEvents({ userId: 'u1', since: ago(90) });
    assert.ok(rows.every(r => r.tool_name !== 'gmail_search' || Date.parse(r.timestamp) < Date.now() - 5 * DAY));
    assert.strictEqual(rows.length, 3);
});

test('the limit keeps the most recent calls, still oldest first', async () => {
    const rows = await reader.getManualToolEvents({ userId: 'u1', since: ago(90), limit: 2 });
    assert.deepStrictEqual(rows.map(r => r.tool_name), ['sheets_append', 'outlook_list_recent']);
});

test('the default window is 90 days', async () => {
    const rows = await reader.getManualToolEvents({ userId: 'u1' });
    assert.strictEqual(rows.length, 3);
});

test('no user means no rows', async () => {
    assert.deepStrictEqual(await reader.getManualToolEvents({ userId: '' }), []);
    assert.deepStrictEqual(await reader.getAutomatedToolNames({ userId: null }), []);
});

test('getAutomatedToolNames lists the tools the user\'s own automations ran', async () => {
    assert.deepStrictEqual(await reader.getAutomatedToolNames({ userId: 'u1', since: ago(90) }), ['drive_upload']);
    assert.deepStrictEqual(await reader.getAutomatedToolNames({ userId: 'u2', since: ago(90) }), ['teams_post']);
});
