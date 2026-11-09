'use strict';

/**
 * triggerBus/dispatch.js: a subscription owned by a Cowork item starts that
 * item's agent (core/cowork/mailTriggerRun.runForEvent(sub, payload)) after the
 * filter matched, and never loads an automation. (The automation-owned path is
 * covered by triggerBus.dispatch.rootStepId.test.js.)
 *
 * Run: node --test automation/triggerBus.dispatch.cowork.test.js
 */
const { test } = require('node:test');
const assert = require('assert');
const { dispatchToSubscription, _setDepsForTests } = require('./triggerBus/dispatch');

const tick = () => new Promise((resolve) => setImmediate(resolve));
const SUB = { id: 'sub-cw', coworkScheduleId: 'cw-1', automationId: null, userId: 'user-1', filter: { from: 'boss' } };

const cowork = [];
const recorder = { runForEvent: async (sub, payload) => { cowork.push({ sub, payload }); } };
_setDepsForTests({ coworkRunner: recorder });
test.after(() => _setDepsForTests());
test.beforeEach(() => { cowork.length = 0; _setDepsForTests({ coworkRunner: recorder }); });

test('a matching mail goes to the Cowork runner with the row and the automation-shaped payload', async () => {
    const runs = dispatchToSubscription(SUB, { provider: 'gmail', event: 'mail.new', payload: { from: 'Boss <boss@x.nl>', subject: 'Hi', messageId: 'm1' } });
    await tick();
    assert.deepStrictEqual(runs, [{ subId: 'sub-cw' }]);
    assert.strictEqual(cowork.length, 1);
    assert.strictEqual(cowork[0].sub, SUB);
    assert.deepStrictEqual(cowork[0].payload, { provider: 'gmail', event: 'mail.new', from: 'Boss <boss@x.nl>', subject: 'Hi', messageId: 'm1' });
});

test('the filter still decides: a mail from someone else does not start the agent', async () => {
    const runs = dispatchToSubscription(SUB, { provider: 'gmail', event: 'mail.new', payload: { from: 'someone@else.nl' } });
    await tick();
    assert.deepStrictEqual(runs, []);
    assert.strictEqual(cowork.length, 0);
});

test('a failing run is logged, never thrown into the poller', async () => {
    _setDepsForTests({ coworkRunner: { runForEvent: async () => { throw new Error('boom'); } } });
    assert.doesNotThrow(() => dispatchToSubscription(SUB, { provider: 'gmail', event: 'mail.new', payload: { from: 'boss@x.nl' } }));
    await tick();
    await tick();
});
