'use strict';

/**
 * Whose connections runs use (definition.runPolicy.connections) cannot be moved
 * by a writer that is not the owner: the store keeps the stored value.
 *
 * Run: node --test stores/automationStore/connectionsPolicy.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { keepConnectionsPolicy, modeOf } = require('./connectionsPolicy');

const clientFor = (stored, owner = 'owner') => ({
    queries: [],
    async query(sql, params) { this.queries.push(params); return { rows: stored === undefined ? [] : [{ user_id: owner, definition_json: stored }] }; },
});
const def = (connections, extra = {}) => ({ trigger: { id: 't' }, steps: [], ...extra, ...(connections ? { runPolicy: { ...(extra.runPolicy || {}), connections } } : {}) });

test('modeOf: only the literal "caller" counts', () => {
    assert.strictEqual(modeOf(def('caller')), 'caller');
    for (const d of [def(null), def('owner'), def('x'), null, {}]) assert.strictEqual(modeOf(d), 'owner');
});

test('a non-owner writer (stage compensate, upgrade, evolution rollback, install) cannot switch it on or off', async () => {
    const on = await keepConnectionsPolicy(clientFor(def(null)), 'a1', { definition: def('caller') }, 'system', false);
    assert.strictEqual(modeOf(on.definition), 'owner');
    const off = await keepConnectionsPolicy(clientFor(def('caller')), 'a1', { definition: def(null, { runPolicy: { retry: { max: 2 } } }) }, null, false);
    assert.strictEqual(off.definition.runPolicy.connections, 'caller');
    assert.deepStrictEqual(off.definition.runPolicy.retry, { max: 2 }, 'the rest of the policy is the writer\'s');
});

test('even a writer acting AS the owner (rollback, upgrade) cannot; only a route that proved the owner role may', async () => {
    const asOwner = await keepConnectionsPolicy(clientFor(def(null)), 'a1', { definition: def('caller') }, 'owner', false);
    assert.strictEqual(modeOf(asOwner.definition), 'owner');
    const byRoute = await keepConnectionsPolicy(clientFor(def(null)), 'a1', { definition: def('caller') }, 'admin-1', true);
    assert.strictEqual(modeOf(byRoute.definition), 'caller');
});

test('writes that do not touch the mode, or carry no definition, pass through without a read', async () => {
    const c = clientFor(def('caller'));
    const same = { definition: def('caller') };
    assert.strictEqual(await keepConnectionsPolicy(c, 'a1', same, 'system', false), same);
    const noDef = { title: 'x' };
    assert.strictEqual(await keepConnectionsPolicy(c, 'a1', noDef, 'system', false), noDef);
    assert.strictEqual(c.queries.length, 1, 'only the first needed the stored row');
});

test('a row that is gone is left to the caller to report', async () => {
    const u = { definition: def('caller') };
    assert.strictEqual(await keepConnectionsPolicy(clientFor(undefined), 'a1', u, 'system', false), u);
});
