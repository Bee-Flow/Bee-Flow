'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveEffectiveCostLimit, toCostLimit, isValidCostLimit } = require('./costLimit.mts');

test('own limit wins over every group limit', () => {
    assert.equal(resolveEffectiveCostLimit({ userLimit: 5, groupLimits: [50, 100] }), 5);
});

test('own limit may be higher than the group limit', () => {
    assert.equal(resolveEffectiveCostLimit({ userLimit: 80, groupLimits: [10] }), 80);
});

test('the highest of several group limits applies', () => {
    assert.equal(resolveEffectiveCostLimit({ userLimit: null, groupLimits: [10, 40, 25] }), 40);
});

test('a group without a limit is ignored', () => {
    assert.equal(resolveEffectiveCostLimit({ userLimit: null, groupLimits: [null, 15, undefined] }), 15);
});

test('no limits at all gives null', () => {
    assert.equal(resolveEffectiveCostLimit({ userLimit: null, groupLimits: [] }), null);
    assert.equal(resolveEffectiveCostLimit({ userLimit: undefined, groupLimits: [null] }), null);
});

test('zero, negative and non-finite values count as no limit', () => {
    assert.equal(resolveEffectiveCostLimit({ userLimit: 0, groupLimits: [-3, NaN, Infinity, 7] }), 7);
    assert.equal(toCostLimit(0), null);
    assert.equal(toCostLimit('abc'), null);
    assert.equal(toCostLimit('12.5'), 12.5);
    assert.equal(toCostLimit(''), null);
});

test('isValidCostLimit accepts only positive finite numbers', () => {
    assert.equal(isValidCostLimit(0.01), true);
    for (const bad of [0, -1, NaN, Infinity, '5', null, undefined]) assert.equal(isValidCostLimit(bad), false);
});
