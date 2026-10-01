/**
 * loops.mjs: a Loop seen from downstream (node-audit C23, the user-reported
 * trap), and the element-shape inference a Loop, an "Each item" pill and a
 * forEach all rest on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeUpstreamGroups, inferLoopItemSample } from './index.mjs';

const catalog = {
    apps: [{ actions: [{ name: 'gmail_search', outputSample: { results: [{ subject: 'Re: hi', from: 'a@b.c' }] } }] }],
    triggerOutputs: { __manual: { fields: [], sample: {} } },
};
const def = {
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps: [
        { id: 'g1', type: 'integration_action', tool: 'gmail_search', inputs: {} },
        { id: 'lp', type: 'loop', overRef: 'steps.g1.output.results', itemVar: 'item', maxIterations: 100, body: [] },
        { id: 'after', type: 'notification', title: 't' },
    ],
    edges: [{ from: 'trg', to: 'g1' }, { from: 'g1', to: 'lp' }, { from: 'lp', to: 'after' }],
};

test('a Loop offers the runtime envelope downstream, rooted at steps.<id>.output', () => {
    const g = computeUpstreamGroups(def, 'after', catalog).find(x => x.id === 'lp');
    assert.equal(g.basePath, 'steps.lp.output');
    const paths = g.fields.map(f => f.path);
    assert.ok(paths.includes('steps.lp.output.iterations'));
    assert.ok(paths.includes('steps.lp.output.results'));
});

test('a Loop offers element fields through the [*] flatten, not the dead loop.<itemVar> scope', () => {
    const paths = computeUpstreamGroups(def, 'after', catalog).find(x => x.id === 'lp').fields.map(f => f.path);
    assert.ok(paths.includes('steps.lp.output.results[*].item.subject'));
    assert.ok(paths.every(p => !p.startsWith('loop.')));
});

test('inferLoopItemSample resolves from the sample root even with no tool outputs at all', () => {
    const sampleRoot = { steps: { B: { output: { items: [{ email: 'x' }] } } } };
    assert.deepStrictEqual(inferLoopItemSample('steps.B.output.items', { steps: [] }, new Map(), sampleRoot), { email: 'x' });
});

test('inferLoopItemSample is null when neither the sample root nor the tool map resolves', () => {
    assert.equal(inferLoopItemSample('steps.B.output.items', { steps: [] }, new Map()), null);
    assert.equal(inferLoopItemSample('steps.B.output.items', { steps: [] }, new Map(), { steps: {} }), null);
});
