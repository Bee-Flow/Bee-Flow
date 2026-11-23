// @typecheck
/**
 * Handing a cowork to a colleague (./coworkHandOver.mts), on the real Cowork store (PGlite): the colleague gets a new,
 * paused item with the plan to approve, the old item goes with its runs, and only a colleague of the same
 * organisation can receive it. The people, the automations and the bell are handed in.
 *
 * Run: cd server && node --test usecases/coworkHandOver.pg.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { store } = require('../stores/coworkStore.testkit').coworkStoreOnPglite();
const { handOver, colleaguesOf } = require('./coworkHandOver.mts');

const PEOPLE = {
    ann: { id: 'ann', organizationId: 'org-a', status: 'active', displayName: 'Ann' },
    bob: { id: 'bob', organizationId: 'org-a', status: 'active', displayName: 'Bob' },
    eve: { id: 'eve', organizationId: 'org-b', status: 'active', displayName: 'Eve' },
};
const PLAN = { trigger: { id: 'trg', type: 'trigger', kind: 'schedule' }, steps: [{ id: 'a', type: 'set', values: {} }], edges: [{ from: 'trg', to: 'a' }] };

function deps() {
    /** @type {any[]} */
    const automations = [];
    /** @type {any[]} */
    const bells = [];
    return {
        automations, bells,
        deps: {
            getUser: async (/** @type {string} */ id) => /** @type {any} */ (PEOPLE)[id] ?? null,
            listMembers: async (/** @type {string} */ org) => Object.values(PEOPLE).filter((p) => p.organizationId === org),
            store,
            getAutomation: async () => null,
            createAutomation: async (/** @type {any} */ input) => { automations.push(input); return { id: `auto-${automations.length}` }; },
            notify: async (/** @type {any} */ n) => { bells.push(n); },
        },
    };
}

async function annsItem() {
    const s = await store.createSchedule({ userId: 'ann', title: 'Supplier radar', prompt: 'Summarise supplier mail.', repeatInterval: 'daily', nextRunAt: new Date(Date.now() + 86_400_000).toISOString() });
    const id = /** @type {{ id: string }} */ (s).id;
    await store.approvePlan({ scheduleId: id, automationId: 'auto-ann', definition: PLAN, permissions: { v: 1, grants: [], sends: 'none', ai: false, outsideText: false }, fingerprint: 'f'.repeat(64), approvedBy: 'ann' });
    const run = /** @type {string} */ (await store.markRunning(id, { triggerKind: 'manual' }));
    await store.markCompleted(id, 'Ann\'s supplier summary.', { runId: run });
    return /** @type {any} */ (await store.getSchedule(id));
}

test('the colleague gets a new, paused item with the plan to approve; the old item goes with its runs', async () => {
    const item = await annsItem();
    const w = deps();
    const { itemId } = await handOver({ item, toUserId: 'bob' }, w.deps);
    const fresh = /** @type {any} */ (await store.getSchedule(itemId));
    assert.deepStrictEqual([fresh.userId, fresh.title, fresh.isActive, fresh.planId], ['bob', 'Supplier radar', false, null]);
    assert.strictEqual(fresh.planAutomationId, 'auto-1', 'the plan is in an automation of Bob\'s own, not approved');
    assert.deepStrictEqual([w.automations[0].userId, w.automations[0].definition], ['bob', PLAN]);
    assert.deepStrictEqual(await store.listRuns(itemId), [], 'none of Ann\'s runs came along');
    assert.strictEqual(await store.getSchedule(item.id), null, 'Ann\'s item is gone');
    assert.match(w.bells[0].message, /Ann handed you "Supplier radar"\. It is paused until you look at it and approve its plan\./);
    assert.strictEqual(w.bells[0].link, `/app/cowork/${itemId}`);
});

test('only to an active colleague of the same organisation; a mail-started item stays', async () => {
    const item = await annsItem();
    const w = deps();
    for (const to of ['eve', 'nobody', 'ann']) {
        await assert.rejects(handOver({ item, toUserId: to }, w.deps), (/** @type {any} */ e) => e.status === 404, to);
    }
    await assert.rejects(handOver({ item: { ...item, triggerKind: 'app_event' }, toUserId: 'bob' }, w.deps), (/** @type {any} */ e) => e.status === 409);
    assert.ok(await store.getSchedule(item.id), 'nothing changed');
    assert.deepStrictEqual(await colleaguesOf(item, w.deps), [{ id: 'bob', name: 'Bob' }]);
});
