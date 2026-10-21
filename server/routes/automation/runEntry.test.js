'use strict';

/**
 * runEntry: which definition a run enters and which trigger of it.
 * Run: node --test routes/automation/runEntry.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { configureStageVars } = require('../../core/automationRunner/stageVars');
const { entryDefinitionOf, resolveTriggerStepId } = require('./runEntry');

const DEF = {
    trigger: { id: 'trg_main', kind: 'manual' },
    triggers: [{ id: 'trg_form', kind: 'form' }, { id: 'trg_hook', kind: 'webhook' }],
};

test('no id: the primary trigger and a null rootStepId', () => {
    const r = resolveTriggerStepId(DEF, undefined);
    assert.strictEqual(r.trigger.id, 'trg_main');
    assert.strictEqual(r.rootStepId, null);
});

test('the primary named by id keeps rootStepId null', () => {
    const r = resolveTriggerStepId(DEF, 'trg_main');
    assert.strictEqual(r.trigger.id, 'trg_main');
    assert.strictEqual(r.rootStepId, null);
});

test('a secondary trigger becomes the rootStepId', () => {
    const r = resolveTriggerStepId(DEF, 'trg_form');
    assert.strictEqual(r.trigger.kind, 'form');
    assert.strictEqual(r.rootStepId, 'trg_form');
});

test('an unknown id is an error naming the known triggers, never a fall-back', () => {
    const r = resolveTriggerStepId(DEF, 'nope');
    assert.ok(r.error.includes('Unknown triggerStepId "nope"'));
    assert.ok(r.error.includes('trg_main (manual)') && r.error.includes('trg_form (form)'));
    assert.strictEqual(r.trigger, undefined);
});

test('an empty definition resolves to a null trigger', () => {
    assert.deepStrictEqual(resolveTriggerStepId(null, undefined), { trigger: null, rootStepId: null });
    assert.ok(resolveTriggerStepId({}, 'x').error.includes('(none)'));
});

test('an unmanaged automation enters its own definition', async () => {
    const restore = configureStageVars({ managedInfo: async () => null });
    try {
        const a = { id: 'a1', kind: 'automation', projectId: 'p1', definition: DEF };
        assert.strictEqual(await entryDefinitionOf(a), DEF);
        assert.strictEqual(await entryDefinitionOf({ id: 'a2', kind: 'automation', definition: DEF }), DEF);
    } finally { restore(); }
});

test('a managed automation enters the LIVE copy, not the working copy', async () => {
    const restore = configureStageVars({ managedInfo: async () => ({ stage: 'uat' }) });
    try {
        const live = { trigger: { id: 'trg_live', kind: 'manual' } };
        const a = { id: 'a1', kind: 'automation', projectId: 'p1', version: 3, liveVersion: 2, definition: DEF };
        Object.defineProperty(a, 'liveDefinition', { value: live, enumerable: false });
        const entered = await entryDefinitionOf(a);
        assert.strictEqual(entered.trigger.id, 'trg_live');
        assert.strictEqual(entered.triggers, undefined, 'a trigger only in the working copy is not offered');
    } finally { restore(); }
});

test('a managed automation without a live copy is refused', async () => {
    const restore = configureStageVars({ managedInfo: async () => ({ stage: 'uat' }) });
    try {
        const a = { id: 'a1', kind: 'automation', projectId: 'p1', definition: DEF };
        await assert.rejects(entryDefinitionOf(a), (e) => e.status === 409 || e.code === 'managed_part_not_deployed');
    } finally { restore(); }
});
