// @typecheck
/**
 * The next moment of a repeating Cowork item (./coworkNextRun.mts): after downtime the item runs once and then moves
 * to the first moment that is still ahead, instead of once per missed moment.
 *
 * Run: cd server && node --test stores/coworkNextRun.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { nextRunAfter, MAX_CATCH_UP_STEPS } = require('./coworkNextRun.mts');
const { advanceNextRun } = require('./aiTaskStore');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

test('an item that is on time moves one step, exactly as before', () => {
    const now = new Date('2026-11-23T08:00:30Z');
    const next = nextRunAfter('2026-11-23T08:00:00Z', 'hourly', null, advanceNextRun, now);
    assert.strictEqual(next, '2026-11-23T09:00:00.000Z');
});

test('an hourly item three days behind lands on the first hour still ahead, not one hour on', () => {
    const now = new Date('2026-11-23T08:20:00Z');
    const next = nextRunAfter('2026-11-20T08:00:00Z', 'hourly', null, advanceNextRun, now);
    assert.strictEqual(next, '2026-11-23T09:00:00.000Z');
    // One step would have been 2026-11-20T09:00, due again on the next tick, and so on seventy times.
    assert.notStrictEqual(next, advanceNextRun('2026-11-20T08:00:00Z', 'hourly'));
});

test('a daily item keeps its time of day across the skipped days', () => {
    const now = new Date('2026-11-23T12:00:00Z');
    const next = /** @type {string} */ (nextRunAfter('2026-11-19T07:30:00Z', 'daily', null, advanceNextRun, now));
    assert.ok(new Date(next).getTime() > now.getTime(), 'it lies ahead');
    assert.ok(new Date(next).getTime() - now.getTime() <= DAY, 'and is the first such moment');
    assert.strictEqual((new Date(next).getTime() - new Date('2026-11-19T07:30:00Z').getTime()) % DAY, 0, 'whole days from the original moment');
});

test('a days-of-week item skips to the next allowed day ahead', () => {
    const now = new Date('2026-11-23T12:00:00Z'); // a Monday
    const next = /** @type {string} */ (nextRunAfter('2026-11-02T09:00:00Z', null, ['mon', 'thu'], advanceNextRun, now));
    const at = new Date(next);
    assert.ok(at.getTime() > now.getTime());
    assert.ok(at.getTime() - now.getTime() <= 4 * DAY, 'the coming Thursday, not a Thursday weeks back');
    assert.ok(['mon', 'thu'].includes(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][at.getDay()]));
});

test('a moment exactly at "now" counts as passed: the item never lands on the moment it just ran', () => {
    const now = new Date('2026-11-23T09:00:00Z');
    assert.strictEqual(nextRunAfter('2026-11-23T08:00:00Z', 'hourly', null, advanceNextRun, now), '2026-11-23T10:00:00.000Z');
});

test('a one-off has no next moment', () => {
    assert.strictEqual(nextRunAfter('2026-11-20T08:00:00Z', null, null, advanceNextRun, new Date('2026-11-23T08:00:00Z')), null);
    assert.strictEqual(nextRunAfter('2026-11-20T08:00:00Z', 'never-heard-of', [], advanceNextRun, new Date('2026-11-23T08:00:00Z')), null);
});

test('the catch-up is bounded: an advance that never gets ahead ends after the step limit', () => {
    let calls = 0;
    const stuck = () => { calls += 1; return '2000-01-01T00:00:00.000Z'; };
    const next = nextRunAfter('1999-12-31T00:00:00Z', 'hourly', null, stuck, new Date('2026-11-23T08:00:00Z'));
    assert.strictEqual(next, '2000-01-01T00:00:00.000Z', 'still behind: the next tick goes on from here');
    assert.strictEqual(calls, MAX_CATCH_UP_STEPS + 1);
});

test('an unreadable date from the advance ends the loop instead of spinning', () => {
    let calls = 0;
    const broken = () => { calls += 1; return 'not a date'; };
    assert.strictEqual(nextRunAfter('2026-11-20T08:00:00Z', 'hourly', null, broken, new Date()), 'not a date');
    assert.strictEqual(calls, 1);
});
