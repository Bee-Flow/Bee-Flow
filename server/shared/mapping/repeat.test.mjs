import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toggleRepeat, toggleRepeatOff, rebaseLoopRefs, mapStepPicks } from './repeat.mjs';

const ORDERS = { root: 'steps', id: 'get', path: ['orders'] };
const pick = (path, take = 'all', as = 'text') => ({ kind: 'pick', v: 1, from: { root: 'steps', id: 'get', path }, take, as });

function step() {
    return {
        id: 'mail', type: 'notification',
        title: { kind: 'compose', v: 1, parts: ['Order ', { from: { root: 'steps', id: 'get', path: ['orders', 'id'] }, take: 'all', as: 'text' }] },
        body: 'x',
        inputs: {
            to: pick(['orders', 'email'], 'one', 'native'),
            n: pick(['orders'], 'count', 'native'),
            first: pick(['orders', 'id'], 'first', 'native'),
            other: { kind: 'pick', v: 1, from: { root: 'trigger', path: ['x'] }, take: 'all', as: 'list' },
            data: { kind: 'literal', value: pick(['orders', 'email'], 'one', 'native') },
        },
    };
}

test('toggleRepeat: picks of that list read the current item; first/last/count keep meaning the list', () => {
    const before = step();
    const { step: out } = toggleRepeat(before, ORDERS);
    assert.deepStrictEqual(out.repeat, { over: ORDERS, max: 100 });
    assert.equal(out.inputs.to.take, 'each');
    assert.equal(out.title.parts[1].take, 'each');
    assert.equal(out.inputs.n.take, 'count');
    assert.equal(out.inputs.first.take, 'first');
    assert.equal(out.inputs.other.take, 'all', 'another source is untouched');
    assert.equal(out.inputs.data.value.take, 'one', 'a literal is data, not a pick');
    assert.deepStrictEqual(before, step(), 'the step handed in is not changed');
    assert.equal(toggleRepeat(before, ORDERS, { max: 5000 }).step.repeat.max, 1000);
});

test('toggleRepeat refuses a second list, a legacy forEach and a bad Source', () => {
    const { step: repeated } = toggleRepeat(step(), ORDERS);
    assert.deepStrictEqual(toggleRepeat(repeated, { root: 'steps', id: 'get', path: ['other'] }), { error: 'already_repeating' });
    assert.ok(toggleRepeat(repeated, ORDERS).step, 'the same list again is fine');
    assert.deepStrictEqual(toggleRepeat({ ...step(), forEach: { overRef: 'x', itemVar: 'i' } }, ORDERS), { error: 'legacy_for_each' });
    assert.deepStrictEqual(toggleRepeat(step(), { root: 'steps', path: [] }), { error: 'invalid_source' });
});

test('toggleRepeatOff: each becomes all again, and the repeat goes', () => {
    const { step: repeated } = toggleRepeat(step(), ORDERS);
    const { step: off } = toggleRepeatOff(repeated);
    assert.equal(off.repeat, undefined);
    assert.equal(off.inputs.to.take, 'all');
    assert.equal(off.title.parts[1].take, 'all');
    assert.equal(off.inputs.first.take, 'first');
});

test('mapStepPicks reaches every binding and text site, nothing else', () => {
    const seen = [];
    mapStepPicks({ ...step(), pinnedOutput: pick(['pinned']) }, (p) => { seen.push(p.from.path.join('.')); return p; });
    assert.deepStrictEqual(seen.sort(), ['orders', 'orders.email', 'orders.id', 'orders.id', 'x'], 'a pinned sample and a literal are data');
});

test('rebaseLoopRefs: a forEach with plain loop refs becomes a repeat with each picks', () => {
    const legacy = {
        id: 'mail', type: 'integration_action', tool: 'gmail_send',
        forEach: { overRef: 'steps.get.output.orders', itemVar: 'row', maxIterations: 50 },
        inputs: { to: { kind: 'ref', path: 'loop.row.klant.email' }, subject: { kind: 'literal', value: 'loop.row is data' }, x: { kind: 'ref', path: 'steps.a.output.b' } },
    };
    const { step: out } = rebaseLoopRefs(legacy);
    assert.equal(out.forEach, undefined);
    assert.deepStrictEqual(out.repeat, { over: ORDERS, max: 50 });
    assert.deepStrictEqual(out.inputs.to, { kind: 'pick', v: 1, from: { root: 'steps', id: 'get', path: ['orders', 'klant', 'email'] }, take: 'each', as: 'native' });
    assert.deepStrictEqual(out.inputs.subject, legacy.inputs.subject);
    assert.deepStrictEqual(out.inputs.x, legacy.inputs.x);
});

test('rebaseLoopRefs refuses what would not read the same', () => {
    const base = { type: 'integration_action', forEach: { overRef: 'steps.get.output.orders', itemVar: 'row' } };
    assert.deepStrictEqual(rebaseLoopRefs({ ...base, inputs: { t: { kind: 'template', value: 'Hi {{loop.row.name}}' } } }), { refused: ['loop_in_template'] });
    assert.deepStrictEqual(rebaseLoopRefs({ ...base, inputs: { e: { kind: 'expr', value: 'upper(loop.row.name)' } } }), { refused: ['loop_in_expr'] });
    assert.deepStrictEqual(rebaseLoopRefs({ ...base, inputs: { i: { kind: 'ref', path: 'loop._index' } } }), { refused: ['loop_index'] });
    assert.deepStrictEqual(rebaseLoopRefs({ ...base, type: 'notification', body: 'Hoi {{loop.row.name}}' }), { refused: ['loop_in_text'] });
    assert.deepStrictEqual(rebaseLoopRefs({ ...base, forEach: { overRef: 'secrets.x', itemVar: 'row' } }), { refused: ['over_unreadable'] });
    assert.deepStrictEqual(rebaseLoopRefs({ type: 'set' }), { refused: ['no_for_each'] });
});
