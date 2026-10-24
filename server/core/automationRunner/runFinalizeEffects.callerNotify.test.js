// @typecheck
'use strict';

/**
 * The owner is told that a run by somebody else ended, never what it held: a
 * run on the starter's own connections carries no summary or error text in the
 * owner's notification.
 *
 * Run: node --test core/automationRunner/runFinalizeEffects.callerNotify.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const { notifyRunEnd } = require('./runFinalizeEffects');
after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });

function end(over = {}) {
    return {
        automation: { id: 'a1', title: 'Flow' }, run: { id: 'r1', connectionsMode: null }, firstRunNeedsConfirm: false,
        runStatus: 'success', runErrorObj: null, summary: 'private summary', userSafeError: 'private error',
        triggerKind: 'manual', effectiveMode: 'live', testRun: false, ...over,
    };
}
async function notified(e) {
    const sent = [];
    await notifyRunEnd({ notifyRunEvent: async (a, ev, payload) => { sent.push({ ev, payload }); }, engine: { ApprovalRequiredError: class {} } }, e);
    return sent;
}

test('a caller-mode success and failure reach the owner without the run\'s text', async () => {
    const run = { id: 'r1', connectionsMode: 'caller' };
    const ok = await notified(end({ run }));
    assert.strictEqual(ok[0].ev, 'onSuccess');
    assert.strictEqual(ok[0].payload.message, '');
    const bad = await notified(end({ run, runStatus: 'error' }));
    assert.strictEqual(bad[0].ev, 'onError');
    assert.ok(!JSON.stringify(bad).includes('private'));
});

test('an ordinary run still carries them', async () => {
    const ok = await notified(end());
    assert.strictEqual(ok[0].payload.message, 'private summary');
    const bad = await notified(end({ runStatus: 'error' }));
    assert.strictEqual(bad[0].payload.message, 'private error');
});
