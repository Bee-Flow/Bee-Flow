import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toggleRepeat, toggleRepeatOff, rebaseLoopRefs, mapStepPicks, stopForEach, renameItemVar } from './repeat.mjs';

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

test('toggleRepeat lifts a legacy ref of every item to an each pick, and counts what reads the item', () => {
    const legacy = {
        type: 'integration_action',
        inputs: {
            to: { kind: 'ref', path: 'steps.get.output.orders[*].klant.email' },
            all: { kind: 'ref', path: 'steps.get.output.orders' },
            first: { kind: 'ref', path: 'steps.get.output.orders[0].email' },
            other: { kind: 'ref', path: 'steps.other.output.orders[*].email' },
        },
    };
    const res = toggleRepeat(legacy, ORDERS);
    assert.deepStrictEqual(res.step.inputs.to, { kind: 'pick', v: 1, from: { root: 'steps', id: 'get', path: ['orders', 'klant', 'email'] }, take: 'each', as: 'native' });
    assert.deepStrictEqual(res.step.inputs.all, legacy.inputs.all, 'the list itself is not per item');
    assert.deepStrictEqual(res.step.inputs.first, legacy.inputs.first, 'an index is not per item');
    assert.deepStrictEqual(res.step.inputs.other, legacy.inputs.other);
    assert.equal(res.each, 1);
    assert.equal(toggleRepeat({ type: 'notification', body: 'x' }, ORDERS).each, 0, 'nothing reads the item: the step would do the same thing N times');
});

test('regression: switching per item off after choosing it leaves no fan-out behind (each → all, repeat gone)', () => {
    const { step: on } = toggleRepeat({ type: 'integration_action', inputs: { to: { kind: 'ref', path: 'steps.get.output.orders[*].email' } } }, ORDERS);
    const { step: off } = toggleRepeatOff(on);
    assert.equal(off.repeat, undefined);
    assert.equal(off.forEach, undefined);
    assert.deepStrictEqual(off.inputs.to, { kind: 'pick', v: 1, from: { root: 'steps', id: 'get', path: ['orders', 'email'] }, take: 'all', as: 'native' });
});

test('regression: a second, different list is refused instead of re-pointing the first field', () => {
    const { step: on } = toggleRepeat({ type: 'integration_action', inputs: { a: pick(['orders', 'email'], 'one', 'native') } }, ORDERS);
    const res = toggleRepeat(on, { root: 'steps', id: 'files', path: ['items'] });
    assert.deepStrictEqual(res, { error: 'already_repeating' });
    assert.equal(on.inputs.a.take, 'each', 'the first field still reads its own item');
});

test('stopForEach: a legacy forEach off reads the whole list again', () => {
    const legacy = {
        type: 'integration_action',
        forEach: { overRef: 'steps.get.output.orders', itemVar: 'row' },
        inputs: { to: { kind: 'ref', path: 'loop.row.email' } },
    };
    const { step: off, orphaned } = stopForEach(legacy);
    assert.equal(orphaned, undefined);
    assert.equal(off.forEach, undefined);
    assert.equal(off.repeat, undefined);
    assert.deepStrictEqual(off.inputs.to, { kind: 'pick', v: 1, from: { root: 'steps', id: 'get', path: ['orders', 'email'] }, take: 'all', as: 'native' });
    const { step: off2, orphaned: why } = stopForEach({ ...legacy, inputs: { t: { kind: 'template', value: 'Hi {{loop.row.name}}' } } });
    assert.equal(off2.forEach, undefined);
    assert.deepStrictEqual(why, ['loop_in_template']);
});

