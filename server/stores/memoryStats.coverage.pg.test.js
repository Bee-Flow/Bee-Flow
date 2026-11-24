'use strict';

/**
 * What a Cowork task remembers (the schedule-coverage rows of stores/memoryStats.js), cleared and restored, against a
 * real Postgres (@electric-sql/pglite, in-process, through the real db.js): a clear takes exactly this owner's live
 * rows of this task, Undo brings exactly those back, and nothing of another task or another person moves.
 *
 * Run: cd server && node --test stores/memoryStats.coverage.pg.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');

process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'memory-coverage-test-master-key-32b!!';
const { usePglitePool } = require('../testUtils/pglitePool');
const { close } = usePglitePool();
after(close);

const store = require('./memoryStore');

test('a clear takes this task\'s live rows of its owner, and Undo restores exactly those', async () => {
    const mine = await store.upsertScheduleCoverage({ userId: 'u1', agentId: null, scheduleId: 'cw-1', subject: 'inv-114', title: 'Invoice 2026-114', summary: null });
    const second = await store.upsertScheduleCoverage({ userId: 'u1', agentId: null, scheduleId: 'cw-1', subject: 'ctr-9', title: null, summary: 'Contract renewal' });
    const otherTask = await store.upsertScheduleCoverage({ userId: 'u1', agentId: null, scheduleId: 'cw-2', subject: 'inv-114', title: 'Invoice 2026-114', summary: null });
    const otherOwner = await store.upsertScheduleCoverage({ userId: 'u2', agentId: null, scheduleId: 'cw-1', subject: 'x', title: 'Not u1\'s', summary: null });

    const cleared = await store.clearScheduleCoverage('u1', 'cw-1');
    assert.deepStrictEqual(cleared.sort(), [mine, second].sort());
    assert.deepStrictEqual((await store.getScheduleCoverage('cw-1')).map((r) => r.id), [otherOwner], 'only another owner\'s row of the same id is left live');
    assert.strictEqual((await store.getScheduleCoverage('cw-2')).length, 1, 'another task keeps what it remembers');

    assert.strictEqual(await store.restoreScheduleCoverage('u1', 'cw-1', [...cleared, otherTask]), 2, 'a row that was not cleared is not touched');
    assert.deepStrictEqual((await store.getScheduleCoverage('cw-1')).map((r) => r.id).sort(), [mine, second, otherOwner].sort());
    assert.strictEqual(await store.restoreScheduleCoverage('u2', 'cw-1', [mine]), 0, 'another person cannot restore someone\'s rows');
    assert.strictEqual(await store.restoreScheduleCoverage('u1', 'cw-1', []), 0);
});
