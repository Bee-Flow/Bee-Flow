'use strict';

/**
 * The per-user image count, against a REAL Postgres (@electric-sql/pglite,
 * in-process). The sibling suite pins the parameters; this one proves the SQL
 * counts the right rows: this user's, of the image source, inside each rolling
 * window.
 *
 * Run: cd server && node --test stores/usageStore.imageCounts.pg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { newPglite } = require('../testUtils/pgliteTemplate');
const { pgliteQuery } = require('../testUtils/pglitePool');
const pg = newPglite();
const db = { query: pgliteQuery(pg) };

const { getUserImageCounts } = require('./usage/counts');

const WINDOWS = { hour: 3_600_000, day: 86_400_000, week: 604_800_000, month: 2_592_000_000 };
const NOW = new Date('2026-11-13T12:00:00.000Z');
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

before(async () => {
    await pg.exec(`CREATE TABLE ai_usage_log (
        id SERIAL PRIMARY KEY, timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        user_id TEXT, source TEXT DEFAULT 'unknown')`);
    const rows = [
        ['u1', 'image_generation', ago(5 * MIN)],
        ['u1', 'image_generation', ago(59 * MIN)],
        ['u1', 'image_generation', ago(2 * HOUR)],
        ['u1', 'image_generation', ago(3 * DAY)],
        ['u1', 'image_generation', ago(20 * DAY)],
        ['u1', 'image_generation', ago(31 * DAY)],   // outside every window
        ['u1', 'chat', ago(1 * MIN)],                // another source
        ['u1', 'video_generation', ago(1 * MIN)],
        ['u2', 'image_generation', ago(1 * MIN)],    // another user
    ];
    for (const [user, source, at] of rows) {
        await db.query('INSERT INTO ai_usage_log (user_id, source, timestamp) VALUES ($1, $2, $3)', [user, source, at]);
    }
});

after(async () => { await pg.close(); });

test('counts this user\'s images inside each rolling window', async () => {
    assert.deepStrictEqual(await getUserImageCounts('u1', WINDOWS, { now: NOW, db }), { hour: 2, day: 3, week: 4, month: 5 });
});

test('another user has their own count', async () => {
    assert.deepStrictEqual(await getUserImageCounts('u2', WINDOWS, { now: NOW, db }), { hour: 1, day: 1, week: 1, month: 1 });
});

test('a user without images counts zero', async () => {
    assert.deepStrictEqual(await getUserImageCounts('nobody', WINDOWS, { now: NOW, db }), { hour: 0, day: 0, week: 0, month: 0 });
});
