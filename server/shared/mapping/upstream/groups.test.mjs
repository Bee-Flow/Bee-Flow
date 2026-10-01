/**
 * groups.mjs computeLoopBodyGroups: what ONE step inside a Loop's body (the
 * inspector's step-list editor) can bind to. The canvas side of the same
 * question (an expanded loop) is agent-hub's, in upstream.loopBody.test.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeLoopBodyGroups } from './index.mjs';

const previewSample = { trigger: { output: { items: [{ email: 'a@b.c', amount: 5 }] } } };
const loopStep = { id: 'lp', overRef: 'trigger.output.items', itemVar: 'row', batchSize: 1, body: [] };
const outerGroups = [{ id: 'trg', label: 'Trigger', kind: 'trigger', basePath: 'trigger.output', sample: {}, fields: [] }];
const bodyGroups = (step, index) => computeLoopBodyGroups(step, index, outerGroups, previewSample, null, { steps: [] });

test('adds a "current item" group with the resolved element sample and its fields', () => {
    const groups = bodyGroups(loopStep, 0);
    assert.equal(groups[0], outerGroups[0], 'outer groups come first, unchanged');
    const itemGroup = groups.find(g => g.id === '__loop_item');
    assert.equal(itemGroup.basePath, 'loop.row');
    assert.deepStrictEqual(itemGroup.sample, { email: 'a@b.c', amount: 5 });
    assert.deepStrictEqual(itemGroup.fields.map(f => f.key), ['email', 'amount']);
});

test('a batch (batchSize > 1) exposes an array sample with NO per-field suggestions', () => {
    const itemGroup = bodyGroups({ ...loopStep, batchSize: 3 }, 0).find(g => g.id === '__loop_item');
    assert.deepStrictEqual(itemGroup.sample, [{ email: 'a@b.c', amount: 5 }]);
    assert.deepStrictEqual(itemGroup.fields, []);
    assert.match(itemGroup.label, /batch/i);
});

test('a later body step sees the output shape of earlier body steps', () => {
    const withBody = {
        ...loopStep,
        body: [{ id: 'set1', type: 'set', label: 'Build record', fields: { total: { kind: 'literal', value: 0 } } }],
    };
    const prior = bodyGroups(withBody, 1).find(g => g.id === 'set1');
    assert.equal(prior.basePath, 'steps.set1.output');
    assert.deepStrictEqual(prior.fields.map(f => f.key), ['total']);
});

test('body step 0 sees NO prior-body groups (nothing has run yet)', () => {
    const withBody = { ...loopStep, body: [{ id: 'set1', type: 'set', fields: {} }] };
    assert.equal(bodyGroups(withBody, 0).find(g => g.id === 'set1'), undefined);
});

test('an unresolvable overRef falls back to an empty item sample (no throw)', () => {
    const itemGroup = bodyGroups({ ...loopStep, overRef: 'trigger.output.nope' }, 0).find(g => g.id === '__loop_item');
    assert.deepStrictEqual(itemGroup.sample, {});
    assert.deepStrictEqual(itemGroup.fields, []);
});
