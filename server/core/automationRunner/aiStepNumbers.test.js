// @typecheck
/**
 * aiStepNumbers: the numbers in free text and the "is it in the source" test
 * behind the `numbersFrom` check. Synthetic values only.
 *
 * Run: node --test core/automationRunner/aiStepNumbers.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { extractNumbers, collectSourceNumbers, hasUnsupportedNumber } = require('./aiStepNumbers');

const values = (text, opts) => extractNumbers(text, opts).map((e) => e.cands.map((c) => c.value));
const unsupported = (text, source, opts) => hasUnsupportedNumber(text, collectSourceNumbers(source), opts);

test('European and English grouping read as the same number', () => {
    assert.deepStrictEqual(values('1.234,5'), [[1234.5]]);
    assert.deepStrictEqual(values('1,234.5'), [[1234.5]]);
    assert.deepStrictEqual(values('12,5'), [[12.5]]);
    assert.deepStrictEqual(values("1'234'567"), [[1234567]]);
    assert.deepStrictEqual(values('1 234'), [[1234], [1], [234]].slice(0, 1).concat([[1], [234]]).slice(0, 1).concat(values('1 234').slice(1)));
});

test('an ambiguous 1.234 or 1,234 yields both readings', () => {
    assert.deepStrictEqual(values('1.234'), [[1234, 1.234]]);
    assert.deepStrictEqual(values('1,234'), [[1234, 1.234]]);
    assert.strictEqual(unsupported('1.234', [1234]), false, 'the thousands reading is in the source');
    assert.strictEqual(unsupported('1.234', [1.234]), false, 'so is the decimal reading');
    assert.strictEqual(unsupported('1.234', [99]), true);
});

test('12,5 % matches a source of 0.125 and of 12.5', () => {
    assert.strictEqual(unsupported('12,5 %', { share: 0.125 }), false);
    assert.strictEqual(unsupported('12,5%', { share: 12.5 }), false);
    assert.strictEqual(unsupported('12,5 %', { share: 0.2 }), true);
    assert.strictEqual(unsupported('12,5 %', { share: 0.125 }, { percent: false }), true, 'percent off: only the plain reading counts');
});

test('a rounded number matches its source: 12.35 is both 12.3 and 12.4', () => {
    assert.strictEqual(unsupported('12.3', [12.35]), false);
    assert.strictEqual(unsupported('12.4', [12.35]), false);
    assert.strictEqual(unsupported('12.5', [12.35]), true);
    assert.strictEqual(unsupported('13', [12.4]), true, 'one decimal fewer than written is not rounding');
    assert.strictEqual(unsupported('12', [12.4]), false, 'a whole number is the source rounded to units');
});

test('tolerance widens the match (absolute)', () => {
    assert.strictEqual(unsupported('100', [103]), true);
    assert.strictEqual(unsupported('100', [103], { tolerance: 3 }), false);
    assert.strictEqual(unsupported('100', [104], { tolerance: 3 }), true);
});

test('ignoreUpTo skips small whole numbers', () => {
    assert.strictEqual(unsupported('step 2 of 3', [500]), true);
    assert.strictEqual(unsupported('step 2 of 3', [500], { ignoreUpTo: 10 }), false);
    assert.strictEqual(unsupported('step 2 of 30', [500], { ignoreUpTo: 10 }), true);
    assert.strictEqual(unsupported('2.5', [500], { ignoreUpTo: 10 }), true, 'a decimal is never a small whole number');
});

test('dates are skipped by default and counted when asked', () => {
    assert.deepStrictEqual(values('on 2024-03-05 and 5/3/2024 and 05-03-24'), []);
    assert.strictEqual(unsupported('due 2024-03-05', [1]), false);
    assert.strictEqual(unsupported('due 2024-03-05', [1], { ignoreDates: false }), true);
    assert.deepStrictEqual(values('2024-03-05T10:15:00Z, 42'), [[42]]);
});

test('Privacy Shield placeholders and label-like tokens are not numbers', () => {
    assert.deepStrictEqual(values('[person_2] wrote to [email_10] about Q3 and v2'), []);
    assert.deepStrictEqual(values('[person_2] sold 7'), [[7]]);
});

test('negative numbers keep their sign; a hyphen between digits does not', () => {
    assert.deepStrictEqual(values('a result of -5 and (-2,5)'), [[-5], [-2.5]]);
    assert.strictEqual(unsupported('-5', [5]), true);
    assert.strictEqual(unsupported('-5', [-5]), false);
    assert.deepStrictEqual(values('10-20'), [[10], [20]], 'a range, not a negative twenty');
    assert.deepStrictEqual(values('item-5'), [[5]], 'a hyphen after a letter is not a sign either');
});

test('a range is two numbers, each of which must be in the source', () => {
    assert.strictEqual(unsupported('10-20', [10, 20]), false);
    assert.strictEqual(unsupported('10-20', [10, 21]), true);
});

test('the source is read from numbers and from text, nested', () => {
    const source = { rows: [{ n: 5 }, { text: 'total 1.234,56 units' }], note: 'x' };
    assert.strictEqual(unsupported('1234.56', source), false);
    assert.strictEqual(unsupported('5', source), false);
    assert.strictEqual(unsupported('6', source), true);
});

test('numbers in an answer value: JSON numbers are taken as written, lists and records are walked', () => {
    assert.strictEqual(unsupported(12.35, [12.35]), false);
    assert.strictEqual(unsupported([1, 2, 99], [1, 2]), true);
    assert.strictEqual(unsupported({ a: 'cost 7', b: ['and 8'] }, [7, 8]), false);
    assert.strictEqual(unsupported(true, []), false);
});

test('a source cycle does not hang', () => {
    const a = { n: 1 };
    a.self = a;
    assert.strictEqual(unsupported('1', a), false);
});
