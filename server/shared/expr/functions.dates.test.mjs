import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FUNCTIONS } from './functions.mjs';
import { evaluate, parseExpr as parse } from './engine.mjs';

const { dateAdd, dateDiff } = FUNCTIONS;

test('dateDiff accepts plural units and does not fall back to days', () => {
    assert.equal(dateDiff('2026-10-25T00:00:00+02:00', '2026-10-26T00:00:00+01:00', 'hours'), -25);
    assert.equal(dateDiff('2026-10-27', '2026-10-25', 'Days'), 2);
    assert.equal(dateDiff('2026-10-27', '2026-10-13', 'weeks'), 2);
});

test('an unknown unit is an error, not days', () => {
    assert.throws(() => dateAdd('2026-01-01', 1, 'dayz'), /unknown unit/);
    assert.throws(() => dateDiff('2026-01-01', '2026-01-02', undefined), /unknown unit/);
    assert.throws(() => parse("dateAdd(x, 1, 'fortnights')"), /unknown unit/);
    assert.doesNotThrow(() => parse("dateAdd(x, 1, 'months')"));
});

test('dateAdd months and years are calendar steps that clamp to month end', () => {
    assert.equal(dateAdd('2026-01-31', 1, 'months'), '2026-02-28T00:00:00.000Z');
    assert.equal(dateAdd('2028-01-31', 1, 'month'), '2028-02-29T00:00:00.000Z');
    assert.equal(dateAdd('2028-02-29', 1, 'years'), '2029-02-28T00:00:00.000Z');
    assert.equal(dateAdd('2026-03-31', -1, 'month'), '2026-02-28T00:00:00.000Z');
    assert.equal(dateAdd('2026-11-15T10:30:00Z', 3, 'months'), '2027-02-15T10:30:00.000Z');
    assert.equal(dateAdd('2026-01-01', 2, 'days'), '2026-01-03T00:00:00.000Z');
});

test('dateDiff truncates toward zero', () => {
    assert.equal(dateDiff('2026-01-01T00:00:00Z', '2026-01-01T01:30:00Z', 'hour'), -1);
    assert.equal(dateDiff('2026-01-01T01:30:00Z', '2026-01-01T00:00:00Z', 'hour'), 1);
    assert.equal(Object.is(dateDiff('2026-01-01T00:10:00Z', '2026-01-01T00:00:00Z', 'hour'), 0), true);
});

test('dateDiff counts whole calendar months and years', () => {
    assert.equal(dateDiff('2026-03-31', '2026-01-31', 'months'), 2);
    assert.equal(dateDiff('2026-03-30', '2026-01-31', 'months'), 1);
    assert.equal(dateDiff('2026-01-31', '2026-03-30', 'months'), -1);
    assert.equal(dateDiff('2028-02-28', '2026-02-28', 'years'), 2);
    assert.equal(dateDiff('2028-02-27', '2026-02-28', 'years'), 1);
});

test('through the engine', () => {
    assert.equal(evaluate("dateDiff(a, b, 'hours')", { a: '2026-10-26T00:00:00Z', b: '2026-10-25T00:00:00Z' }), 24);
});

test('impossible ISO dates read as not a date instead of rolling over', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '2026-04-31', '2026-02-29', '2026-01-01T24:00:00', '2026-01-01T10:61', '2026-01-01T10:00:60']) {
        assert.equal(dateAdd(bad, 0, 'day'), null, bad);
        assert.equal(dateDiff(bad, '2026-01-01', 'day'), null, bad);
        assert.equal(FUNCTIONS.formatDate(bad, 'YYYY-MM-DD'), '', bad);
    }
    assert.equal(dateAdd('2028-02-29', 0, 'day'), '2028-02-29T00:00:00.000Z');
    assert.equal(dateAdd('2026-12-31T23:59:59', 0, 'day'), '2026-12-31T23:59:59.000Z');
});
