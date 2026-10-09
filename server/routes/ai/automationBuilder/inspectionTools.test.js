const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspect, maskedRunValues } = require('./inspectionTools');
const { tokenizeText } = require('../../../core/privacy/piiDetection/tokenizer');

test('run inspection masks personal values and leaves useful non-personal numbers intact', async () => {
    const values = { email: 'person@example.test', amount: 1234.56, lines: [{ contact: 'person@example.test' }] };
    const result = await maskedRunValues(values, { tokenizeText, detectPii: async () => ({ hasPii: true, entities: [{ text: 'person@example.test', label: 'Email', score: 1 }] }) });
    assert.equal(result.valuesAvailable, true);
    assert.equal(result.values.amount, 1234.56);
    assert.ok(!JSON.stringify(result).includes('person@example.test'));
    assert.equal(result.values.email, result.values.lines[0].contact);
});

test('absent, degraded or failed scanners return only shapes, never raw values', async () => {
    for (const detectPii of [async () => null, async () => ({ degraded: true }), async () => { throw new Error('unavailable'); }]) {
        const result = await maskedRunValues({ private: 'person@example.test', identifier: 123456789 }, { detectPii, tokenizeText });
        assert.equal(result.valuesAvailable, false);
        assert.ok(!JSON.stringify(result).includes('person@example.test'));
        assert.ok(!JSON.stringify(result).includes('123456789'));
    }
});

test('inspection only reads runs belonging to the automation owner', async () => {
    let readRun = false;
    const result = await inspect('builder_inspect_run', { stepId: 's1' }, { automationId: 'a1', userId: 'owner', def: { steps: [{ id: 's1' }] } }, {
        store: { getAutomation: async () => ({ userId: 'someoneElse' }), listRunsForAutomation: async () => { readRun = true; } }, pii: {},
    });
    assert.match(result.error, /owner/);
    assert.equal(readRun, false);
});

// A code step's outputSchema describes what its code RETURNS, which runs read
// under output.result; listed bare, the model bound steps.<code>.output.<field>.
test('mapping inspection says where a code step\'s returned fields are read', async () => {
    const def = { trigger: { id: 'trg' }, steps: [{ id: 'fmt', type: 'code', outputSchema: { count: 'number' } }, { id: 'ai', type: 'ai_step', outputSchema: { x: 'string' } }, { id: 'out', type: 'set' }] };
    const r = await inspect('builder_inspect_mapping', { stepId: 'out' }, { def }, { store: {}, pii: {} });
    const byId = Object.fromEntries(r.sources.map(s => [s.id, s]));
    assert.equal(byId.fmt.readAt, 'steps.fmt.output.result');
    assert.equal(byId.ai.readAt, undefined);
});

// A full run records a flowlet's steps under the step that called it.
test('run inspection inside a flowlet finds the step recorded under its caller', async () => {
    const def = { steps: [], layers: { tickets: { trigger: { id: 'trg' }, steps: [{ id: 'fmt', type: 'code' }] } } };
    const store = {
        getAutomation: async () => ({ userId: 'owner' }),
        listRunsForAutomation: async () => ({ runs: [{ id: 'run1' }] }),
        getRunSteps: async () => [{ stepId: 'cl1', status: 'success', output: {} }, { stepId: 'cl1/fmt', status: 'success', output: { result: { count: 15 } } }],
    };
    const r = await inspect('builder_inspect_run', { stepId: 'fmt', scope: 'tickets' }, { automationId: 'a1', userId: 'owner', def }, {
        store, pii: { detectPii: async () => ({ hasPii: false, entities: [] }), tokenizeText },
    });
    assert.equal(r.status, 'success');
    assert.deepEqual(r.values.output, { result: { count: 15 } });
});
