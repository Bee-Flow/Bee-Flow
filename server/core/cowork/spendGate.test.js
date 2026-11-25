// @typecheck
/**
 * A try-out, a replay and having a plan made count against the budgets (./spendGate.mts): refused at the item's or the
 * organisation's monthly budget, allowed under it, and allowed when the cost cannot be read.
 *
 * Run: cd server && node --test core/cowork/spendGate.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { assertSpendLeft } = require('./spendGate.mts');

const NOW = new Date('2026-11-24T09:00:00Z');
/** @param {{ item?: number, org?: number, orgBudget?: number | null, fails?: boolean }} [o] */
const deps = ({ item = 0, org = 0, orgBudget = null, fails = false } = {}) => ({
    itemSpent: async () => { if (fails) throw new Error('ledger down'); return { byItem: { s1: { byCurrency: { EUR: item } } } }; },
    orgOf: async () => 'org-1',
    orgBudget: async () => orgBudget,
    orgSpent: async () => ({ byCurrency: { EUR: org } }),
});
const used = (/** @type {any} */ e) => e.status === 409 && e.code === 'cowork_budget_used';

test('at the item\'s budget, or at the organisation\'s, the action is refused; under both it goes', async () => {
    await assert.rejects(assertSpendLeft({ id: 's1', userId: 'u1', monthlyBudget: 5 }, NOW, deps({ item: 5 })), used);
    await assert.rejects(assertSpendLeft({ id: 's1', userId: 'u1', monthlyBudget: null }, NOW, deps({ org: 50, orgBudget: 50 })), used);
    await assertSpendLeft({ id: 's1', userId: 'u1', monthlyBudget: 5 }, NOW, deps({ item: 4.99, org: 10, orgBudget: 50 }));
});

test('a cost that cannot be read lets it go, as for a run', async () => {
    await assertSpendLeft({ id: 's1', userId: 'u1', monthlyBudget: 5 }, NOW, deps({ fails: true }));
});
