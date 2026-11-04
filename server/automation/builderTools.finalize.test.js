// @typecheck strict
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

test('a saved finalize says what the person still does: needs from the trigger and the apps the draft uses', async () => {
    const saved = { update: automationStore.updateAutomation, get: automationStore.getAutomation };
    automationStore.updateAutomation = async (/** @type {string} */ id) => /** @type {any} */ ({ id, title: 'Facturen' });
    automationStore.getAutomation = async () => null;
    try {
        const def = {
            ...emptyDefinition(),
            trigger: { id: 'trg', type: 'trigger', kind: 'form', fields: [{ name: 'email', label: 'E-mail', type: 'email' }] },
            steps: [{ id: 's1', type: 'integration_action', tool: 'gmail_search', inputs: {} }],
            edges: [{ from: 'trg', to: 's1' }],
        };
        const res = /** @type {any} */ (await applyToolCall('builder_finalize', {},
            /** @type {any} */ ({ automationId: 'a1', def, _availableToolNames: new Set(['sheets_list']) })));
        assert.strictEqual(res.automation.id, 'a1');
        assert.deepStrictEqual(res.needs, ['connect:gmail', 'activate', 'share-form']);
    } finally {
        automationStore.updateAutomation = saved.update;
        automationStore.getAutomation = saved.get;
    }
});
