// @typecheck strict
/**
 * The retention sweep on cowork_runs, against a real Postgres (PGlite behind
 * db.js's pool, testUtils/pglitePool.js): only closed rows (finished_at stamped,
 * status not 'running'), strictly older than the cutoff, at most `limit` per
 * call (5000 by default), oldest first; a second pass deletes nothing new.
 *
 * Run: cd server && node --test stores/coworkStore.retention.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const coworkStore = require('./coworkStore');

const CUTOFF = '2026-06-01T00:00:00.000Z';

before(async () => {
    await coworkStore.initDB();
    await pg.query("INSERT INTO cowork_schedules (id, user_id, title, prompt) VALUES ('sch1', 'u1', 'T', 'P')");
});
after(close);

/** @param {Array<[string, string, string | null]>} runs id, status, finished_at */
async function seed(runs) {
    await pg.exec('DELETE FROM cowork_runs');
    for (const [id, status, finishedAt] of runs) {
        await pg.query('INSERT INTO cowork_runs (id, schedule_id, user_id, status, started_at, finished_at) VALUES ($1, $2, $3, $4, $5, $6)',
            [id, 'sch1', 'u1', status, '2026-01-01T00:00:00Z', finishedAt]);
    }
}
const left = async () => (await pg.query('SELECT id FROM cowork_runs ORDER BY id')).rows.map((r) => r.id);

test('the sweep deletes only closed rows strictly older than the cutoff, and says how many', async () => {
    await seed([
        ['old-success', 'success', '2026-05-01T00:00:00Z'],
        ['old-error', 'error', '2026-05-02T00:00:00Z'],
        ['old-reauth', 'needs_reauth', '2026-05-03T00:00:00Z'],
        ['old-running', 'running', '2026-05-01T00:00:00Z'],
        ['old-open', 'success', null],
        ['at-cutoff', 'success', CUTOFF],
        ['new', 'success', '2026-07-01T00:00:00Z'],
    ]);
    assert.strictEqual(await coworkStore.deleteRunsOlderThan(CUTOFF), 3);
    assert.deepStrictEqual(await left(), ['at-cutoff', 'new', 'old-open', 'old-running'],
        "a 'running' row and an open row (no finished_at) are never touched; strictly older makes it idempotent");
    assert.strictEqual(await coworkStore.deleteRunsOlderThan(CUTOFF), 0, 'a second pass is a no-op');
});

test('an explicit batch limit is honoured, oldest first', async () => {
    await seed([
        ['a', 'success', '2026-05-03T00:00:00Z'],
        ['b', 'success', '2026-05-01T00:00:00Z'],
        ['c', 'success', '2026-05-02T00:00:00Z'],
    ]);
    assert.strictEqual(await coworkStore.deleteRunsOlderThan(CUTOFF, { limit: 2 }), 2);
    assert.deepStrictEqual(await left(), ['a']);
});
