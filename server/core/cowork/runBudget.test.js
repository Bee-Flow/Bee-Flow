// @typecheck
/**
 * An item's monthly AI budget (./runBudget.mts): under it nothing happens; at it the item pauses itself, its owner is
 * told once, and the run does not start. Every part is handed in.
 *
 * Run: cd server && node --test core/cowork/runBudget.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { budgetRefusal } = require('./runBudget.mts');

const NOW = new Date('2026-11-23T08:00:00Z');

/** @param {number} spent @param {{ fails?: boolean }} [o] */
function world(spent, { fails = false } = {}) {
    /** @type {any[]} */
    const paused = [];
    /** @type {any[]} */
    const told = [];
    /** @type {Date[]} */
    const since = [];
    const deps = {
        costsSince: async (/** @type {string} */ _u, /** @type {Date} */ s) => { since.push(s); if (fails) throw new Error('down'); return { byItem: { w1: { byCurrency: { EUR: spent, USD: 99 }, calls: 3 } } }; },
        pause: async (/** @type {string} */ id) => { paused.push(id); },
        notify: async (/** @type {any} */ n) => { told.push(n); },
    };
    return { deps, paused, told, since };
}
const TASK = { id: 'w1', userId: 'u1', title: 'Supplier radar', monthlyBudget: 3 };

test('under the budget, and without one, the run goes ahead and nothing changes', async () => {
    const under = world(2.99);
    assert.strictEqual(await budgetRefusal(TASK, NOW, under.deps), null);
    assert.deepStrictEqual([under.paused, under.told], [[], []]);
    assert.strictEqual(under.since[0].getDate(), 1, 'counted from the first of the month');
    assert.strictEqual(await budgetRefusal({ ...TASK, monthlyBudget: null }, NOW, world(50).deps), null);
});

test('at the budget the item pauses itself, the owner is told once, and the run does not start', async () => {
    const at = world(3.2);
    const reason = await budgetRefusal(TASK, NOW, at.deps);
    assert.match(reason ?? '', /reached its AI budget of €3\.00 for this month \(€3\.20 spent\)/);
    assert.deepStrictEqual(at.paused, ['w1']);
    assert.deepStrictEqual([at.told.length, at.told[0].title, at.told[0].link], [1, 'Supplier radar paused itself', '/app/cowork/w1']);
});

test('a cost that cannot be read stops nothing; only euros count', async () => {
    assert.strictEqual(await budgetRefusal(TASK, NOW, world(0, { fails: true }).deps), null);
    assert.strictEqual(await budgetRefusal(TASK, NOW, world(0).deps), null, 'USD 99 is not counted towards a budget in euros');
});
