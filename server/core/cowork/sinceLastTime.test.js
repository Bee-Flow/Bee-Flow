// @typecheck
/**
 * "Only what is new since last time" (./sinceLastTime.mts): when the last good run STARTED, read from the item's runs
 * (stores/coworkStarts.mts lastGoodRunStart, handed in here), as trigger data for a plan and as one line for a prompt
 * or an agent run. What the item itself says about its last run (last_run_at is written when a run ends, last_status
 * is that of the latest run, failed or not) decides nothing.
 *
 * Run: cd server && node --test core/cowork/sinceLastTime.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { lastGoodRunAt, sinceTriggerData, sinceLine } = require('./sinceLastTime.mts');

const STARTED = '2026-11-22T06:30:00.000Z';
const ITEM = { id: 's1', timezone: 'Europe/Amsterdam' };

/** @param {string | null} answer */
function runs(answer) {
    /** @type {string[]} */
    const asked = [];
    return { asked, lastGoodRunStart: async (/** @type {string} */ id) => { asked.push(id); return answer; } };
}

test('the last good run is when it started, as the item\'s runs say', async () => {
    const deps = runs(STARTED);
    assert.strictEqual(await lastGoodRunAt(ITEM, deps), STARTED);
    assert.deepStrictEqual(deps.asked, ['s1']);
    assert.strictEqual(await lastGoodRunAt(ITEM, runs(null)), null, 'no good run yet');
    assert.strictEqual(await lastGoodRunAt(ITEM, runs('not a time')), null);
    assert.strictEqual(await lastGoodRunAt({}, runs(STARTED)), null, 'an item without an id has no runs');
});

test('a failed last run does not empty it: the item\'s own last status and end time are not read', async () => {
    const failedLast = { ...ITEM, lastStatus: 'error', lastRunAt: '2026-11-23T06:31:00.000Z' };
    assert.strictEqual(await lastGoodRunAt(failedLast, runs(STARTED)), STARTED);
});

test('a read that fails gives no "since": the run reports all it finds', async () => {
    const broken = { lastGoodRunStart: async () => { throw new Error('database away'); } };
    assert.strictEqual(await lastGoodRunAt(ITEM, broken), null);
});

test('a plan reads it as trigger data, empty on a first run', async () => {
    const now = new Date('2026-11-23T06:30:00.000Z');
    assert.deepStrictEqual(await sinceTriggerData(ITEM, now, runs(STARTED)), { since: STARTED, now: '2026-11-23T06:30:00.000Z' });
    assert.deepStrictEqual(await sinceTriggerData(ITEM, now, runs(null)), { since: '', now: '2026-11-23T06:30:00.000Z' });
});

test('a prompt run gets one line in its own time zone; a first run gets none', async () => {
    const line = await sinceLine(ITEM, runs(STARTED));
    assert.match(line, /## Since last time/);
    assert.match(line, /started Sunday, 22 November 2026 at 07:30/);
    assert.match(line, /only what is new since then/);
    assert.strictEqual(await sinceLine(ITEM, runs(null)), '');
});
