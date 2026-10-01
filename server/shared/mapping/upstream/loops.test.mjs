/**
 * loops.mjs: a Loop seen from downstream (node-audit C23, the user-reported
 * trap), and the element-shape inference a Loop, an "Each item" pill and a
 * forEach all rest on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeRepeatItemGroup, computeUpstreamGroups, currentItemNoun, inferLoopItemSample } from './index.mjs';

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

// ── The current item of a step that runs once per item ──────────────────

const orders = {
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps: [
        { id: 'g1', type: 'integration_action', tool: 'gmail_search', inputs: {} },
        { id: 'mail', type: 'notification', title: 't', repeat: { over: { root: 'steps', id: 'g1', path: ['orderregels'] }, max: 100 } },
    ],
    edges: [{ from: 'trg', to: 'g1' }, { from: 'g1', to: 'mail' }],
};
const root = { steps: { g1: { output: { orderregels: [{ email: 'a@b.c', product: { name: 'Stoel' } }, { email: 'd@e.f' }] } } } };

test('a repeating step offers its current item, named after the list, as each picks', () => {
    const g = computeRepeatItemGroup(orders, 'mail', catalog, root);
    assert.equal(g.label, 'Current orderregel');
    assert.equal(g.id, 'mail__repeat');
    assert.deepStrictEqual(g.currentItem, { take: 'each', over: { root: 'steps', id: 'g1', path: ['orderregels'] }, noun: 'Orderregel' });
    const email = g.fields.find(f => f.key === 'email');
    assert.deepStrictEqual(email.source, { root: 'steps', id: 'g1', path: ['orderregels', 'email'] });
    assert.equal(email.take, 'each');
    assert.equal(email.sample, 'a@b.c');
    assert.deepStrictEqual(email.labelParts, [{ key: 'email', text: 'Email' }]);
    const name = g.fields.find(f => f.key === 'product').children.find(f => f.key === 'name');
    assert.deepStrictEqual(name.source.path, ['orderregels', 'product', 'name']);
    assert.equal(name.take, 'each');
});

test('the current item group is not one of the upstream groups the string pickers read', () => {
    assert.ok(computeUpstreamGroups(orders, 'mail', catalog).every(g => !g.currentItem));
});

test('a repeat over a list of plain values offers the item itself', () => {
    const def = { ...orders, steps: [orders.steps[0], { ...orders.steps[1], repeat: { over: { root: 'steps', id: 'g1', path: ['tags'] } } }] };
    const g = computeRepeatItemGroup(def, 'mail', catalog, { steps: { g1: { output: { tags: ['rood', 'blauw'] } } } });
    assert.equal(g.label, 'Current tag');
    assert.equal(g.fields.length, 1);
    assert.deepStrictEqual(g.fields[0].source, { root: 'steps', id: 'g1', path: ['tags'] });
    assert.equal(g.fields[0].take, 'each');
    assert.equal(g.fields[0].sample, 'rood');
});

test('the current item group is null without a valid repeat, and words a nameless list plainly', () => {
    assert.equal(computeRepeatItemGroup(orders, 'g1', catalog, root), null);
    const bad = { ...orders, steps: [orders.steps[0], { ...orders.steps[1], repeat: { over: { root: 'nope', path: [] } } }] };
    assert.equal(computeRepeatItemGroup(bad, 'mail', catalog, root), null);
    const whole = { ...orders, steps: [orders.steps[0], { ...orders.steps[1], repeat: { over: { root: 'steps', id: 'g1', path: [] } } }] };
    assert.equal(computeRepeatItemGroup(whole, 'mail', catalog, { steps: { g1: { output: [{ a: 1 }] } } }).label, 'Current item');
});

test('the current item falls back to the catalog sample of the list', () => {
    const def = { ...orders, steps: [orders.steps[0], { ...orders.steps[1], repeat: { over: { root: 'steps', id: 'g1', path: ['results'] } } }] };
    const g = computeRepeatItemGroup(def, 'mail', catalog, null);
    assert.deepStrictEqual(g.fields.map(f => f.key), ['subject', 'from']);
    assert.equal(g.label, 'Current result');
});

test('a forEach step\'s current item is named after its list and reads loop.<itemVar>', () => {
    const def = { ...orders, steps: [orders.steps[0], { id: 'mail', type: 'notification', title: 't', forEach: { overRef: 'steps.g1.output.results', itemVar: 'mailtje' } }] };
    const g = computeUpstreamGroups(def, 'mail', catalog).find(x => x.currentItem);
    assert.equal(g.label, 'Current result');
    assert.deepStrictEqual(g.currentItem, { take: 'loop', itemVar: 'mailtje', noun: 'Result' });
    assert.ok(g.fields.every(f => f.path.startsWith('loop.mailtje.') && !f.take));
});

test('currentItemNoun names the item only for a value that reads it', () => {
    const each = { take: 'each', over: { root: 'steps', id: 'g1', path: ['orderregels'] }, noun: 'Orderregel' };
    assert.equal(currentItemNoun({ root: 'steps', id: 'g1', path: ['orderregels', 'email'] }, each), 'Orderregel');
    assert.equal(currentItemNoun({ root: 'steps', id: 'g1', path: ['other'] }, each), null);
    const loop = { take: 'loop', itemVar: 'row', noun: 'Row' };
    assert.equal(currentItemNoun({ root: 'loop', id: 'row', path: ['email'] }, loop), 'Row');
    assert.equal(currentItemNoun({ root: 'loop', id: 'other', path: ['email'] }, loop), null);
    assert.equal(currentItemNoun({ root: 'steps', id: 'g1', path: [] }, null), null);
});
