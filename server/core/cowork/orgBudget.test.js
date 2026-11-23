// @typecheck
/**
 * The organisation's monthly Cowork budget (./orgBudget.mts): at it a run does not start; the administrators hear it
 * once a month and each item's owner once a month; under it, without an organisation, or when the cost cannot be read,
 * the run goes ahead. The subscription's own limits refuse too.
 *
 * Run: cd server && node --test core/cowork/orgBudget.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { orgBudgetRefusal } = require('./orgBudget.mts');

const NOW = new Date('2026-11-23T09:00:00Z');
const TASK = { id: 's1', userId: 'u1', title: 'Supplier radar' };

/** @param {{ spent?: number | Error, org?: string | null, subscription?: string | null }} [o] */
function world({ spent = 0, org = 'org-1', subscription = null } = {}) {
    const claimed = new Set();
    /** @type {any[]} */
    const notes = [];
    /** @type {any[]} */
    const since = [];
    const deps = {
        orgOf: async () => org,
        orgCostSince: async (/** @type {string} */ orgId, /** @type {Date} */ from) => {
            since.push([orgId, from.toISOString()]);
            if (spent instanceof Error) throw spent;
            return { byCurrency: { EUR: spent, USD: 999 }, calls: 3 };
        },
        subscriptionRefusal: async () => subscription,
        claimOnce: async (/** @type {string} */ type, /** @type {string} */ id, /** @type {string} */ kind) => {
            const key = `${type}:${id}:${kind}`;
            if (claimed.has(key)) return false;
            claimed.add(key);
            return true;
        },
        adminIds: async () => ['admin-1', 'admin-2'],
        notify: async (/** @type {any} */ n) => { notes.push(n); },
    };
    return { deps, notes, since };
}

test('under the budget, without one, or without an organisation, the run goes ahead', async () => {
    assert.strictEqual(await orgBudgetRefusal(TASK, 50, NOW, world({ spent: 49.99 }).deps), null);
    assert.strictEqual(await orgBudgetRefusal(TASK, null, NOW, world({ spent: 1000 }).deps), null);
    assert.strictEqual(await orgBudgetRefusal(TASK, 50, NOW, world({ spent: 1000, org: null }).deps), null);
});

test('it counts euros since the first of the month, for the whole organisation', async () => {
    const w = world({ spent: 10 });
    await orgBudgetRefusal(TASK, 50, NOW, w.deps);
    assert.deepStrictEqual(w.since, [['org-1', new Date(2026, 10, 1).toISOString()]]);
});

test('at the budget the run is refused with the amounts; the first refusal of an item speaks, the next ones are quiet', async () => {
    const w = world({ spent: 50 });
    const first = await orgBudgetRefusal(TASK, 50, NOW, w.deps);
    const second = await orgBudgetRefusal(TASK, 50, NOW, w.deps);
    const other = await orgBudgetRefusal({ ...TASK, id: 's2' }, 50, NOW, w.deps);
    assert.match(String(first?.reason), /budget of €50\.00 for this month is used up \(€50\.00 spent\)/);
    assert.deepStrictEqual([first?.quiet, second?.quiet, other?.quiet], [false, true, false]);
});

test('the administrators are told once a month, not once per run', async () => {
    const w = world({ spent: 80 });
    await orgBudgetRefusal(TASK, 50, NOW, w.deps);
    await orgBudgetRefusal({ ...TASK, id: 's2' }, 50, NOW, w.deps);
    assert.deepStrictEqual(w.notes.map((n) => n.userId), ['admin-1', 'admin-2']);
    assert.match(w.notes[0].message, /€50\.00/);
});

test('a cost that cannot be read lets the run go; the subscription\'s own limit still refuses', async () => {
    assert.strictEqual(await orgBudgetRefusal(TASK, 50, NOW, world({ spent: new Error('ledger down') }).deps), null);
    const limited = await orgBudgetRefusal(TASK, null, NOW, world({ subscription: 'Your organization has reached its monthly cost limit.' }).deps);
    assert.match(String(limited?.reason), /monthly cost limit/);
});
