// @typecheck
/**
 * How Cowork runs really ended, read back on a real Postgres (PGlite): the newest finished run of each item of one
 * owner, as its outcome code for the home's status, and those that did not do their work for "Needs you". A run that
 * is still open, or waits for a decision, is not the newest finished one; another owner's items are never read.
 *
 * Run: cd server && node --test stores/coworkRunOutcomes.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../testUtils/pgliteDb');
const { makeCoworkRunOutcomes } = require('./coworkRunOutcomes.mts');

const { pg, db: raw } = pgliteDb();
const db = {
    getAll: async (/** @type {string} */ sql, /** @type {unknown[]} */ params) => (await raw.query(sql, params)).rows,
    getOne: async (/** @type {string} */ sql, /** @type {unknown[]} */ params) => (await raw.query(sql, params)).rows[0] ?? null,
};
const store = makeCoworkRunOutcomes({ db: /** @type {any} */ (db) });

/** @param {string} id @param {string} scheduleId @param {string} status @param {string} startedAt @param {unknown} outcome @param {boolean} [finished] */
const run = (id, scheduleId, status, startedAt, outcome, finished = true) => pg.query(
    'INSERT INTO cowork_runs (id, schedule_id, status, started_at, finished_at, outcome_json) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, scheduleId, status, startedAt, finished ? startedAt : null, outcome === null ? null : JSON.stringify(outcome)],
);

before(async () => {
    await pg.exec(`CREATE TABLE cowork_schedules (id TEXT PRIMARY KEY, user_id TEXT);
        CREATE TABLE cowork_runs (id TEXT PRIMARY KEY, schedule_id TEXT, status TEXT, started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ, outcome_json TEXT)`);
    for (const [id, user] of [['w1', 'ann'], ['w2', 'ann'], ['w3', 'ann'], ['w4', 'bob']]) await pg.query('INSERT INTO cowork_schedules (id, user_id) VALUES ($1, $2)', [id, user]);
    await run('r1', 'w1', 'success', '2026-11-23T07:00:00Z', { kind: 'done' });
    await run('r2', 'w1', 'success', '2026-11-24T07:00:00Z', { kind: 'nothing_to_do' });
    await run('r3', 'w1', 'running', '2026-11-24T09:00:00Z', null, false);
    await run('r4', 'w2', 'incomplete', '2026-11-24T07:00:00Z', { kind: 'incomplete', unresolved: [] });
    await run('r5', 'w3', 'success', '2026-11-24T07:00:00Z', null);
    await run('r6', 'w4', 'success', '2026-11-24T07:00:00Z', { kind: 'nothing_to_do' });
});
after(async () => { await pg.close(); });

test('the outcome code of each item\'s newest finished run; a run without one and another owner\'s items are left out', async () => {
    assert.deepStrictEqual(await store.lastOutcomes('ann'), { w1: 'nothing_to_do', w2: 'incomplete' });
    assert.deepStrictEqual(await store.lastOutcomes('carol'), {});
});

test('the same newest runs, those that did not do their work', async () => {
    assert.deepStrictEqual((await store.lastRunProblems('ann')).map((p) => [p.itemId, p.runId, p.kind]), [['w2', 'r4', 'incomplete']]);
});
