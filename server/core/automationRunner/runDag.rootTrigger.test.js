/**
 * Unit tests for runDag's `rootStepId` option — lets a caller seed the walk
 * from a SPECIFIC trigger id (a webhook/app-event dispatch targeting one of
 * definition.triggers[], the scoped multi-trigger slice — see
 * automation/validate.js's `triggers[]` rules) instead of the primary
 * `def.trigger.id`. Every existing call site omits it and must see
 * byte-identical behavior (regression-critical).
 *
 * Heavy deps are pre-mocked via the require cache (same approach as
 * automationRunner.flowlets.test.js).
 *
 * Run: node --test core/automationRunner/runDag.rootTrigger.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const recorded = [];
mock('../../stores/automationStore', { getAutomation: async () => null, recordRunStep: async (row) => { recorded.push(row); } });
mock('../../stores/configStore', {});
mock('../../stores/notificationStore', {});
mock('../../db', { pool: {} });
mock('../aiAgent', { getProviderForModel: async () => null });
mock('../providers', { getAdapter: () => ({}) });
mock('../../automation/codeSandbox', { run: async () => ({}) });

const { runDag } = require('../automationRunner');

const dispatch = async (step) => ({ output: { ranId: step.id }, startedAt: new Date().toISOString(), inputSnapshot: null });

function baseState() {
    return { trigger: { output: {} }, steps: {}, vars: {}, secrets: {}, loop: {}, _templateWarnings: [] };
}

test('default (no rootStepId) seeds from def.trigger.id — unchanged behavior', async () => {
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [{ id: 'n1', type: 'notification', title: 'hi' }],
        edges: [{ from: 'trg', to: 'n1' }],
    };
    const result = await runDag(def, {}, baseState(), 'live', dispatch, { recordSteps: false });
    assert.deepStrictEqual(result.lastOutput, { ranId: 'n1' });
});

test('rootStepId seeds the walk from a secondary trigger id instead', async () => {
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [
            { id: 'primaryOnly', type: 'notification', title: 'a' },
            { id: 'viaWebhook', type: 'notification', title: 'b' },
        ],
        edges: [{ from: 'trg', to: 'primaryOnly' }, { from: 'trg2', to: 'viaWebhook' }],
        triggers: [{ id: 'trg2', kind: 'webhook' }],
    };
    const result = await runDag(def, {}, baseState(), 'live', dispatch, { recordSteps: false, rootStepId: 'trg2' });
    // Only the secondary trigger's own downstream step ran — the primary
    // trigger's branch was never seeded/visited.
    assert.deepStrictEqual(result.lastOutput, { ranId: 'viaWebhook' });
});

test('a falsy rootStepId (e.g. "") is treated as "not provided" — falls back to def.trigger.id', async () => {
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [{ id: 'n1', type: 'notification', title: 'hi' }],
        edges: [{ from: 'trg', to: 'n1' }],
    };
    const result = await runDag(def, {}, baseState(), 'live', dispatch, { recordSteps: false, rootStepId: '' });
    assert.deepStrictEqual(result.lastOutput, { ranId: 'n1' });
});

test('rootStepId pointing at a genuinely unknown id dispatches nothing (not in stepById)', async () => {
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [{ id: 'n1', type: 'notification', title: 'hi' }],
        edges: [{ from: 'trg', to: 'n1' }],
    };
    const result = await runDag(def, {}, baseState(), 'live', dispatch, { recordSteps: false, rootStepId: 'nonexistent' });
    assert.strictEqual(result.lastOutput, null);
});

test('no trigger anywhere (and no rootStepId) throws', async () => {
    const def = { trigger: null, steps: [], edges: [] };
    await assert.rejects(
        () => runDag(def, {}, baseState(), 'live', dispatch, { recordSteps: false }),
        /no trigger/i,
    );
});

test('an AI step\'s withheld tools are recorded on its run-step row, with their reasons (handoff 5)', async () => {
    recorded.length = 0;
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [{ id: 'ai1', type: 'ai_step', prompt: 'p' }, { id: 'n1', type: 'notification', title: 'hi' }],
        edges: [{ from: 'trg', to: 'ai1' }, { from: 'ai1', to: 'n1' }],
    };
    const dispatchAi = async (step) => (step.id === 'ai1'
        ? { output: 'x', startedAt: new Date().toISOString(), inputSnapshot: null, toolsWithheld: ['gmail_compose', 'automation_r1', 'gmail_compose'], toolsWithheldReasons: { gmail_compose: 'confirm' } }
        : dispatch(step));
    await runDag(def, { runId: 'run1' }, baseState(), 'live', dispatchAi, { recordSteps: true });
    const done = recorded.filter((r) => r.status === 'success');
    const ai = done.find((r) => r.stepId === 'ai1');
    assert.deepStrictEqual(ai.toolsWithheld, [
        { name: 'gmail_compose', reason: 'confirm' },
        { name: 'automation_r1', reason: 'unavailable' },
    ]);
    assert.strictEqual(done.find((r) => r.stepId === 'n1').toolsWithheld, null);
});
