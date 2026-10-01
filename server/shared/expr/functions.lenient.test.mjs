/**
 * The confirmed scenarios behind the M1 changes to the whitelist, each the way
 * a user meets it. Run from server/:
 *   node --test shared/expr/functions.lenient.test.mjs
 *
 *   - number() and formatNumber() dropped Dutch and euro amounts to null / ''.
 *   - formatDate dropped a Gmail Date header and a timestamp written as text.
 *     (A NUMBER stays milliseconds and the day stays the UTC day: changing
 *     either would move dates that stored expressions already produce.)
 *   - first/last/join gave null / '' when a list turned out to be ONE value at
 *     run time, and join/toStr printed a record as "[object Object]".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FUNCTIONS } from './functions.mjs';
import { evaluate } from './engine.mjs';

const { number, formatNumber, formatDate, sum, avg, first, join, toStr, count } = FUNCTIONS;

test('a Dutch amount from a spreadsheet or an invoice is a number', () => {
    assert.equal(number('12,5'), 12.5);
    assert.equal(number('€ 1.554,25'), 1554.25);
    assert.equal(formatNumber('12,5', 'amount'), '€ 12,50');
    assert.equal(formatNumber('€ 1.554,25', 'amount'), '€ 1.554,25');
    assert.equal(number('€ 1.554'), 1554, 'a euro amount without cents is not read as 1.554');
    assert.equal(formatNumber('€ 1.554', 'amount'), '€ 1.554', 'was € 1,55: a thousandth of the amount');
    assert.equal(sum(['1,5', '2']), 3.5, 'the Dutch value is no longer dropped from the total');
    assert.equal(avg(['1,5', '2,5']), 2);
});

test('a value Number() could read keeps its result', () => {
    assert.equal(number('1.234'), 1.234, 'a dot-decimal string is not reread as thousands');
    assert.equal(number('42'), 42);
    assert.equal(number(' 7 '), 7);
    assert.equal(number('nope'), null);
    assert.equal(formatNumber('1234.5'), '1.234,5');
});

test('formatDate reads a Gmail Date header and a timestamp written as text', () => {
    assert.equal(formatDate('Tue, 01 Sep 2026 10:00:00 +0200', 'D MMMM YYYY', 'nl'), '1 september 2026');
    assert.equal(formatDate('1756720800', 'D MMMM YYYY', 'nl'), '1 september 2025', 'ten digits of text: seconds (was empty)');
    assert.equal(formatDate('1756720800000', 'YYYY-MM-DD'), '2025-09-01', 'thirteen digits of text: milliseconds (was empty)');
});

// Stored expressions keep the dates they gave before M1. These two readings
// would have changed a result that was already a date, so the expression
// functions do not take them (only the new pick readers do).
test('a NUMBER is still an epoch in milliseconds, however small', () => {
    assert.equal(formatDate(1757376000000, 'D MMMM YYYY', 'nl'), '9 september 2025');
    // A millisecond birth date from 1972 stays in 1972 (read as seconds it
    // would be the year 3968).
    assert.equal(formatDate(63072000000, 'YYYY-MM-DD'), '1972-01-01');
    assert.equal(formatDate(-100000000000, 'YYYY-MM-DD'), '1966-10-31');
    assert.equal(formatDate(1756720800, 'YYYY-MM-DD'), '1970-01-21', 'as it was before M1');
});

test('formatDate renders the UTC day, day-only formats included, as it always did', () => {
    assert.equal(formatDate('2026-09-01T00:30:00+02:00', 'YYYY-MM-DD'), '2026-08-31');
    assert.equal(formatDate('2026-09-01T00:30:00+02:00', 'D MMMM YYYY', 'nl'), '31 augustus 2026');
    assert.equal(formatDate('2026-09-01T00:30:00+02:00', 'D MMMM YYYY HH:mm', 'nl'), '31 augustus 2026 22:30');
    assert.equal(formatDate('2026-09-01T00:30:00Z', 'D MMMM YYYY', 'nl'), '1 september 2026');
});

test('a single value where a list was picked is a list of one', () => {
    const scope = { steps: { s: { output: { to: 'a@b.nl', rows: [{ name: 'Stoel', qty: 2 }, { name: 'Tafel' }] } } } };
    assert.equal(evaluate('join(steps.s.output.to, ", ")', scope), 'a@b.nl');
    assert.equal(evaluate('first(steps.s.output.to)', scope), 'a@b.nl');
    assert.equal(evaluate('last(steps.s.output.to)', scope), 'a@b.nl');
    assert.equal(count('a@b.nl'), 6, 'count is unchanged on purpose: a text still counts its characters');
    assert.equal(first(null), null);
    assert.equal(first(undefined), null);
    assert.equal(first([]), null);
    assert.equal(join(null, ', '), '');
});

test('a record as text reads as "Key: value", never "[object Object]"', () => {
    assert.equal(toStr({ name: 'Stoel', qty: 2 }), 'Name: Stoel, Qty: 2');
    assert.equal(join([{ name: 'Stoel', qty: 2 }, { name: 'Tafel' }], '\n'), 'Name: Stoel, Qty: 2\nName: Tafel');
    assert.equal(join({ name: 'Stoel' }, ', '), 'Name: Stoel');
    assert.equal(join(['a', ['b', 'c'], null, 3], '|'), 'a|b,c||3', 'scalars and nested lists join as they always did');
    assert.equal(toStr(['a', 'b']), 'a,b');
});
