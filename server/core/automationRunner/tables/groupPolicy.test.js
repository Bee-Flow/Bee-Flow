// @typecheck
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { minGroupFloorFor, effectiveMinN, policyKey } = require('./groupPolicy');

const limits = { minGroupFloor: 10 };
const asking = (value) => ({ limits, getConfig: async (key) => { assert.equal(key, 'org_org1_automation_table_policy'); return value; } });

test('policyKey is per organisation', () => {
    assert.equal(policyKey('org1'), 'org_org1_automation_table_policy');
});

test('the environment floor applies without an organisation or without a stored value', async () => {
    assert.equal(await minGroupFloorFor(null, { limits }), 10);
    assert.equal(await minGroupFloorFor('org1', asking(null)), 10);
    assert.equal(await minGroupFloorFor('org1', asking(undefined)), 10);
});

test('a higher organisation value wins; a lower one is ignored', async () => {
    assert.equal(await minGroupFloorFor('org1', asking({ minGroupSize: 25 })), 25);
    assert.equal(await minGroupFloorFor('org1', asking({ minGroupSize: 3 })), 10);
    assert.equal(await minGroupFloorFor('org1', asking('{"minGroupSize": 40}')), 40);
    assert.equal(await minGroupFloorFor('org1', asking({ minGroupSize: 12.9 })), 12);
});

test('an unreadable value falls back to the environment floor', async () => {
    assert.equal(await minGroupFloorFor('org1', asking('{not json')), 10);
    assert.equal(await minGroupFloorFor('org1', asking({ minGroupSize: 'many' })), 10);
    assert.equal(await minGroupFloorFor('org1', asking({ minGroupSize: -5 })), 10);
    assert.equal(await minGroupFloorFor('org1', { limits, getConfig: async () => { throw new Error('db down'); } }), 10);
});

test('a floor of 0 means no floor', async () => {
    assert.equal(await minGroupFloorFor('org1', { limits: { minGroupFloor: 0 }, getConfig: async () => null }), 0);
});

test('effectiveMinN is the higher of the step and the floor', () => {
    assert.equal(effectiveMinN(30, 10), 30);
    assert.equal(effectiveMinN(5, 10), 10);
    assert.equal(effectiveMinN(0, 0), 0);
    assert.equal(effectiveMinN(undefined, 7), 7);
    assert.equal(effectiveMinN('abc', 7), 7);
});
