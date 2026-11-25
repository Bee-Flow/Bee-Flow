// Working days in the expression language (./workdays.mjs): Monday to Friday, UTC, null for what is no date.
// Run: cd server && node --test shared/expr/workdays.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addWorkdays, workdaysBetween } from './workdays.mjs';
import { EXPR_FUNCTIONS, EXPR_FUNCTION_NAMES } from './functions.mjs';
import { evaluate } from './engine.mjs';

// 2026-11-20 is a Friday, 2026-11-23 a Monday.
test('workdaysBetween counts the working days after the first day up to the second', () => {
    assert.equal(workdaysBetween('2026-11-20', '2026-11-20'), 0, 'the same day');
    assert.equal(workdaysBetween('2026-11-20T09:00:00Z', '2026-11-23T08:00:00Z'), 1, 'Friday to Monday: the weekend does not count');
    assert.equal(workdaysBetween('2026-11-20', '2026-11-24'), 2);
    assert.equal(workdaysBetween('2026-11-21', '2026-11-23'), 1, 'Saturday to Monday');
    assert.equal(workdaysBetween('2026-11-21', '2026-11-22'), 0, 'Saturday to Sunday');
    assert.equal(workdaysBetween('2026-11-23', '2026-12-07'), 10, 'two whole weeks');
    assert.equal(workdaysBetween('2026-11-24', '2026-11-20'), -2, 'backwards is negative');
    assert.equal(workdaysBetween('1969-12-26', '1970-01-05'), 6, 'before 1970 as well');
});

test('workdaysBetween agrees with counting day by day over a long span', () => {
    const start = Date.UTC(2026, 0, 1);
    for (let span = 0; span < 40; span++) {
        let expected = 0;
        for (let d = 1; d <= span; d++) { const w = new Date(start + d * 86_400_000).getUTCDay(); if (w !== 0 && w !== 6) expected += 1; }
        assert.equal(workdaysBetween(new Date(start).toISOString(), new Date(start + span * 86_400_000).toISOString()), expected, `span ${span}`);
    }
});

test('addWorkdays moves over weekends and keeps the time of day', () => {
    assert.equal(addWorkdays('2026-11-20T14:30:00Z', 1), '2026-11-23T14:30:00.000Z', 'Friday + 1 is Monday');
    assert.equal(addWorkdays('2026-11-20', 2), '2026-11-24T00:00:00.000Z');
    assert.equal(addWorkdays('2026-11-21', 1), '2026-11-23T00:00:00.000Z', 'Saturday + 1 is Monday');
    assert.equal(addWorkdays('2026-11-21', -1), '2026-11-20T00:00:00.000Z', 'Saturday - 1 is Friday');
    assert.equal(addWorkdays('2026-11-23', 5), '2026-11-30T00:00:00.000Z', 'five working days are a week');
    assert.equal(addWorkdays('2026-11-23', 6), '2026-12-01T00:00:00.000Z');
    assert.equal(addWorkdays('2026-11-23', -6), '2026-11-13T00:00:00.000Z');
    assert.equal(addWorkdays('2026-11-21', 0), '2026-11-21T00:00:00.000Z', 'zero leaves a weekend day as it is');
    assert.equal(addWorkdays('2026-11-23', 1.9), '2026-11-24T00:00:00.000Z', 'a fraction is cut off');
    assert.equal(addWorkdays('2026-11-23', '3'), '2026-11-26T00:00:00.000Z', 'a number as text');
});

test('addWorkdays and workdaysBetween undo each other from a working day', () => {
    for (let n = -12; n <= 12; n++) {
        const later = addWorkdays('2026-11-25T10:00:00Z', n);
        assert.equal(workdaysBetween('2026-11-25T10:00:00Z', later), n, `n = ${n}`);
    }
});

test('what is no date or no number gives null, never an error', () => {
    assert.equal(workdaysBetween('not a date', '2026-11-20'), null);
    assert.equal(workdaysBetween('2026-11-20', null), null);
    assert.equal(addWorkdays(undefined, 1), null);
    assert.equal(addWorkdays('2026-11-20', 'two'), null);
    assert.equal(addWorkdays('2026-11-20', null), null);
    assert.equal(addWorkdays('2026-11-20', 1e9), null, 'no calendar question');
});

test('both are functions of the expression language, with their help text', () => {
    assert.ok(EXPR_FUNCTION_NAMES.includes('workdaysBetween') && EXPR_FUNCTION_NAMES.includes('addWorkdays'));
    for (const name of ['workdaysBetween', 'addWorkdays']) {
        assert.match(EXPR_FUNCTIONS.find((f) => f.name === name)?.description ?? '', /Public holidays count as working days/);
    }
    assert.equal(evaluate('workdaysBetween(mail.receivedAt, mail.answeredAt) <= 2', { mail: { receivedAt: '2026-11-20T16:00:00Z', answeredAt: '2026-11-24T09:00:00Z' } }), true);
    assert.equal(evaluate('addWorkdays(d, 2)', { d: '2026-11-20' }), '2026-11-24T00:00:00.000Z');
});
