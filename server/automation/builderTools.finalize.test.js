const { test } = require('node:test');
const assert = require('node:assert');
const automationStore = require('../stores/automationStore');
const { applyToolCall, emptyDefinition } = require('./builderTools');

test('builder_finalize reports a failed write instead of ok:true with an undefined id', async () => {
    const saved = { update: automationStore.updateAutomation, get: automationStore.getAutomation };
    automationStore.updateAutomation = async () => false;
    automationStore.getAutomation = async () => null;
    try {
        const res = await applyToolCall('builder_finalize', {},
            { userId: 'u_test', automationId: 'a_gone', def: emptyDefinition() });
        assert.strictEqual(res.ok, false);
        assert.ok(res.error);
        assert.strictEqual(res.automation, undefined);
    } finally {
        automationStore.updateAutomation = saved.update;
        automationStore.getAutomation = saved.get;
    }
});
