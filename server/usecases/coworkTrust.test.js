// @typecheck
/**
 * Letting one step go on its own (./coworkTrust.mts): only after enough decisions, only while the ceiling allows it,
 * and asking again is always allowed. Every part is handed in.
 *
 * Run: cd server && node --test usecases/coworkTrust.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { trustOf, chooseTrust } = require('./coworkTrust.mts');
const { fakeLookups, planOf, literal } = require('../core/cowork/plan/plan.testkit');

const PLAN = planOf([{ id: 'send', type: 'integration_action', label: 'Mail the supplier', tool: 'outlook_compose', inputs: { to: literal('o@s.example') } }]);
/** @param {number} letThrough @param {string} [ceiling] */
function world(letThrough, ceiling = 'on_its_own') {
    /** @type {any[]} */
    const set = [];
    const rows = [{ stepId: 'send', recipient: 'o@s.example', letThrough, trusted: false }, { stepId: 'gone', recipient: '*', letThrough: 9, trusted: false }];
    return {
        set,
        deps: {
            listTrust: async () => rows,
            setTrusted: async (/** @type {any[]} */ ...a) => { set.push(a); return true; },
            getApprovedPlan: async () => ({ definition: PLAN }),
            policyOf: async () => ({ ceiling: /** @type {any} */ (ceiling), readOnly: false, unattendedApps: null, monthlyBudget: null }),
            lookups: fakeLookups(),
        },
    };
}
const ITEM = { id: 'w1', userId: 'u1' };

test('what a step earned, under its title; a step the plan no longer has is left out', async () => {
    const state = await trustOf(ITEM, world(3).deps);
    assert.deepStrictEqual(state.entries, [{ stepId: 'send', recipient: 'o@s.example', letThrough: 3, trusted: false, title: 'Mail the supplier', canTrust: false }]);
    assert.strictEqual((await trustOf(ITEM, world(5).deps)).entries[0].canTrust, true);
});

test('trusting needs enough decisions and a ceiling that allows it; asking again always works', async () => {
    await assert.rejects(chooseTrust({ item: ITEM, stepId: 'send', recipient: 'o@s.example', trusted: true }, world(4).deps), (/** @type {any} */ e) => e.status === 409 && /4 so far/.test(e.message));
    await assert.rejects(chooseTrust({ item: ITEM, stepId: 'send', recipient: 'o@s.example', trusted: true }, world(9, 'asks_before_sending').deps), (/** @type {any} */ e) => e.status === 409 && /organisation/.test(e.message));
    const ok = world(5);
    await chooseTrust({ item: ITEM, stepId: 'send', recipient: 'o@s.example', trusted: true }, ok.deps);
    assert.deepStrictEqual(ok.set, [['w1', 'send', 'o@s.example', true]]);
    const back = world(0, 'asks_everything');
    await chooseTrust({ item: ITEM, stepId: 'send', recipient: 'o@s.example', trusted: false }, back.deps);
    assert.deepStrictEqual(back.set, [['w1', 'send', 'o@s.example', false]]);
    await assert.rejects(chooseTrust({ item: ITEM, stepId: 'nope', recipient: '*', trusted: false }, ok.deps), (/** @type {any} */ e) => e.status === 404);
});
