'use strict';

/**
 * The typical-duration read, run for real against PGlite: only live, non-test
 * legs that finished or paused on a form, with a positive duration, newest
 * first, limit clamped.
 *
 * Run: cd server && node --test stores/automationStore/runDurations.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { PGlite } = require('@electric-sql/pglite');
const { recentLegDurations } = require('./runDurations');

const pg = new PGlite();
const query = async (sql, params) => (await pg.query(sql, params)).rows;

before(async () => {
    await pg.exec(`
        CREATE TABLE automation_runs (
            id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, status TEXT, mode TEXT DEFAULT 'live',
            is_test BOOLEAN NOT NULL DEFAULT FALSE, duration_ms INT, started_at TIMESTAMPTZ
        );
        INSERT INTO automation_runs (id, automation_id, status, mode, is_test, duration_ms, started_at) VALUES
            ('ok1', 'a1', 'success', 'live', FALSE, 1000, NOW() - INTERVAL '10 minutes'),
            ('ok2', 'a1', 'awaiting_form', 'live', FALSE, 3000, NOW() - INTERVAL '5 minutes'),
            ('ok3', 'a1', 'success', 'live', FALSE, 2000, NOW() - INTERVAL '1 minute'),
            ('dry', 'a1', 'success', 'dry_run', FALSE, 111, NOW()),
            ('tst', 'a1', 'success', 'live', TRUE, 222, NOW()),
            ('err', 'a1', 'error', 'live', FALSE, 333, NOW()),
            ('run', 'a1', 'running', 'live', FALSE, 444, NOW()),
            ('nul', 'a1', 'success', 'live', FALSE, NULL, NOW()),
            ('zer', 'a1', 'success', 'live', FALSE, 0, NOW()),
            ('oth', 'a2', 'success', 'live', FALSE, 999, NOW());
    `);
    for (let i = 0; i < 120; i++) {
        await pg.query(
            `INSERT INTO automation_runs (id, automation_id, status, duration_ms, started_at)
             VALUES ($1, 'many', 'success', $2, NOW() - ($3 || ' seconds')::interval)`,
            [`m${i}`, 1000 + i, String(i)],
        );
    }
});
after(async () => { await pg.close(); });

test('only live, non-test success/awaiting_form legs with a positive duration, newest first', async () => {
    assert.deepStrictEqual(await recentLegDurations('a1', { query }), [2000, 3000, 1000]);
});

test('another automation and an empty id never leak in', async () => {
    assert.deepStrictEqual(await recentLegDurations('a2', { query }), [999]);
    assert.deepStrictEqual(await recentLegDurations('', { query }), []);
    assert.deepStrictEqual(await recentLegDurations('none', { query }), []);
});

test('the default is 20, and a limit is clamped to 1..100', async () => {
    assert.strictEqual((await recentLegDurations('many', { query })).length, 20);
    assert.strictEqual((await recentLegDurations('many', { limit: 0, query })).length, 20);
    assert.strictEqual((await recentLegDurations('many', { limit: -5, query })).length, 1);
    assert.strictEqual((await recentLegDurations('many', { limit: 5, query })).length, 5);
    assert.strictEqual((await recentLegDurations('many', { limit: 5000, query })).length, 100);
    // Newest first: m0 started most recently.
    assert.strictEqual((await recentLegDurations('many', { limit: 1, query }))[0], 1000);
});
