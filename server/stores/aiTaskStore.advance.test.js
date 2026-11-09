// @typecheck
/**
 * aiTaskStore.advanceNextRun (also the Cowork schedule's): the next run of a
 * calendar interval.
 *
 * Monthly, quarterly and yearly used a bare setMonth / setFullYear, which
 * overflows on a day the target month does not have: 31 Jan + 1 month became
 * 3 March (February skipped, and the schedule ran on the 3rd from then on),
 * 30 Nov + 3 months became 2 March, 29 Feb + 1 year became 1 March.
 *
 * Run: cd server && node --test stores/aiTaskStore.advance.test.js
 */

'use strict';

process.env.TZ = 'UTC';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { recordDb } = require('../testUtils/routeHarness');

recordDb(); // the store initialises its schema when loaded; nothing here reaches a database
const { advanceNextRun } = require('./aiTaskStore');

test('monthly on a day the next month lacks lands on that month\'s last day', () => {
    assert.equal(advanceNextRun('2026-01-31T09:00:00.000Z', 'monthly'), '2026-02-28T09:00:00.000Z');
    assert.equal(advanceNextRun('2028-01-31T09:00:00.000Z', 'monthly'), '2028-02-29T09:00:00.000Z');
    assert.equal(advanceNextRun('2026-03-31T09:00:00.000Z', 'monthly'), '2026-04-30T09:00:00.000Z');
});

test('quarterly and yearly clamp the same way', () => {
    assert.equal(advanceNextRun('2026-11-30T09:00:00.000Z', 'quarterly'), '2027-02-28T09:00:00.000Z');
    assert.equal(advanceNextRun('2028-02-29T09:00:00.000Z', 'yearly'), '2029-02-28T09:00:00.000Z');
});

test('an ordinary day rolls as before, across a year end too', () => {
    assert.equal(advanceNextRun('2026-01-15T09:30:00.000Z', 'monthly'), '2026-02-15T09:30:00.000Z');
    assert.equal(advanceNextRun('2026-12-15T09:30:00.000Z', 'monthly'), '2027-01-15T09:30:00.000Z');
    assert.equal(advanceNextRun('2026-11-15T09:30:00.000Z', 'quarterly'), '2027-02-15T09:30:00.000Z');
    assert.equal(advanceNextRun('2026-06-01T00:00:00.000Z', 'yearly'), '2027-06-01T00:00:00.000Z');
    assert.equal(advanceNextRun('2026-01-31T09:00:00.000Z', 'daily'), '2026-02-01T09:00:00.000Z');
    assert.equal(advanceNextRun('2026-01-31T09:00:00.000Z', 'nonsense'), null);
});
