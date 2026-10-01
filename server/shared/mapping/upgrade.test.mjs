import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate } from '../expr/index.mjs';
import * as parse from '../expr/parse.mjs';
import { liftLegacy } from './upgrade.mjs';
import { createResolver } from './resolve.mjs';

const deps = { evaluate, parse };
const ref = (path) => ({ kind: 'ref', path });
const expr = (value) => ({ kind: 'expr', value });

// A webhook with a customer and orders (each with lines), as the preview fixture.
const SAMPLE = {
    trigger: {
        id: 't1',
        output: {
            Klant: { naam: 'Anna', 'E-mail adres': 'anna@voorbeeld.nl' },
            orders: [
                { id: 'A-100', total: 129.5, lines: [{ product: 'Stoel', qty: 1 }, { product: 'Lamp', qty: 2 }] },
                { id: 'A-101', total: 49, lines: [{ product: 'Muismat', qty: 3 }] },
            ],
            tags: ['vip', 'nieuw'],
            nested: [[1, 2], [3]],
            note: 'abc',
        },
    },
    steps: { s1: { output: { items: [{ email: 'a@x.nl' }, { email: 'b@x.nl' }], body: '{"a":1}' } } },
    vars: { rate: 21 },
};
const EMPTY = { trigger: { output: { orders: [] } }, steps: {}, vars: {} };

test('a ref without [*] lifts to pick one/native, needing no data', () => {
    assert.deepStrictEqual(liftLegacy(ref('trigger.output.Klant["E-mail adres"]'), SAMPLE), {
        kind: 'pick', v: 1, from: { root: 'trigger', path: ['Klant', 'E-mail adres'] }, take: 'one', as: 'native',
    });
    assert.deepStrictEqual(liftLegacy(ref('steps.s1.output.items'), null)?.from, { root: 'steps', id: 's1', path: ['items'] });
    assert.deepStrictEqual(liftLegacy(ref('vars.rate'), undefined)?.from, { root: 'vars', path: ['rate'] });
    assert.deepStrictEqual(liftLegacy(ref('trigger.id'), SAMPLE)?.from, { root: 'run', path: ['id'] }, 'trigger metadata is the run root');
});

test('a ref without [*] whose old value was undefined still lifts (the repair of M2)', () => {
    // The legacy walker cannot read a key on a list; a pick can.
    const pick = liftLegacy(ref('trigger.output.orders.id'), SAMPLE);
    assert.equal(pick?.take, 'one');
});

test('a ref that resolves to something else as a pick is a Formula', () => {
    // `.length` is an own property the legacy walker reads; a pick never does.
    assert.equal(liftLegacy(ref('trigger.output.tags.length'), SAMPLE), null);
    // A string index: legacy reads the character, a pick reads nothing.
    assert.equal(liftLegacy(ref('trigger.output.note[0]'), SAMPLE), null);
});

test('a ref with an index lifts only when the data shows a list there', () => {
    // On a text the legacy walker reads a character ('[' of a JSON text);
    // a pick reads nothing or indexes the parsed JSON. Without data that
    // cannot be told apart, so no chip.
    for (const path of ['trigger.output.note[0]', 'steps.s1.output.body[0]', 'steps.s1.output.code[0]']) {
        assert.equal(liftLegacy(ref(path), null), null, `${path}, no sample`);
        assert.equal(liftLegacy(ref(path), EMPTY), null, `${path}, a sample without the field`);
    }
    assert.equal(liftLegacy(ref('steps.s1.output.body[0]'), { steps: { s1: { output: { body: '[{"a":1}]' } } } }), null);
    assert.equal(liftLegacy(ref('steps.s1.output.code[0]'), { steps: { s1: { output: { code: 'ABC' } } } }), null);
    assert.equal(liftLegacy(ref('steps.s1.output.items[0].email'), null), null, 'no sample: no evidence, no chip');
    assert.deepStrictEqual(liftLegacy(ref('steps.s1.output.items[0].email'), SAMPLE), {
        kind: 'pick', v: 1, from: { root: 'steps', id: 's1', path: ['items', 0, 'email'] }, take: 'one', as: 'native',
    });
    assert.notEqual(liftLegacy(ref('trigger.output.tags[1]'), EMPTY, SAMPLE), null, 'the last run is evidence');
});

test('a ref the runtime cannot read, or that reads no value Source, is a Formula', () => {
    assert.equal(liftLegacy(ref('steps.s1.output.items.0.email'), SAMPLE), null, 'REF_RE rejects it: no chip for a broken path');
    assert.equal(liftLegacy(ref('secrets.apiKey'), SAMPLE), null);
    assert.equal(liftLegacy(ref('steps.s1.status'), SAMPLE), null);
    assert.equal(liftLegacy(ref(''), SAMPLE), null);
    assert.equal(liftLegacy({ kind: 'ref' }, SAMPLE), null);
});

test('a [*] ref lifts to pick all/native only when the data proves it', () => {
    const p = ref('trigger.output.orders[*].lines[*].product');
    assert.deepStrictEqual(liftLegacy(p, SAMPLE), {
        kind: 'pick', v: 1, from: { root: 'trigger', path: ['orders', 'lines', 'product'] }, take: 'all', as: 'native',
    });
    assert.equal(liftLegacy(p, null), null, 'no sample: no evidence, no chip');
    assert.equal(liftLegacy(p, EMPTY), null, 'an empty list is no evidence either');
    assert.notEqual(liftLegacy(p, EMPTY, SAMPLE), null, 'the last run is evidence');
});

