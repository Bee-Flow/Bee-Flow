'use strict';

/**
 * The list mode a Date & time step implies when it was saved with a whole
 * column in "Input date" and no `arrayRef` (BFSF-375).
 *
 * Run: cd server && node --test automation/datetimeListMode.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { splitWildcardPath, impliedListMode } = require('./datetimeListMode');

test('splitWildcardPath matches the builder copy on every shape it handles', () => {
    assert.deepEqual(splitWildcardPath('steps.s.output.results[*].updated'),
        { arrayRef: 'steps.s.output.results', itemPath: 'item.updated' });
    assert.deepEqual(splitWildcardPath('steps.s.output.rows[*].meta.createdAt'),
        { arrayRef: 'steps.s.output.rows', itemPath: 'item.meta.createdAt' });
    assert.deepEqual(splitWildcardPath('steps.s.output.dates[*]'),
        { arrayRef: 'steps.s.output.dates', itemPath: 'item' });
    assert.equal(splitWildcardPath('steps.s.output.when'), null, 'no [*] is a single date');
    assert.equal(splitWildcardPath('[*].updated'), null, 'no list before the [*]');
    assert.equal(splitWildcardPath('steps.s.output.a[*].b[*].c'), null, 'a list of lists');
    assert.equal(splitWildcardPath(''), null);
    assert.equal(splitWildcardPath(undefined), null);
});

test('a column without arrayRef implies list mode over its list', () => {
    assert.deepEqual(
        impliedListMode({ type: 'datetime', op: 'extract', part: 'day', input: 'steps.s.output.results[*].updated' }),
        { arrayRef: 'steps.s.output.results', input: 'item.updated' },
    );
    assert.deepEqual(
        impliedListMode({ type: 'datetime', op: 'extract', input: 'steps.s.output.results[*].updated', arrayRef: null }),
        { arrayRef: 'steps.s.output.results', input: 'item.updated' },
        'null is "no list mode", like an absent key',
    );
});

test('a second column of the same list moves along; anything else stays', () => {
    assert.deepEqual(
        impliedListMode({
            type: 'datetime', op: 'diff',
            input: 'steps.s.output.results[*].created', input2: 'steps.s.output.results[*].updated',
        }),
        { arrayRef: 'steps.s.output.results', input: 'item.created', input2: 'item.updated' },
    );
    assert.deepEqual(
        impliedListMode({ type: 'datetime', op: 'diff', input: 'steps.s.output.results[*].created', input2: 'trigger.output.when' }),
        { arrayRef: 'steps.s.output.results', input: 'item.created' },
    );
    assert.deepEqual(
        impliedListMode({
            type: 'datetime', op: 'diff',
            input: 'steps.s.output.results[*].created', input2: 'steps.t.output.results[*].updated',
        }),
        { arrayRef: 'steps.s.output.results', input: 'item.created' },
        'a column of ANOTHER list is not the same row',
    );
});

test('nothing is implied for a single date, explicit list mode or a list of lists', () => {
    assert.equal(impliedListMode({ type: 'datetime', op: 'parse', input: 'trigger.output.when' }), null);
    assert.equal(impliedListMode({ type: 'datetime', op: 'parse', input: '2026-07-01' }), null);
    assert.equal(impliedListMode({
        type: 'datetime', op: 'extract', arrayRef: 'steps.s.output.results', input: 'steps.s.output.results[*].updated',
    }), null);
    assert.equal(impliedListMode({ type: 'datetime', op: 'extract', arrayRef: '', input: 'steps.s.output.results[*].updated' }), null);
    assert.equal(impliedListMode({ type: 'datetime', op: 'extract', input: 'steps.s.output.a[*].b[*].c' }), null);
    assert.equal(impliedListMode(null), null);
});

test('`now` reads no input date, so a stale column in its input implies nothing', () => {
    assert.equal(impliedListMode({ type: 'datetime', op: 'now', input: 'steps.s.output.results[*].updated' }), null);
});
