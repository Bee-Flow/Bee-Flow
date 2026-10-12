// @typecheck
'use strict';
/**
 * Run: node --test automation/patterns/effort.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { estimateMinutes, minutesPerMonth, verbMinutes } = require('./effort');

const MIN = 60_000;

test('measured: median span as a range, capped at 30 minutes', () => {
    assert.deepStrictEqual(estimateMinutes({ verbs: ['a_get', 'b_append'], spansMs: [8 * MIN, 10 * MIN, 12 * MIN] }), { range: [8, 13], basis: 'measured' });
    assert.deepStrictEqual(estimateMinutes({ spansMs: [3 * 3_600_000, 4 * 3_600_000, 5 * 3_600_000] }), { range: [23, 38], basis: 'measured' });
});

test('too few or too short spans fall back to the heuristic', () => {
    assert.strictEqual(estimateMinutes({ verbs: ['mail.sent'], spansMs: [5 * MIN, 6 * MIN] }).basis, 'heuristic');
    assert.strictEqual(estimateMinutes({ verbs: ['mail.sent'], spansMs: [1000, 2000, 3000] }).basis, 'heuristic');
});

test('heuristic sums per-verb constants and is always a range', () => {
    assert.deepStrictEqual(estimateMinutes({ verbs: ['mail.received', 'gmail_search', 'sheets_append_rows'] }), { range: [3, 6], basis: 'heuristic' });
    assert.deepStrictEqual(estimateMinutes({ verbs: [] }), { range: [1, 2], basis: 'heuristic' });
    assert.deepStrictEqual(estimateMinutes({ verbs: ['meeting.held'] }), { range: [1, 2], basis: 'heuristic' });
    const r = estimateMinutes({ verbs: ['x'] }).range;
    assert.ok(r[1] > r[0]);
});

test('verbMinutes by keyword', () => {
    assert.deepStrictEqual(verbMinutes('gmail_send'), [2, 4]);
    assert.deepStrictEqual(verbMinutes('drive_list_files'), [0.5, 1]);
    assert.deepStrictEqual(verbMinutes('unknown_thing'), [1, 2]);
});

test('minutesPerMonth scales the range', () => {
    assert.deepStrictEqual(minutesPerMonth({ range: [3, 6] }, 4.3), [13, 26]);
    assert.deepStrictEqual(minutesPerMonth({ range: [3, 6] }, NaN), [0, 0]);
});
