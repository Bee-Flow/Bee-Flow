// @typecheck
/**
 * Cowork's home (./coworkHome.mts): how each item works, the owner's day as one timeline, and the AI cost of the
 * month. Every part is handed in.
 *
 * Run: cd server && node --test usecases/coworkHome.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { homeOf } = require('./coworkHome.mts');
const { fakeLookups, supplierRadar } = require('../core/cowork/plan/plan.testkit');

const NOW = new Date('2026-11-23T10:00:00Z');
const DAY = { from: '2026-11-22T23:00:00.000Z', to: '2026-11-23T23:00:00.000Z' };

/** @param {{ costFails?: boolean, mayAsk?: boolean }} [o] */
function deps({ costFails = false, mayAsk = true } = {}) {
    return {
        getSchedules: async () => [
            { id: 'w1', title: 'Supplier radar', isActive: true, nextRunAt: '2026-11-23T16:00:00.000Z', planId: 'p1', independence: null },
            { id: 'w2', title: 'Open quotes', isActive: true, nextRunAt: '2026-11-24T07:30:00.000Z', agentId: 'a1' },
            { id: 'w3', title: 'Paused one', isActive: false, nextRunAt: '2026-11-23T12:00:00.000Z' },
        ],
        getApprovedPlan: async (/** @type {string} */ id) => (id === 'w1' ? { definition: supplierRadar() } : null),
        listRunsBetween: async () => [{ runId: 'r1', itemId: 'w1', title: 'Supplier radar', status: 'success', at: '2026-11-23T07:30:00.000Z' }],
        costsSince: async () => { if (costFails) throw new Error('down'); return { total: { byCurrency: { EUR: 0.62 }, calls: 9 } }; },
        mayAsk: async () => mayAsk,
        lookups: fakeLookups(),
    };
}

test('how each item works: a plan\'s make-up and level, else a prompt or an agent', async () => {
    const home = await homeOf('u1', DAY, NOW, deps());
    assert.deepStrictEqual(home.how.w1, { kind: 'plan', fixed: 4, ai: 2, ask: 0, deliver: 1, level: 'asks_before_sending' });
    assert.deepStrictEqual([home.how.w2.kind, home.how.w3.kind, home.how.w2.level], ['agent', 'prompt', null]);
    assert.strictEqual((await homeOf('u1', DAY, NOW, deps({ mayAsk: false }))).how.w1.level, 'on_its_own');
});

test('the day as one timeline: what ran, then what is still to come today; a paused item and tomorrow are not in it', async () => {
    const home = await homeOf('u1', DAY, NOW, deps());
    assert.deepStrictEqual(home.today.map((e) => [e.kind, e.itemId, e.at]), [
        ['ran', 'w1', '2026-11-23T07:30:00.000Z'],
        ['next', 'w1', '2026-11-23T16:00:00.000Z'],
    ]);
});

test('the cost of the month; unreadable is null and costs nothing else', async () => {
    assert.deepStrictEqual((await homeOf('u1', DAY, NOW, deps())).cost, { byCurrency: { EUR: 0.62 }, calls: 9 });
    const broken = await homeOf('u1', DAY, NOW, deps({ costFails: true }));
    assert.strictEqual(broken.cost, null);
    assert.strictEqual(broken.today.length, 2);
});
