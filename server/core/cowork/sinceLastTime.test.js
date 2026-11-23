// @typecheck
/**
 * "Only what is new since last time" (./sinceLastTime.mts): the last good run, as trigger data for a plan and as one
 * line for a prompt or an agent run.
 *
 * Run: cd server && node --test core/cowork/sinceLastTime.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { lastGoodRunAt, sinceTriggerData, sinceLine } = require('./sinceLastTime.mts');

const GOOD = { lastRunAt: '2026-11-22T06:30:00.000Z', lastStatus: 'success', timezone: 'Europe/Amsterdam' };

test('the last good run: only a run that ended well counts', () => {
    assert.strictEqual(lastGoodRunAt(GOOD), '2026-11-22T06:30:00.000Z');
    assert.strictEqual(lastGoodRunAt({ ...GOOD, lastStatus: 'error' }), null);
    assert.strictEqual(lastGoodRunAt({ lastRunAt: null, lastStatus: 'success' }), null);
    assert.strictEqual(lastGoodRunAt({ lastRunAt: 'not a time', lastStatus: 'success' }), null);
});

test('a plan reads it as trigger data, empty on a first run', () => {
    const now = new Date('2026-11-23T06:30:00.000Z');
    assert.deepStrictEqual(sinceTriggerData(GOOD, now), { since: '2026-11-22T06:30:00.000Z', now: '2026-11-23T06:30:00.000Z' });
    assert.deepStrictEqual(sinceTriggerData({}, now), { since: '', now: '2026-11-23T06:30:00.000Z' });
});

test('a prompt run gets one line in its own time zone; a first run gets none', () => {
    const line = sinceLine(GOOD);
    assert.match(line, /## Since last time/);
    assert.match(line, /Sunday, 22 November 2026 at 07:30/);
    assert.match(line, /only what is new since then/);
    assert.strictEqual(sinceLine({}), '');
});
