import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate } from '../expr/index.mjs';
import * as parse from '../expr/parse.mjs';
import { legacyPathOf, liftLegacy, lowerPick } from './upgrade.mjs';
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

// ── lowerPick: a pick in the legacy spelling ──────────────────────────────

const pick = (from, take = 'one', as = 'native', join) => ({ kind: 'pick', v: 1, from, take, as, ...(join ? { join } : {}) });

test('legacyPathOf writes every root and puts [*] where the data shows a list', () => {
    assert.equal(legacyPathOf({ root: 'trigger', path: ['Klant', 'E-mail adres'] }, SAMPLE), 'trigger.output.Klant["E-mail adres"]');
    assert.equal(legacyPathOf({ root: 'steps', id: 's1', path: ['items', 'email'] }, SAMPLE), 'steps.s1.output.items[*].email');
    assert.equal(legacyPathOf({ root: 'trigger', path: ['orders', 'lines', 'product'] }, SAMPLE), 'trigger.output.orders[*].lines[*].product');
    assert.equal(legacyPathOf({ root: 'trigger', path: ['orders', 0, 'id'] }, SAMPLE), 'trigger.output.orders[0].id', 'an index is no [*]');
    assert.equal(legacyPathOf({ root: 'trigger', path: ['orders'] }, SAMPLE), 'trigger.output.orders', 'the list itself');
    assert.equal(legacyPathOf({ root: 'run', path: ['firedAt'] }, SAMPLE), 'trigger.firedAt');
    assert.equal(legacyPathOf({ root: 'item', path: ['amount'] }, null), 'item.amount');
    assert.equal(legacyPathOf({ root: 'vars', path: ['rate'] }, null), 'vars.rate');
    assert.equal(legacyPathOf({ root: 'loop', id: 'row', path: ['name'] }, null), 'loop.row.name');
    // Without data nothing says where a list is: the path as the Source spells it.
    assert.equal(legacyPathOf({ root: 'steps', id: 's1', path: ['items', 'email'] }, null), 'steps.s1.output.items.email');
    assert.equal(legacyPathOf({ root: 'trigger', path: ['a]b'] }, null), null, 'a key the grammar cannot write');
    assert.equal(legacyPathOf({ root: 'nope', path: [] }, null), null);
    assert.equal(legacyPathOf(null, SAMPLE), null);
});

test('lowerPick writes the legacy binding of each take', () => {
    const lines = { root: 'trigger', path: ['orders', 'lines', 'product'] };
    const p = 'trigger.output.orders[*].lines[*].product';
    assert.deepStrictEqual(lowerPick(pick({ root: 'trigger', path: ['note'] }), SAMPLE), ref('trigger.output.note'));
    assert.deepStrictEqual(lowerPick(pick(lines, 'all', 'list'), SAMPLE), ref(p));
    assert.deepStrictEqual(lowerPick(pick(lines, 'all', 'text', 'lines'), SAMPLE), expr(`join(${p}, "\\n")`));
    assert.deepStrictEqual(lowerPick(pick(lines, 'all', 'text', 'comma'), SAMPLE), expr(`join(${p}, ", ")`));
    assert.deepStrictEqual(lowerPick(pick(lines, 'first'), SAMPLE), expr(`first(${p})`));
    assert.deepStrictEqual(lowerPick(pick(lines, 'last'), SAMPLE), expr(`last(${p})`));
    assert.deepStrictEqual(lowerPick(pick(lines, 'count', 'number'), SAMPLE), expr(`count(${p})`));
    assert.equal(lowerPick(pick(lines, 'all', 'text', 'bullets'), SAMPLE), null, 'a bulleted text has no legacy form');
    assert.equal(lowerPick(pick(lines, 'each'), SAMPLE), null);
    assert.equal(lowerPick(null, SAMPLE), null);
});

test('what lowerPick writes lifts back to the same pick and gives the same value', () => {
    const resolver = createResolver(deps);
    const cases = [
        pick({ root: 'trigger', path: ['Klant', 'naam'] }),
        pick({ root: 'trigger', path: ['tags'] }, 'all', 'text', 'comma'),
        pick({ root: 'trigger', path: ['tags'] }, 'all', 'text', 'lines'),
        pick({ root: 'steps', id: 's1', path: ['items', 'email'] }, 'first'),
        pick({ root: 'steps', id: 's1', path: ['items', 'email'] }, 'last'),
        pick({ root: 'trigger', path: ['orders', 'total'] }, 'count'),
    ];
    for (const original of cases) {
        const lowered = lowerPick(original, SAMPLE);
        assert.ok(lowered, JSON.stringify(original));
        const lifted = liftLegacy(lowered, SAMPLE, null, deps);
        assert.deepStrictEqual(lifted?.from, original.from, JSON.stringify(lowered));
        assert.equal(lifted?.take, original.take, JSON.stringify(lowered));
        assert.deepStrictEqual(
            resolver.resolveValue(lowered, SAMPLE, { silent: true }),
            resolver.resolveValue(lifted, SAMPLE, { silent: true }),
            JSON.stringify(lowered),
        );
    }
});

// Review M4b: the click carries `messages[*].subject`; the Source drops the
// [*]. Without a sample (or with one that lacks the key) the [*] came only
// from the clicked path, and was lost: `first(steps.g.output.messages.subject)`
// reads nothing at run time.
test('legacyPathOf keeps the [*] of the path the user picked when the data says nothing', () => {
    const subject = { root: 'steps', id: 'g', path: ['messages', 'subject'] };
    const hint = 'steps.g.output.messages[*].subject';
    assert.equal(legacyPathOf(subject, null, hint), hint, 'no sample');
    assert.equal(legacyPathOf(subject, { steps: { g: { output: {} } } }, hint), hint, 'a sample without the key');
    assert.equal(legacyPathOf(subject, null), 'steps.g.output.messages.subject', 'no hint: as the Source spells it');
    assert.equal(lowerPick(pick(subject, 'first'), null, hint)?.value, `first(${hint})`);
    // Another column of the same table keeps the table's [*].
    assert.equal(legacyPathOf({ ...subject, path: ['messages', 'from'] }, null, hint), 'steps.g.output.messages[*].from');
    // A hint for another step, or a [*] before an index, says nothing.
    assert.equal(legacyPathOf(subject, null, 'steps.other.output.messages[*].subject'), 'steps.g.output.messages.subject');
    assert.equal(legacyPathOf({ ...subject, path: ['messages', 0, 'subject'] }, null, hint), 'steps.g.output.messages[0].subject');
    // The data and the hint agree: one [*], not two.
    assert.equal(legacyPathOf({ root: 'steps', id: 's1', path: ['items', 'email'] }, SAMPLE, 'steps.s1.output.items[*].email'), 'steps.s1.output.items[*].email');
});

test('legacyPathOf writes a WILD segment as [*] and keeps reading the data after it', () => {
    const wild = { root: 'trigger', path: ['orders', { wild: true }, 'lines', 'product'] };
    assert.equal(legacyPathOf(wild, SAMPLE), 'trigger.output.orders[*].lines[*].product');
    assert.equal(legacyPathOf(wild, null), 'trigger.output.orders[*].lines.product');
});