test('regression: renaming a forEach item rewrites every loop.<old> read of it', () => {
    const step = {
        type: 'notification',
        forEach: { overRef: 'loop.row.lines', itemVar: 'row' },
        title: 'Order {{ loop.row.id }} for {{loop["row"].name}}',
        body: { kind: 'compose', v: 1, parts: ['Hoi ', { from: { root: 'loop', id: 'row', path: ['name'] }, take: 'one', as: 'text' }] },
        inputs: {
            a: { kind: 'ref', path: 'loop.row.email' },
            b: { kind: 'expr', value: 'upper(loop.row.name) + "loop.row"' },
            c: { kind: 'template', value: '{{loop.rowan.x}} {{loop.row}}' },
            d: { kind: 'literal', value: 'loop.row.email' },
            e: { kind: 'ref', path: 'loop._index' },
        },
    };
    const { step: out } = renameItemVar(step, 'order');
    assert.deepStrictEqual(out.forEach, { overRef: 'loop.row.lines', itemVar: 'order' }, 'the list is read outside the item');
    assert.equal(out.title, 'Order {{ loop.order.id }} for {{loop.order.name}}');
    assert.deepStrictEqual(out.body.parts[1].from, { root: 'loop', id: 'order', path: ['name'] });
    assert.equal(out.inputs.a.path, 'loop.order.email');
    assert.equal(out.inputs.b.value, 'upper(loop.order.name) + "loop.row"', 'quoted text is data');
    assert.equal(out.inputs.c.value, '{{loop.rowan.x}} {{loop.order}}', 'another name that starts the same is not it');
    assert.equal(out.inputs.d.value, 'loop.row.email', 'a literal is data');
    assert.equal(out.inputs.e.path, 'loop._index');
    assert.deepStrictEqual(renameItemVar(step, '1x'), { error: 'invalid_name' });
    assert.deepStrictEqual(renameItemVar({ type: 'set' }, 'x'), { error: 'no_item' });
});

test('regression: renaming a loop item rewrites its body, minding a nested rebinding', () => {
    const loop = {
        type: 'loop', overRef: 'loop.item.outer', itemVar: 'item',
        body: [
            { type: 'integration_action', inputs: { to: { kind: 'ref', path: 'loop.item.email' } } },
            { type: 'notification', forEach: { overRef: 'loop.item.lines', itemVar: 'item' }, body: '{{loop.item.sku}}' },
            { type: 'loop', overRef: 'loop.item.files', itemVar: 'item', body: [{ type: 'condition', expr: 'loop.item.ok' }] },
            { type: 'loop', overRef: 'loop.item.tags', itemVar: 'tag', body: [{ type: 'condition', expr: 'loop.item.ok && loop.tag.x' }] },
            { type: 'filter', arrayRef: 'loop.item.rows', expr: 'item.amount > 1' },
        ],
    };
    const { step: out } = renameItemVar(loop, 'order');
    assert.equal(out.itemVar, 'order');
    assert.equal(out.overRef, 'loop.item.outer', 'the loop\'s own list is read outside it');
    assert.equal(out.body[0].inputs.to.path, 'loop.order.email');
    assert.equal(out.body[1].forEach.overRef, 'loop.order.lines');
    assert.equal(out.body[1].body, '{{loop.item.sku}}', 'its own item hides the outer one');
    assert.equal(out.body[2].overRef, 'loop.order.files');
    assert.equal(out.body[2].body[0].expr, 'loop.item.ok', 'a nested loop with the same name hides it');
    assert.equal(out.body[3].body[0].expr, 'loop.order.ok && loop.tag.x');
    assert.equal(out.body[4].arrayRef, 'loop.order.rows');
    assert.equal(out.body[4].expr, 'item.amount > 1');
});

test('renameItemVar refuses a name the same values already read (it would merge two items)', () => {
    const step = { type: 'loop', itemVar: 'item', body: [{ type: 'condition', expr: 'loop.item.ok && loop.order.ok' }] };
    assert.deepStrictEqual(renameItemVar(step, 'order'), { error: 'name_in_use' });
    assert.equal(renameItemVar(step, 'line').step.body[0].expr, 'loop.line.ok && loop.order.ok');
    const fe = { type: 'integration_action', forEach: { overRef: 'loop.order.lines', itemVar: 'item' }, inputs: { a: { kind: 'ref', path: 'loop.item.x' } } };
    assert.ok(renameItemVar(fe, 'order').step, 'the list is read outside the item, so its name is free inside');
});

