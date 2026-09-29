'use strict';

/**
 * Regression test: triggerBus/dispatch.js must forward a subscription's own
 * `triggerStepId` (set by crud.js's syncAppEventSubscription — one row per
 * app_event trigger, see routes/automation/crud.multiTrigger.test.js) to
 * executeAutomation as `rootStepId`, so runDag seeds the walk from the
 * SPECIFIC trigger node that fired rather than always the primary trigger
 * (see core/automationRunner/runDag.rootTrigger.test.js for the runDag half
 * of this contract).
 *
 * Run: node --test automation/triggerBus.dispatch.rootStepId.test.js
 */
const { test } = require('node:test');
const assert = require('assert');

const storePath = require.resolve('../stores/automationStore');
const SUBS = [
    { id: 'sub-primary', automationId: 'auto-1', userId: 'user-1', filter: null, triggerStepId: 'trg1' },
    { id: 'sub-secondary', automationId: 'auto-1', userId: 'user-1', filter: null, triggerStepId: 'trg2' },
    { id: 'sub-legacy', automationId: 'auto-2', userId: 'user-1', filter: null }, // no triggerStepId (pre-migration row)
];
require.cache[storePath] = {
    id: storePath, filename: storePath, loaded: true,
    exports: {
        getSubscriptionsForProvider: async () => SUBS,
        getAutomation: async (id) => ({ id, isActive: true, isDraft: false }),
    },
};

const runnerPath = require.resolve('../core/automationRunner');
const executeCalls = [];
require.cache[runnerPath] = {
    id: runnerPath, filename: runnerPath, loaded: true,
    exports: {
        executeAutomation: async (automation, opts) => { executeCalls.push({ automationId: automation.id, opts }); return { id: `run-${automation.id}` }; },
    },
};

const { dispatchEvent, dispatchToSubscription } = require('./triggerBus/dispatch');
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('dispatchEvent forwards each matched subscription\'s own triggerStepId as rootStepId', async () => {
    executeCalls.length = 0;
    await dispatchEvent({ provider: 'gmail', event: 'mail.new', payload: {}, userId: 'user-1' });
    await tick();
    // Only sub-primary and sub-secondary belong to user-1's auto-1; sub-legacy
    // is a different automation but shares provider/event and also matches.
    Object.fromEntries(executeCalls.map(c => [`${c.automationId}:${c.opts.rootStepId}`, c]));
    assert.ok(executeCalls.some(c => c.automationId === 'auto-1' && c.opts.rootStepId === 'trg1'));
    assert.ok(executeCalls.some(c => c.automationId === 'auto-1' && c.opts.rootStepId === 'trg2'));
});

test('a subscription with no triggerStepId (pre-migration row) forwards null — runDag falls back to the primary trigger', async () => {
    executeCalls.length = 0;
    await dispatchToSubscription(SUBS[2], { provider: 'gmail', event: 'mail.new', payload: {} });
    await tick();
    assert.strictEqual(executeCalls.length, 1);
    assert.strictEqual(executeCalls[0].opts.rootStepId, null);
});

test('dispatchToSubscription forwards the given subscription\'s triggerStepId', async () => {
    executeCalls.length = 0;
    await dispatchToSubscription(SUBS[1], { provider: 'github', event: 'push', payload: {} });
    await tick();
    assert.strictEqual(executeCalls.length, 1);
    assert.strictEqual(executeCalls[0].opts.rootStepId, 'trg2');
});