test('a [*] ref that flattens differently from a pick is a Formula', () => {
    // Legacy `nested[*]` spreads each inner list; a pick of `nested` keeps them.
    assert.equal(liftLegacy(ref('trigger.output.nested[*]'), SAMPLE), null);
    // An index after [*] indexes each item; the pick would index the list.
    assert.equal(liftLegacy(ref('trigger.output.orders[*].lines[0]'), SAMPLE), null);
});

test('a lift must agree with the last run too', () => {
    const lastRun = { trigger: { output: { tags: [['a'], ['b']] } } };
    assert.equal(liftLegacy(ref('trigger.output.tags[*]'), SAMPLE, lastRun), null);
    assert.notEqual(liftLegacy(ref('trigger.output.tags[*]'), SAMPLE), null);
});

test('join(p, "\\n") and join(p, ", ") lift to take all as text', () => {
    assert.deepStrictEqual(liftLegacy(expr('join(steps.s1.output.items[*].email, "\\n")'), SAMPLE, null, deps), {
        kind: 'pick', v: 1, from: { root: 'steps', id: 's1', path: ['items', 'email'] }, take: 'all', as: 'text', join: 'lines',
    });
    assert.equal(liftLegacy(expr("join(trigger.output.tags, ', ')"), SAMPLE, null, deps)?.join, 'comma');
    assert.equal(liftLegacy(expr('join(trigger.output.tags, " | ")'), SAMPLE, null, deps), null, 'no pick has that separator');
    assert.equal(liftLegacy(expr('join(trigger.output.tags)'), SAMPLE, null, deps), null);
});

test('join over records is a Formula: join() writes "Key: value", a pick a row', () => {
    assert.equal(liftLegacy(expr('join(steps.s1.output.items, ", ")'), SAMPLE, null, deps), null);
});

test('first, last and count lift to the matching take', () => {
    const lift = (src) => liftLegacy(expr(src), SAMPLE, null, deps);
    assert.equal(lift('first(trigger.output.tags)')?.take, 'first');
    assert.equal(lift('last(trigger.output.orders[*].total)')?.take, 'last');
    assert.deepStrictEqual(lift('count(trigger.output.orders)'), {
        kind: 'pick', v: 1, from: { root: 'trigger', path: ['orders'] }, take: 'count', as: 'native',
    });
    // count() of a text is its length; a pick counts one value.
    assert.equal(lift('count(trigger.output.note)'), null);
    assert.equal(lift('first(trigger.output.tags, ", ")'), null);
});

test('an expr lifts only with an engine and with data, and only the four calls', () => {
    assert.equal(liftLegacy(expr('first(trigger.output.tags)'), SAMPLE), null, 'no evaluate: no expr lift');
    assert.equal(liftLegacy(expr('first(trigger.output.tags)'), EMPTY, null, deps), null, 'no data: no lift');
    assert.equal(liftLegacy(expr('upper(trigger.output.note)'), SAMPLE, null, deps), null);
    assert.equal(liftLegacy(expr('first(trigger.output.tags) + "x"'), SAMPLE, null, deps), null);
    assert.equal(liftLegacy(expr('steps.s1.output.items'), SAMPLE, null, deps), null);
});

test('every lift resolves as the legacy binding did on the data it was checked on', () => {
    const resolver = createResolver({ evaluate, parse });
    const cases = [
        ref('trigger.output.Klant.naam'),
        ref('trigger.output.orders[*].id'),
        ref('trigger.output.orders[*].lines[*].product'),
        expr('join(trigger.output.orders[*].lines[*].product, "\\n")'),
        expr('first(trigger.output.orders[*].id)'),
        expr('last(trigger.output.tags)'),
        expr('count(trigger.output.orders[*].lines)'),
    ];
    for (const binding of cases) {
        const pick = liftLegacy(binding, SAMPLE, null, deps);
        assert.ok(pick, JSON.stringify(binding));
        assert.deepStrictEqual(resolver.resolveValue(pick, SAMPLE, { silent: true }), resolver.resolveValue(binding, SAMPLE), JSON.stringify(binding));
    }
});

test('a pick stays a pick; literals, templates and composes are not lifted here', () => {
    const pick = { kind: 'pick', v: 1, from: { root: 'vars', path: ['rate'] }, take: 'one', as: 'native' };
    assert.equal(liftLegacy(pick, null), pick);
    assert.equal(liftLegacy({ kind: 'literal', value: 'x' }, SAMPLE), null);
    assert.equal(liftLegacy({ kind: 'template', value: '{{vars.rate}}' }, SAMPLE), null);
    assert.equal(liftLegacy({ kind: 'pick', from: { root: 'vars', path: ['rate'] } }, SAMPLE), null, 'no v: a literal object');
    assert.equal(liftLegacy(null, SAMPLE), null);
    assert.equal(liftLegacy('steps.s1.output.items', SAMPLE), null);
});