test('regression: renameItemVar refuses a name a scope inside the body binds while it reads the item', () => {
    const ref = path => ({ kind: 'ref', path });
    // A per-item step whose own item is called `line` and still reads the order.
    const perItem = {
        type: 'loop', itemVar: 'item',
        body: [{ type: 'integration_action', forEach: { overRef: 'loop.item.lines', itemVar: 'line' }, inputs: { x: ref('loop.item.name') } }],
    };
    assert.deepStrictEqual(renameItemVar(perItem, 'line'), { error: 'name_in_use' });
    // A nested loop over `line` whose body reads the order.
    const nested = {
        type: 'loop', itemVar: 'item',
        body: [{ type: 'loop', overRef: 'loop.item.lines', itemVar: 'line', body: [{ type: 'condition', expr: 'loop.item.name' }] }],
    };
    assert.deepStrictEqual(renameItemVar(nested, 'line'), { error: 'name_in_use' });
    // The same scopes that never read the order leave the name free.
    const quiet = {
        type: 'loop', itemVar: 'item',
        body: [
            { type: 'integration_action', forEach: { overRef: 'loop.item.lines', itemVar: 'line' }, inputs: { x: ref('loop.line.sku') } },
            { type: 'loop', overRef: 'loop.item.lines', itemVar: 'line', body: [{ type: 'condition', expr: 'loop.line.ok' }] },
        ],
    };
    const { step: out } = renameItemVar(quiet, 'line');
    assert.equal(out.body[0].forEach.overRef, 'loop.line.lines', 'the list is read in the outer scope');
    assert.equal(out.body[0].inputs.x.path, 'loop.line.sku');
    assert.equal(out.body[1].overRef, 'loop.line.lines');
});

test('regression: renameItemVar rewrites the steps of a parallel step inside the body', () => {
    const loop = {
        type: 'loop', itemVar: 'a',
        body: [{ type: 'parallel', branches: [
            [{ type: 'notification', title: '{{loop.a.name}}' }],
            [{ type: 'integration_action', inputs: { x: { kind: 'ref', path: 'loop.a.id' } } }],
        ] }],
    };
    const { step: out } = renameItemVar(loop, 'z');
    assert.equal(out.body[0].branches[0][0].title, '{{loop.z.name}}');
    assert.equal(out.body[0].branches[1][0].inputs.x.path, 'loop.z.id');
    const reads = { type: 'loop', itemVar: 'a', body: [{ type: 'parallel', branches: [[{ type: 'condition', expr: 'loop.z.ok' }]] }] };
    assert.deepStrictEqual(renameItemVar(reads, 'z'), { error: 'name_in_use' }, 'a read inside a branch counts for the probe');
});

test('regression: renameItemVar rewrites the {{ }} strings a slide renders from its chart data and stats', () => {
    const slide = {
        type: 'slide', forEach: { overRef: 'steps.get.output.rows', itemVar: 'row' },
        chart: { type: 'bar', data: '{{loop.row.points}}', labels: '{{loop.row.months}}' },
        stats: '{{loop.row.total}} | Total',
        inputs: { note: 'loop.row stays: a bare string here is data {{loop.row.x}}' },
    };
    const { step: out } = renameItemVar(slide, 'order');
    assert.equal(out.chart.data, '{{loop.order.points}}');
    assert.equal(out.chart.labels, '{{loop.order.months}}');
    assert.equal(out.stats, '{{loop.order.total}} | Total');
    assert.equal(out.inputs.note, slide.inputs.note, 'a bare string in inputs is a literal');
    const deck = { type: 'presentation', forEach: { overRef: 'steps.get.output.rows', itemVar: 'row' }, slides: ['{{loop.row.slide}}', { kind: 'literal', value: '{{loop.row.x}}' }] };
    assert.deepStrictEqual(renameItemVar(deck, 'r').step.slides, ['{{loop.r.slide}}', { kind: 'literal', value: '{{loop.row.x}}' }]);
});
