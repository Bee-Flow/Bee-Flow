/**
 * Switch collection mode (user feature): switching on a table COLUMN
 * partitions the ROWS per case and fires every matching branch, carrying the
 * matching rows at output.matchesByCase.<caseName>.
 *
 * Run: node --test core/automationRunner/execSwitch.collection.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

mock('../../stores/automationStore', { getAutomation: async () => null, recordRunStep: async () => {} });
mock('../../stores/configStore', {});
mock('../../stores/notificationStore', { createNotification: async () => ({}) });
mock('../../db', { pool: {} });
mock('../aiAgent', { getProviderForModel: async () => null });
mock('../providers', { getAdapter: () => ({}) });
mock('../../automation/codeSandbox', { run: async () => ({}) });

const { execSwitch, runDag } = require('./engine');

const RESULTS = [
    { id: 1, subject: 'Re: Pitchdeck Bee Flow' },
    { id: 2, subject: 'Nextcloud ISV contract' },
    { id: 3, subject: 'Weekly digest' },
    { id: 4, subject: 'Fwd: Nextcloud ISV contract + review' },
];

function state() {
    return { trigger: { output: {} }, steps: { g1: { output: { results: RESULTS } } }, vars: {}, secrets: {}, loop: {}, _templateWarnings: [] };
}

const sw = (extra = {}) => ({
    id: 'sw', type: 'switch',
    expr: 'steps.g1.output.results[*].subject',
    cases: [{ name: 'isv', value: 'ISV' }, { name: 'pitch', value: 'Pitchdeck' }],
    defaultBranch: null,
    ...extra,
});

test('a column expr partitions rows per case (substring match on strings)', async () => {
    const { output } = await execSwitch(sw(), {}, state());
    assert.strictEqual(output.mode, 'collection');
    assert.deepStrictEqual(output.matchesByCase.isv.map(r => r.id), [2, 4]);
    assert.deepStrictEqual(output.matchesByCase.pitch.map(r => r.id), [1]);
    assert.deepStrictEqual(output.matchesByCase.default.map(r => r.id), [3]);
    assert.deepStrictEqual([...output.branches].sort(), ['case:default', 'case:isv', 'case:pitch']);
    assert.deepStrictEqual(output.counts, { isv: 2, pitch: 1, default: 1 });
    assert.strictEqual(output.total, 4);
});

test('defaultBranch absorbs the unmatched rows instead of the default bucket', async () => {
    const { output } = await execSwitch(sw({ defaultBranch: 'isv' }), {}, state());
    assert.deepStrictEqual(output.matchesByCase.isv.map(r => r.id), [2, 4, 3]);
    assert.strictEqual(output.matchesByCase.default, undefined);
});

test('an array of scalars (no column path) uses the elements as rows', async () => {
    const s = state();
    s.steps.g1.output.tags = ['red', 'green', 'red'];
    const { output } = await execSwitch(sw({ expr: 'steps.g1.output.tags[*]', cases: [{ name: 'red', value: 'red' }] }), {}, s);
    // `tags[*]` isn't a column path (no trailing .field) — evaluate() gives
    // the flat array and elements act as row AND value.
    assert.deepStrictEqual(output.matchesByCase.red, ['red', 'red']);
    assert.deepStrictEqual(output.matchesByCase.default, ['green']);
});

test('a scalar expr keeps the original single-branch behaviour untouched', async () => {
    const s = state();
    s.trigger.output.kind = 'vip';
    const { output } = await execSwitch({ id: 'sw', type: 'switch', expr: 'trigger.output.kind', cases: [{ name: 'vip', value: 'vip' }] }, {}, s);
    assert.strictEqual(output.mode, undefined);
    assert.strictEqual(output.branch, 'case:vip');
    assert.strictEqual(output.matchesByCase, undefined);
});

test('runDag follows EVERY active branch and skips empty ones', async () => {
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [
            sw(),
            { id: 'isvStep', type: 'notification', title: 'i', body: 'x', channels: ['notification'] },
            { id: 'pitchStep', type: 'notification', title: 'p', body: 'x', channels: ['notification'] },
            { id: 'otherStep', type: 'notification', title: 'o', body: 'x', channels: ['notification'] },
            { id: 'emptyStep', type: 'notification', title: 'e', body: 'x', channels: ['notification'] },
        ],
        edges: [
            { from: 'trg', to: 'sw' },
            { from: 'sw', to: 'isvStep', label: 'case:isv', caseName: 'isv' },
            { from: 'sw', to: 'pitchStep', label: 'case:pitch', caseName: 'pitch' },
            { from: 'sw', to: 'otherStep', label: 'case:default', caseName: 'default' },
        ],
    };
    // Give the switch an extra case with no matches, wired to emptyStep.
    def.steps[0] = sw({ cases: [...sw().cases, { name: 'ghost', value: 'zzz-no-match' }] });
    def.edges.push({ from: 'sw', to: 'emptyStep', label: 'case:ghost', caseName: 'ghost' });

    const ran = [];
    const dispatch = async (step, ctx, runState, mode) => {
        if (step.type === 'switch') return { ...(await execSwitch(step, ctx, runState, mode)), startedAt: new Date().toISOString() };
        ran.push(step.id);
        return { output: { ranId: step.id }, startedAt: new Date().toISOString(), inputSnapshot: null };
    };
    await runDag(def, {}, state(), 'live', dispatch, { recordSteps: false });
    assert.deepStrictEqual(ran.sort(), ['isvStep', 'otherStep', 'pitchStep'], 'all matching branches fire; the empty ghost branch does not');
});
