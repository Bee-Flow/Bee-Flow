'use strict';

/**
 * Regression tests for the two P0 cross-tenant fan-out fail-open bugs in
 * triggerBus/dispatch.js:
 *   - dispatchEvent: a Nextcloud event with no resolved userId used to
 *     fan out to EVERY tenant's subscriptions (no org filter applied).
 *   - dispatchOrgScopedEvent: a null orgId used to skip the org filter
 *     entirely instead of failing closed.
 *
 * Run: node --test automation/triggerBus.dispatch.test.js
 */

const { test } = require('node:test');
const assert = require('assert');

// Stub automationStore + userStore before requiring dispatch.js so it loads
// without booting a DB pool, and so we can hand back synthetic subscriptions
// spanning two different orgs' users.
const storePath = require.resolve('../stores/automationStore');
const SUBS = [
    { id: 'sub-orgA', automationId: 'auto-orgA', userId: 'user-orgA', filter: null },
    { id: 'sub-orgB', automationId: 'auto-orgB', userId: 'user-orgB', filter: null },
];
require.cache[storePath] = {
    id: storePath,
    filename: storePath,
    loaded: true,
    exports: {
        getSubscriptionsForProvider: async () => SUBS,
        getAutomation: async (id) => ({ id, isActive: true, isDraft: false }),
    },
};

const userStorePath = require.resolve('../stores/userStore');
const USERS = {
    'user-orgA': { id: 'user-orgA', organizationId: 'org-A' },
    'user-orgB': { id: 'user-orgB', organizationId: 'org-B' },
};
require.cache[userStorePath] = {
    id: userStorePath,
    filename: userStorePath,
    loaded: true,
    exports: { getUser: async (uid) => USERS[uid] || null },
};

const runnerPath = require.resolve('../core/automationRunner');
const dispatchedRuns = [];
require.cache[runnerPath] = {
    id: runnerPath,
    filename: runnerPath,
    loaded: true,
    exports: {
        executeAutomation: async (automation) => {
            dispatchedRuns.push(automation.id);
            return { id: `run-${automation.id}` };
        },
    },
};

const { dispatchEvent, dispatchToSubscription, dispatchOrgScopedEvent } = require('./triggerBus/dispatch');

// executeAutomation now runs fire-and-forget (setImmediate) inside dispatch.js
// so ingest routes / the polling tick never block on a slow automation —
// give scheduled setImmediate callbacks a turn before asserting on side effects.
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('dispatchEvent: nextcloud event with no userId AND no orgId is dropped, not fanned out', async () => {
    dispatchedRuns.length = 0;
    const runs = await dispatchEvent({ provider: 'nextcloud', event: 'file.changed', payload: {} });
    await tick();
    assert.deepStrictEqual(runs, [], 'no orgId to scope to → drop, never fan out cross-tenant');
    assert.deepStrictEqual(dispatchedRuns, []);
});

test('dispatchEvent: nextcloud event with no userId but a real orgId only reaches that org\'s subscriptions', async () => {
    dispatchedRuns.length = 0;
    const runs = await dispatchEvent({ provider: 'nextcloud', event: 'file.changed', payload: {}, orgId: 'org-A' });
    await tick();
    assert.deepStrictEqual(dispatchedRuns, ['auto-orgA'], 'only the org-A subscriber\'s automation runs');
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].subId, 'sub-orgA');
});

const supportPayload = { genuineContact: true };

test('dispatchOrgScopedEvent: null orgId fails closed (no cross-tenant fan-out)', async () => {
    dispatchedRuns.length = 0;
    const runs = await dispatchOrgScopedEvent('support', 'ticket.resolved', supportPayload, null);
    await tick();
    assert.deepStrictEqual(runs, [], 'missing orgId must drop the event, not fan out to every org');
    assert.deepStrictEqual(dispatchedRuns, []);
});

test('dispatchOrgScopedEvent: real orgId only reaches that org\'s subscriptions', async () => {
    dispatchedRuns.length = 0;
    const runs = await dispatchOrgScopedEvent('support', 'ticket.resolved', supportPayload, 'org-B');
    await tick();
    assert.deepStrictEqual(dispatchedRuns, ['auto-orgB']);
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].subId, 'sub-orgB');
});

// GitHub (and any other provider that is neither user-scoped nor org-scoped)
// must NOT be collaterally dropped by the nextcloud-motivated orgId gate —
// it has its own (separately tracked, WS1.2) isolation gap, but the P0 fix
// here must not silently kill an unrelated, currently-working feature.
test('dispatchEvent: github event with no userId and no orgId is still dispatched (not collaterally dropped)', async () => {
    dispatchedRuns.length = 0;
    const runs = await dispatchEvent({ provider: 'github', event: 'push', payload: {} });
    await tick();
    assert.strictEqual(runs.length, 2, 'unscoped provider still fans out to matching subs, unchanged from before the orgId gate');
    assert.deepStrictEqual(dispatchedRuns.sort(), ['auto-orgA', 'auto-orgB']);
});

// Regression: polling used to route discovered events through the broad
// dispatchEvent() fan-out, which double-fires automations when a user has
// two sibling subscriptions on the same provider+event (sub A's poll tick
// dispatches to both A and B; sub B's own later poll tick rediscovers the
// same item via its own cursor and dispatches to both again).
test('dispatchToSubscription: only dispatches to the ONE subscription given, not sibling subs on the same provider+event+user', async () => {
    dispatchedRuns.length = 0;
    const siblingSubs = [
        { id: 'sub-1', automationId: 'auto-1', userId: 'user-orgA', filter: null },
        { id: 'sub-2', automationId: 'auto-2', userId: 'user-orgA', filter: null },
    ];
    const runs = dispatchToSubscription(siblingSubs[0], { provider: 'gmail', event: 'mail.new', payload: {} });
    await tick();
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].subId, 'sub-1');
    assert.deepStrictEqual(dispatchedRuns, ['auto-1'], 'sibling sub-2 (same user, same provider+event) must NOT also fire');
});
