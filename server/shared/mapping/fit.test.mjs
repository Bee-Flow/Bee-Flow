/**
 * applyTake, castAs and fit on every shape. REGRESSION (confirmed bug "The
 * list transforms behave wrongly when a value turns out to be a single value
 * or an object at run time"): join of a single value gave '', first/last
 * gave null and count the length of the text. A take now means the same on
 * any shape: first/last of one value is that value, count of one is 1, all
 * of one value is a list of one, and a record as text is readable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyTake, castAs, fit } from './fit.mjs';
import { walkMany } from './walk.mjs';
import * as parse from '../expr/parse.mjs';

const many = walkMany([{ e: 'a@b.nl' }, { e: 'c@d.nl' }, {}], ['e']);

test('a single value where a list was expected', () => {
    assert.deepStrictEqual(fit('a@b.nl', { take: 'first', as: 'native' }).value, 'a@b.nl');
    assert.deepStrictEqual(fit('a@b.nl', { take: 'last', as: 'native' }).value, 'a@b.nl');
    assert.deepStrictEqual(fit('a@b.nl', { take: 'count', as: 'native' }).value, 1);
    assert.deepStrictEqual(fit('a@b.nl', { take: 'all', as: 'text', join: 'comma' }).value, 'a@b.nl');
    assert.deepStrictEqual(fit('a@b.nl', { take: 'all', as: 'list' }).value, ['a@b.nl']);
    assert.deepStrictEqual(fit({ naam: 'Jan' }, { take: 'all', as: 'text' }).value, 'naam: Jan');
    assert.deepStrictEqual(fit({ naam: 'Jan' }, { take: 'first', as: 'native' }).value, { naam: 'Jan' });
});

test('many values where one was expected: the first, and a warning', () => {
    assert.deepStrictEqual(fit(many, { take: 'one', as: 'native' }), { value: 'a@b.nl', warnings: [{ code: 'many_for_one', count: 2 }] });
    assert.deepStrictEqual(fit(['1', '2'], { take: 'one', as: 'number' }, { parse }), { value: 1, warnings: [{ code: 'many_for_one', count: 2 }] });
    assert.deepStrictEqual(fit(['1'], { take: 'one', as: 'number' }, { parse }), { value: 1, warnings: [] }, 'a list of one is one');
});

test('all drops the holes and says how many; count agrees with it', () => {
    const all = fit(many, { take: 'all', as: 'list' });
    assert.deepStrictEqual(all, { value: ['a@b.nl', 'c@d.nl'], warnings: [{ code: 'holes_dropped', count: 1 }] });
    assert.equal(fit(many, { take: 'count', as: 'native' }).value, all.value.length);
});

test('nothing there: empty text, empty list, else no value; always a warning', () => {
    assert.deepStrictEqual(fit(undefined, { take: 'one', as: 'text' }), { value: '', warnings: [{ code: 'missing' }] });
    assert.deepStrictEqual(fit(undefined, { take: 'all', as: 'list' }), { value: [], warnings: [{ code: 'missing' }] });
    assert.deepStrictEqual(fit(undefined, { take: 'one', as: 'number' }), { value: undefined, warnings: [{ code: 'missing' }] });
    assert.deepStrictEqual(fit(undefined, { take: 'count', as: 'native' }), { value: 0, warnings: [] });
    assert.deepStrictEqual(fit([], { take: 'first', as: 'native' }), { value: undefined, warnings: [{ code: 'missing' }] });
});

test('numbers, dates and yes/no, with and without the injected readers', () => {
    assert.equal(castAs('€ 1.554,25', 'number', { parse }).value, 1554.25);
    assert.equal(castAs('1.234', 'number', { parse }).value, 1.234, 'what Number() reads keeps its reading');
    assert.equal(castAs('12,5', 'number').value, undefined, 'without parse only Number() reads');
    assert.deepStrictEqual(castAs('abc', 'number', { parse }).warnings, [{ code: 'parse_failed', as: 'number' }]);
    assert.equal(castAs(Infinity, 'number').value, undefined);
    assert.equal(castAs('2026-10-01', 'date', { parse }).value, '2026-10-01');
    assert.equal(castAs('2026-10-01', 'date').value, '2026-10-01', 'ISO text reads without parse too');
    assert.equal(castAs('Tue, 01 Sep 2026 10:00:00 +0200', 'date', { parse }).value, '2026-09-01T08:00:00.000Z');
    assert.equal(castAs(1756720800, 'date', { parse }).value, '2025-09-01T10:00:00.000Z');
    assert.equal(castAs('2026-13-45', 'date', { parse }).value, undefined);
    for (const [v, want] of [['ja', true], ['Nee', false], ['TRUE', true], [0, false], [3, true], [true, true]]) {
        assert.equal(castAs(v, 'yesno').value, want, String(v));
    }
    assert.deepStrictEqual(castAs('misschien', 'yesno').warnings, [{ code: 'parse_failed', as: 'yesno' }]);
    assert.deepStrictEqual(castAs(null, 'number'), { value: undefined, missing: true, warnings: [] });
});

test('applyTake leaves casting to castAs', () => {
    assert.deepStrictEqual(applyTake([1, 2], 'all', 'native'), { value: [1, 2], warnings: [] });
    assert.deepStrictEqual(applyTake([1, 2], 'one', 'native'), { value: [1, 2], warnings: [] }, 'a list picked as a whole is one value');
    assert.deepStrictEqual(applyTake(many, 'last', 'native'), { value: 'c@d.nl', warnings: [] });
});
