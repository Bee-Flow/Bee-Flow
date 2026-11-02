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

test('run inspection skips a run that used its starter\'s own connections: the owner\'s builder never reads the starter\'s values', async () => {
    const callerRun = { id: 'run-caller', startedByUserId: 'someone', connectionsMode: 'caller' };
    const ownRun = { id: 'run-own', startedByUserId: 'owner', connectionsMode: null };
    const read = [];
    const store = {
        getAutomation: async () => ({ userId: 'owner' }),
        listRunsForAutomation: async () => ({ runs: [callerRun, ownRun] }),
        getRunSteps: async (id) => { read.push(id); return [{ stepId: 's1', status: 'success', output: { v: 1 } }]; },
    };
    await inspect('builder_inspect_run', { stepId: 's1' }, { automationId: 'a1', userId: 'owner', def: { steps: [{ id: 's1' }] } }, { store, pii: { detectPii: async () => null, tokenizeText } });
    assert.deepEqual(read, ['run-own']);
    read.length = 0;
    store.listRunsForAutomation = async () => ({ runs: [callerRun] });
    const only = await inspect('builder_inspect_run', { stepId: 's1' }, { automationId: 'a1', userId: 'owner', def: { steps: [{ id: 's1' }] } }, { store, pii: {} });
    assert.deepEqual(read, []);
    assert.match(only.error, /no runs/);
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

// BFSF-487: the key names are the paths the model has to bind.
const PII_NONE = { detectPii: async () => ({ hasPii: false, entities: [] }), tokenizeText };
const forEachOutput = (n) => ({ results: Array.from({ length: n }, (_, i) => ({
    index: i, status: 'success',
    item: { id: `sheet-${i}`, name: `Sheet number ${i}`, owner: 'someone', notes: 'x'.repeat(40) },
    output: { items: [{ title: `September ${i}`, gid: i }, { title: `Other ${i}`, gid: i + 1 }] },
})) });

function storeWith(row, run = { id: 'r1', mode: 'dry_run', isTest: true, startedAt: '2026-11-01T10:00:00.000Z', status: 'success' }) {
    return {
        getAutomation: async () => ({ userId: 'owner' }),
        listRunsForAutomation: async () => ({ runs: [run] }),
        getRunSteps: async () => [{ stepId: 's1', status: 'success', ...row }],
    };
}
const WRAP = { automationId: 'a1', userId: 'owner', def: { steps: [{ id: 's1' }] } };

test('an output over the limit keeps its key names and shortens lists instead of renaming keys', async () => {
    const output = forEachOutput(200);
    assert.ok(JSON.stringify(output).length > 24000);
    const r = await inspect('builder_inspect_run', { stepId: 's1' }, WRAP, { store: storeWith({ output }), pii: PII_NONE });
    assert.equal(r.valuesAvailable, true);
    const text = JSON.stringify(r);
    assert.ok(text.includes('"title"'));
    assert.ok(!text.includes('field1'));
    assert.ok(r.previewCut && Object.keys(r.previewCut).length > 0);
    assert.ok(text.length < 24000, `result is ${text.length} chars`);
});

test('with the guard degraded the model gets keys and types in path grammar, never values', async () => {
    const output = { results: [{ output: { items: [{ title: 'secret-title-x' }] } }] };
    const { shapeHintOf } = require('../../../automation/shapeCache');
    for (const detectPii of [async () => ({ degraded: true }), async () => null]) {
        const r = await inspect('builder_inspect_run', { stepId: 's1' }, WRAP, { store: storeWith({ output }), pii: { detectPii, tokenizeText } });
        assert.equal(r.valuesAvailable, false);
        assert.equal(r.values, shapeHintOf({ input: null, output }));
        assert.match(r.values, /results\[\*\]/);
        assert.match(r.values, /title/);
        assert.ok(!JSON.stringify(r).includes('secret-title-x'));
        assert.ok(!JSON.stringify(r).includes('field1'));
    }
});

test('the result says which run it comes from and whether the output was made up by a dry run', async () => {
    const r = await inspect('builder_inspect_run', { stepId: 's1' }, WRAP, { store: storeWith({ output: { a: 1, _dryRunSynthesised: true } }), pii: PII_NONE });
    assert.deepEqual(r.run, { id: 'r1', mode: 'dry_run', isTest: true, startedAt: '2026-11-01T10:00:00.000Z', status: 'success' });
    assert.equal(r.synthesised, true);
    const plain = await inspect('builder_inspect_run', { stepId: 's1' }, WRAP, { store: storeWith({ output: { a: 1 } }, { id: 'r2', mode: 'live', isTest: false }), pii: PII_NONE });
    assert.equal(plain.run.mode, 'live');
    assert.equal(plain.synthesised, undefined);
    const other = await inspect('builder_inspect_run', { stepId: 's1' }, WRAP, { store: storeWith({ output: { dryRunSynthesised: true } }), pii: PII_NONE });
    assert.equal(other.synthesised, true);
});

test('an output stored as a preview is read from its full copy', async () => {
    const { fullOutputRefOf } = require('../../../core/automationModel/payloadTruncation');
    const sentinel = { __truncated__: true, headSample: 'cut', preview: { stale: true }, fullOutputRef: { runId: 'r1', stepId: 's1', attempts: 1 } };
    assert.ok(fullOutputRefOf(sentinel), 'the fixture is a sentinel with a kept copy');
    const runFullOutputs = require('../../../stores/automationStore/runFullOutputs');
    const original = runFullOutputs.getRunFullOutput;
    runFullOutputs.getRunFullOutput = async () => ({ results: [{ output: { items: [{ title: 'from the full copy' }] } }] });
    try {
        const r = await inspect('builder_inspect_run', { stepId: 's1' }, WRAP, { store: storeWith({ output: sentinel }), pii: PII_NONE });
        assert.equal(r.values.output.results[0].output.items[0].title, 'from the full copy');
        assert.ok(!JSON.stringify(r.values).includes('stale'));
    } finally { runFullOutputs.getRunFullOutput = original; }
});

test('paths lists every list with its fields as ready-to-bind [*] paths', async () => {
    const r = await inspect('builder_inspect_run', { stepId: 's1' }, WRAP, { store: storeWith({ output: forEachOutput(3) }), pii: PII_NONE });
    assert.ok(r.paths.includes('steps.s1.output.results'));
    assert.ok(r.paths.includes('steps.s1.output.results[*].output.items'));
    assert.ok(r.paths.includes('steps.s1.output.results[*].output.items[*].title'));
    assert.ok(!r.paths.some(p => /results\[0\]/.test(p)));
});

test('a personal key over the limit is masked in previewCut as well as in the values', async () => {
    const values = { output: { 'person@example.test': Array.from({ length: 400 }, (_, i) => ({ n: i, text: 'y'.repeat(60) })) } };
    const detectPii = async () => ({ hasPii: true, entities: [{ text: 'person@example.test', label: 'Email', score: 1 }] });
    const r = await maskedRunValues(values, { detectPii, tokenizeText });
    assert.equal(r.valuesAvailable, true);
    assert.ok(r.previewCut && Object.keys(r.previewCut).length > 0);
    assert.ok(!JSON.stringify(r).includes('person@example.test'));
});
