'use strict';

/**
 * Fan-out scoping for providers that are declared at runtime rather than
 * hardcoded.
 *
 * dispatchEvent used to broadcast to every subscription in every organisation
 * whenever an event arrived without a userId and its provider happened not to
 * be in one of two hardcoded sets. That was survivable while the provider list
 * was a fixed array nobody could extend; with integrations declaring their own
 * providers it is a hole that widens on its own, so the default is now to drop.
 *
 * Run: node --test automation/triggerBus.dispatchScope.test.js
 */

const { test } = require('node:test');
const assert = require('assert');

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
        executeAutomation: async (automation) => { dispatchedRuns.push(automation.id); return { id: 'run' }; },
    },
};

const { registerTriggerSource } = require('./triggerSources');
const { dispatchEvent, dispatchOrgScopedEvent } = require('./triggerBus/dispatch');

const tick = () => new Promise((resolve) => setImmediate(resolve));

const declaration = (id, scope) => ({
    id,
    label: id,
    order: 500,
    defaultEvent: 'thing.happened',
    availability: { kind: 'check', check: id },
    events: [{
        id: 'thing.happened',
        label: 'Thing happened',
        fields: ['x'],
        sample: { x: 1 },
        scope,
        source: {
            kind: 'poll_diff', tool: 't', requiresIntegration: id,
            itemsPath: 'i', idPath: 'id', changePaths: ['x'],
            emit: { mode: 'item', map: { x: 'x' } },
        },
    }],
});

test('an unknown provider with no userId and no orgId is dropped, not broadcast', async () => {
    dispatchedRuns.length = 0;
    const runs = await dispatchEvent({ provider: 'never-declared', event: 'thing.happened', payload: {} });
    await tick();
    assert.deepStrictEqual(runs, [], 'no subscription is run');
    assert.deepStrictEqual(dispatchedRuns, [], 'and no automation from any org executed');
});

test('a provider declared user-scoped still refuses an unidentified event', async () => {
    registerTriggerSource(declaration('acme-user', 'user'), { origin: 'test' });
    dispatchedRuns.length = 0;
    const runs = await dispatchEvent({ provider: 'acme-user', event: 'thing.happened', payload: {} });
    await tick();
    assert.deepStrictEqual(runs, []);
    assert.deepStrictEqual(dispatchedRuns, []);
});

test('a provider declared org-scoped reaches only its own organisation', async () => {
    registerTriggerSource(declaration('acme-org', 'org'), { origin: 'test' });
    dispatchedRuns.length = 0;
    const runs = await dispatchEvent({ provider: 'acme-org', event: 'thing.happened', payload: {}, orgId: 'org-A' });
    await tick();
    assert.strictEqual(runs.length, 1);
    assert.deepStrictEqual(dispatchedRuns, ['auto-orgA']);
});

test('a declared provider still honours the identified subscriber', async () => {
    dispatchedRuns.length = 0;
    await dispatchEvent({ provider: 'acme-user', event: 'thing.happened', payload: {}, userId: 'user-orgB' });
    await tick();
    assert.deepStrictEqual(dispatchedRuns, ['auto-orgB']);
});

test('github keeps working — the legacy allowlist is not collateral damage', async () => {
    // github dispatches with neither userId nor orgId because its webhook has
    // no installation→org mapping yet. Dropping it here would look like a
    // security fix while silently breaking a shipped feature.
    dispatchedRuns.length = 0;
    const runs = await dispatchEvent({ provider: 'github', event: 'push', payload: {} });
    await tick();
    assert.strictEqual(runs.length, 2);
    assert.deepStrictEqual(dispatchedRuns.sort(), ['auto-orgA', 'auto-orgB']);
});

test('org-scoped dispatch honours the rich filter DSL like every other path', async () => {
    // dispatchOrgScopedEvent used to call the matcher without the DSL wrapper,
    // so any/none/expr/age filters were ignored and the automation fired on
    // events its author had explicitly excluded.
    const store = require.cache[storePath].exports;
    const original = store.getSubscriptionsForProvider;
    store.getSubscriptionsForProvider = async () => [
        { id: 'sub-orgA', automationId: 'auto-orgA', userId: 'user-orgA', filter: { none: [{ kind: 'noisy' }] } },
    ];
    try {
        dispatchedRuns.length = 0;
        await dispatchOrgScopedEvent('acme-org', 'thing.happened', { kind: 'noisy' }, 'org-A');
        await tick();
        assert.deepStrictEqual(dispatchedRuns, [], 'excluded by the filter');

        await dispatchOrgScopedEvent('acme-org', 'thing.happened', { kind: 'real' }, 'org-A');
        await tick();
        assert.deepStrictEqual(dispatchedRuns, ['auto-orgA'], 'anything else still fires');
    } finally {
        store.getSubscriptionsForProvider = original;
    }
});
