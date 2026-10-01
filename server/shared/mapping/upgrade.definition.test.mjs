/**
 * upgrade.mjs, M8: upgradeDefinition and upgradeStepRepeat ("Koppelingen
 * bijwerken").
 *
 * Proven:
 *   - corpus round trips: every legacy ref and expr of the golden corpus,
 *     upgraded with the corpus state as evidence, resolves to exactly what
 *     the legacy binding resolves to, on that state and on a second one;
 *   - an expr stays a Formula, even one liftLegacy shows as a chip: on an
 *     empty list first() gives null where the pick gives nothing;
 *   - a binding whose value the data shows would change is kept, a value
 *     the legacy binding did not have included; one that needs data and has
 *     none is kept;
 *   - a forEach becomes a repeat only when the forEach and the repeat run
 *     for the same items and every binding gives each item what it gave
 *     before; the refusals name why;
 *   - loop bodies, parallel branches and flowlets are reached; a flowlet
 *     gets no dry run;
 *   - the report carries labels, never a value from the data; the input is
 *     not changed; a second upgrade changes nothing.
 *
 * Run: cd server && node --test shared/mapping/upgrade.definition.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate } from '../expr/index.mjs';
import * as parse from '../expr/parse.mjs';
import { createResolver } from './resolve.mjs';
import { upgradeDefinition, upgradeStepRepeat } from './upgrade.mjs';
import { makeState, makeMappingState, WALK, RESOLVE, DEEP, INPUTS } from './corpus.mjs';

const deps = { evaluate, parse };
const resolver = createResolver({ evaluate, parse });
const ref = (path) => ({ kind: 'ref', path });
const expr = (value) => ({ kind: 'expr', value });

/** What a step is sent: JSON, so an input that resolved to nothing is absent either way. */
const sent = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function oneStep(inputs, extra = {}) {
    return { trigger: { id: 't', kind: 'manual' }, steps: [{ id: 'x', type: 'integration_action', label: 'Send', inputs, ...extra }], edges: [] };
}

/** Every legacy ref/expr/template of the corpus, as one input each. */
function corpusInputs() {
    const inputs = {};
    let i = 0;
    for (const { path } of WALK) if (typeof path === 'string') inputs[`w${i++}`] = ref(path);
    for (const { binding, opts } of RESOLVE) if (!opts) inputs[`r${i++}`] = binding;
    for (const { structure, opts } of DEEP) if (!opts) inputs[`d${i++}`] = structure;
    for (const { inputs: more, opts } of INPUTS) {
        if (opts || !more || typeof more !== 'object' || Array.isArray(more)) continue;
        for (const [k, v] of Object.entries(more)) inputs[`i${i++}_${k}`] = v;
    }
    // The lifts this file is about, on the corpus data (the exprs only
    // show they stay a Formula).
    Object.assign(inputs, {
        e1: expr('first(trigger.output.tags)'),
        e2: expr('last(trigger.output.attachments[*].filename)'),
        e3: expr('count(trigger.output.attachments)'),
        e4: expr('join(trigger.output.tags, ", ")'),
        e5: expr('join(trigger.output.attachments[*].filename, "\\n")'),
        e6: expr('count(trigger.output.subject)'),
        w1: ref('trigger.output.attachments[*].filename'),
        w2: ref('trigger.output.matrix[*]'),
        w3: ref('trigger.output.list.a'),
    });
    return inputs;
}

test('corpus round trip: upgrade, then resolve, equals the legacy resolve on the evidence', () => {
    for (const [name, sample, lastRun] of [
        ['corpus state', makeState(), null],
        ['corpus state and a second run', makeState(), makeMappingState()],
    ]) {
        const def = oneStep(corpusInputs());
        const before = JSON.stringify(def);
        const { definition, changed, kept } = upgradeDefinition(def, { sample, lastRun, ...deps });
        assert.equal(JSON.stringify(def), before, `${name}: the definition handed in is not changed`);
        assert.ok(changed.length >= 30, `${name}: ${changed.length} bindings upgraded`);
        assert.ok(kept.length >= 5, `${name}: ${kept.length} bindings kept`);
        const oldInputs = def.steps[0].inputs;
        const newInputs = definition.steps[0].inputs;
        for (const state of [sample, lastRun].filter(Boolean)) {
            for (const key of Object.keys(oldInputs)) {
                assert.deepStrictEqual(
                    sent(resolver.resolveValue(newInputs[key], state, { silent: true })),
                    sent(resolver.resolveValue(oldInputs[key], state)),
                    `${name}: ${key} = ${JSON.stringify(oldInputs[key])}`,
                );
            }
            assert.deepStrictEqual(sent(resolver.resolveInputs(newInputs, state, { silent: true })), sent(resolver.resolveInputs(oldInputs, state)), `${name}: resolveInputs`);
        }
    }
});

test('what lifts, and why the rest is kept', () => {
    const def = oneStep(corpusInputs());
    const { definition, changed, kept } = upgradeDefinition(def, { sample: makeState(), ...deps });
    const inputs = definition.steps[0].inputs;
    const reasonOf = (field) => kept.find(k => k.field === `inputs.${field}`)?.reason;
    // An expr stays a Formula, even where the data at hand agrees.
    for (const e of ['e1', 'e2', 'e3', 'e4', 'e5', 'e6']) {
        assert.deepStrictEqual(inputs[e], def.steps[0].inputs[e], e);
        assert.equal(reasonOf(e), 'formula', e);
    }
    assert.equal(inputs.w1.take, 'all');
    // Legacy `matrix[*]` spreads the inner lists; a pick keeps them.
    assert.equal(reasonOf('w2'), 'would_change');
    // A key on a list: the legacy walker reads nothing, a pick reads the
    // first. A value the run did not have is a change too.
    assert.equal(reasonOf('w3'), 'would_change');
    assert.equal(inputs.w3.kind, 'ref');
    // A formula no pick reads stays a Formula.
    const lower = Object.keys(inputs).find(k => inputs[k]?.value === 'lower(trigger.output.name)');
    assert.equal(reasonOf(lower), 'formula');
    // Templates and literals are not touched, and not reported.
    const tpl = Object.keys(inputs).find(k => inputs[k]?.kind === 'template');
    assert.deepStrictEqual(inputs[tpl], def.steps[0].inputs[tpl]);
    assert.ok(![...changed, ...kept].some(e => e.field === `inputs.${tpl}`));
    const lit = Object.keys(inputs).find(k => inputs[k]?.kind === 'literal' && inputs[k].value?.kind === 'ref');
    assert.deepStrictEqual(inputs[lit], { kind: 'literal', value: { kind: 'ref', path: 'trigger.output.name' } }, 'a ref inside a literal is data');
});

test('without data nothing is lifted, a ref of plain keys included', () => {
    const def = oneStep({
        a: ref('trigger.output.Klant.naam'),
        b: ref('trigger.output.orders[0].id'),
        c: ref('trigger.output.orders[*].id'),
        d: expr('first(trigger.output.tags)'),
    });
    const { definition, changed, kept } = upgradeDefinition(def, deps);
    assert.equal(definition, def);
    assert.deepStrictEqual(changed, []);
    assert.deepStrictEqual(kept.map(k => [k.field, k.reason]), [['inputs.a', 'no_evidence'], ['inputs.b', 'no_evidence'], ['inputs.c', 'no_evidence'], ['inputs.d', 'formula']]);
    // Data where the value is empty is no evidence either: the key may be a
    // list, or a JSON text, the next time.
    const empty = upgradeDefinition(def, { sample: { trigger: { output: { Klant: {} } } }, ...deps });
    assert.deepStrictEqual(empty.changed, []);
    // A plain ref of keys on a list: legacy reads nothing, a pick the first.
    const onList = upgradeDefinition(def, { sample: { trigger: { output: { Klant: [{ naam: 'Ada' }] } } }, ...deps });
    assert.equal(onList.kept.find(k => k.field === 'inputs.a').reason, 'would_change');
});

test('an expr stays a Formula: the run at hand agrees, an empty list later would not', () => {
    const inputs = {
        f: expr('first(trigger.output.tags)'),
        l: expr('last(trigger.output.tags)'),
        j: expr('join(trigger.output.tags, ", ")'),
        c: expr('count(trigger.output.tags)'),
    };
    const withTags = { trigger: { output: { tags: ['a', 'b'] } }, steps: {} };
    const { definition, changed, kept } = upgradeDefinition(oneStep(inputs), { lastRun: withTags, ...deps });
    assert.deepStrictEqual(changed, []);
    assert.deepStrictEqual(kept.map(k => [k.field, k.reason]), [['inputs.f', 'formula'], ['inputs.l', 'formula'], ['inputs.j', 'formula'], ['inputs.c', 'formula']]);
    assert.deepStrictEqual(definition.steps[0].inputs, inputs);
    // Why: a later run with an empty list. first() sends null; the pick it
    // would lift to sends nothing, and the key would drop out of the input.
    const empty = { trigger: { output: { tags: [] } }, steps: {} };
    const pick = { kind: 'pick', v: 1, from: { root: 'trigger', path: ['tags'] }, take: 'first', as: 'native' };
    assert.equal(resolver.resolveValue(inputs.f, empty, { silent: true }), null);
    assert.equal(resolver.resolveValue(pick, empty, { silent: true }), undefined);
    // Without an expression engine it is a Formula all the same.
    assert.equal(upgradeDefinition(oneStep({ d: inputs.f }), { sample: withTags }).kept[0].reason, 'formula');
});

test('the report names steps and labels, never a value from the data', () => {
    const sample = {
        trigger: { output: { Klant: { 'E-mail adres': 'anna@voorbeeld.nl' } } },
        steps: { get: { output: { orders: [{ total: 12 }] } } },
    };
    const def = {
        trigger: { id: 't' },
        steps: [
            { id: 'get', type: 'integration_action', label: 'Orders ophalen', inputs: {} },
            { id: 'mail', type: 'notification', label: 'Mail klant', title: 'x', inputs: { to: ref('trigger.output.Klant["E-mail adres"]'), n: ref('steps.get.output.orders') } },
        ],
    };
    const { changed } = upgradeDefinition(def, { sample, ...deps });
    assert.deepStrictEqual(changed, [
        { stepId: 'mail', step: 'Mail klant', field: 'inputs.to', kind: 'ref', take: 'one', root: 'trigger', source: null, label: 'Klant › E-mail adres' },
        { stepId: 'mail', step: 'Mail klant', field: 'inputs.n', kind: 'ref', take: 'one', root: 'steps', source: 'Orders ophalen', label: 'Orders' },
    ]);
    assert.ok(!JSON.stringify(changed).includes('anna@'), 'no run value in the report');
});

test('nothing to upgrade: the same definition object, an empty report', () => {
    const def = oneStep({ a: { kind: 'literal', value: 1 }, b: { kind: 'template', value: 'Hi {{trigger.output.name}}' } });
    const r = upgradeDefinition(def, { sample: makeState(), ...deps });
    assert.equal(r.definition, def);
    assert.deepStrictEqual([r.changed, r.kept], [[], []]);
    assert.deepStrictEqual(upgradeDefinition(null), { definition: null, changed: [], kept: [] });
});

test('a second upgrade changes nothing', () => {
    const once = upgradeDefinition(oneStep(corpusInputs()), { sample: makeState(), ...deps });
    const twice = upgradeDefinition(once.definition, { sample: makeState(), ...deps });
    assert.equal(twice.changed.length, 0);
    assert.equal(twice.definition, once.definition);
});

test('binding sites beyond inputs, loop bodies, parallel branches and flowlets', () => {
    const def = {
        trigger: { id: 't' },
        steps: [
            { id: 'set', type: 'set', fields: { naam: ref('trigger.output.name') } },
            { id: 'dt', type: 'datatable', where: [{ column: 'a', op: 'eq', value: ref('trigger.output.subject') }] },
            { id: 'lp', type: 'loop', overRef: 'trigger.output.tags', itemVar: 'tag', body: [{ id: 'in', type: 'integration_action', inputs: { t: ref('loop.tag'), s: ref('trigger.output.subject') } }] },
            { id: 'par', type: 'parallel', branches: [[{ id: 'b1', type: 'integration_action', inputs: { s: ref('trigger.output.subject') } }]] },
            { id: 'note', type: 'note', inputs: { s: ref('trigger.output.subject') } },
        ],
        layers: {
            fl: { trigger: { id: 'lt' }, steps: [{ id: 'l1', type: 'integration_action', inputs: { a: ref('trigger.output.name'), b: ref('trigger.output.tags[*]') } }] },
        },
    };
    const { definition, changed, kept } = upgradeDefinition(def, { sample: makeState(), ...deps });
    assert.equal(definition.steps[0].fields.naam.kind, 'pick');
    assert.equal(definition.steps[1].where[0].value.kind, 'pick');
    assert.equal(definition.steps[2].overRef, 'trigger.output.tags', 'a list path stays');
    assert.equal(definition.steps[2].body[0].inputs.s.kind, 'pick', 'a loop body step reads the run too');
    assert.equal(definition.steps[2].body[0].inputs.t.kind, 'ref', 'the item of a loop: no runState binds it');
    assert.equal(definition.steps[3].branches[0][0].inputs.s.kind, 'pick');
    assert.deepStrictEqual(definition.steps[4], def.steps[4], 'a note is no step');
    // The flowlet runs on its own inputs: the run's data is no evidence there.
    assert.deepStrictEqual(definition.layers.fl, def.layers.fl);
    assert.deepStrictEqual(kept.map(k => [k.stepId, k.layer, k.field, k.reason]), [
        ['in', undefined, 'inputs.t', 'no_evidence'],
        ['l1', 'fl', 'inputs.a', 'no_evidence'],
        ['l1', 'fl', 'inputs.b', 'no_evidence'],
    ]);
    assert.deepStrictEqual(changed.map(c => c.field), ['fields.naam', 'where.0.value', 'inputs.s', 'inputs.s']);
});

// ── forEach → repeat ──────────────────────────────────────────────────────

const ORDERS = [
    { id: 'A', klant: { email: 'a@x.nl' }, lines: [{ sku: 'S1' }] },
    { id: 'B', klant: { email: 'b@x.nl' }, lines: [] },
];
const RUN = { trigger: { output: {} }, steps: { get: { output: { orders: ORDERS, one: { id: 'Z' }, csv: '[{"id":"J"}]' } } }, vars: {} };

function perItem(extra = {}, forEach = {}) {
    return {
        id: 'mail', type: 'integration_action', tool: 'gmail_send', label: 'Mail elke order',
        forEach: { overRef: 'steps.get.output.orders', itemVar: 'row', maxIterations: 50, ...forEach },
        inputs: { to: ref('loop.row.klant.email'), id: ref('loop.row.id'), subject: { kind: 'literal', value: 'Order' } },
        ...extra,
    };
}

/** What each item of a forEach (legacy) or a repeat (v2) sends, as execFlow/execRepeat bind it. */
function itemsSent(step, state) {
    if (step.forEach) {
        const list = resolver.resolveValue(ref(step.forEach.overRef), state);
        return list.map((item, i) => sent(resolver.resolveInputs(step.inputs, { ...state, loop: { [step.forEach.itemVar]: item, _index: i } }, { silent: true })));
    }
    return ORDERS.map((item, i) => sent(resolver.resolveInputs(step.inputs, { ...state, _mappingScope: { over: step.repeat.over, item, index: i } }, { silent: true })));
}

test('upgradeStepRepeat: a forEach with plain item refs becomes a repeat that sends the same', () => {
    const step = perItem();
    const before = JSON.stringify(step);
    const r = upgradeStepRepeat(step, { lastRun: RUN, ...deps });
    assert.equal(JSON.stringify(step), before, 'the step handed in is not changed');
    assert.equal(r.step.forEach, undefined);
    assert.deepStrictEqual(r.step.repeat, { over: { root: 'steps', id: 'get', path: ['orders'] }, max: 50 });
    assert.deepStrictEqual(r.step.inputs.to, { kind: 'pick', v: 1, from: { root: 'steps', id: 'get', path: ['orders', 'klant', 'email'] }, take: 'each', as: 'native' });
    assert.deepStrictEqual(r.converted.map(c => c.field), ['inputs.to', 'inputs.id']);
    assert.deepStrictEqual(itemsSent(r.step, RUN), itemsSent(step, RUN));
    // The cap the forEach really ran with.
    assert.equal(upgradeStepRepeat(perItem({}, { maxIterations: undefined }), { lastRun: RUN }).step.repeat.max, 100);
    assert.equal(upgradeStepRepeat(perItem({}, { maxIterations: 5000 }), { lastRun: RUN }).step.repeat.max, 1000);
});

test('upgradeStepRepeat refuses what would not run the same', () => {
    const refused = (step, opts = { lastRun: RUN }) => upgradeStepRepeat(step, { ...opts, ...deps }).refused;
    assert.deepStrictEqual(refused(perItem(), {}), ['no_evidence'], 'no data: nothing shows the items agree');
    assert.deepStrictEqual(refused(perItem(), { lastRun: { steps: { get: { output: { orders: [] } } } } }), ['no_evidence'], 'an empty list shows no item');
    // An item ref no item filled shows nothing either.
    assert.deepStrictEqual(refused(perItem({ inputs: { to: ref('loop.row.klant.email'), fax: ref('loop.row.fax') } })), ['no_evidence']);
    // One record: the forEach skips it, a repeat would run once.
    assert.deepStrictEqual(refused(perItem({}, { overRef: 'steps.get.output.one' })), ['list_differs']);
    // A JSON text: the forEach skips it, a repeat would read it.
    assert.deepStrictEqual(refused(perItem({}, { overRef: 'steps.get.output.csv' })), ['list_differs']);
    // An item key on a list: the legacy walker reads nothing, a pick the first.
    assert.deepStrictEqual(refused(perItem({ inputs: { sku: ref('loop.row.lines.sku') } })), ['would_change']);
    // `length`: the legacy walker reads it, a pick never.
    assert.deepStrictEqual(refused(perItem({ inputs: { n: ref('loop.row.id.length') } })), ['loop_ref_unreadable']);
    // A field the sites table does not list still reads the item.
    assert.deepStrictEqual(refused(perItem({ options: { cc: '{{loop.row.klant.email}}' } })), ['loop_elsewhere']);
    assert.deepStrictEqual(refused(perItem({ inputs: { t: { kind: 'template', value: 'Hi {{loop.row.id}}' } } })), ['loop_in_template']);
    assert.deepStrictEqual(refused(perItem({}, { maxIterations: -5 })), ['max_unreadable']);
    assert.deepStrictEqual(refused({ ...perItem(), repeat: { over: { root: 'steps', id: 'get', path: ['orders'] } } }), ['already_repeating']);
    assert.deepStrictEqual(refused({ id: 'x', type: 'set' }), ['no_for_each']);
    assert.deepStrictEqual(refused(null), ['no_for_each']);
});

test('upgradeDefinition: a forEach that upgrades, and one that stays with its item refs', () => {
    const def = {
        trigger: { id: 't' },
        steps: [
            { id: 'get', type: 'integration_action', label: 'Orders ophalen', inputs: {} },
            perItem(),
            perItem({ id: 'keep', label: 'Blijft', inputs: { to: ref('loop.row.klant.email'), t: { kind: 'template', value: '{{loop.row.id}}' }, other: ref('steps.get.output.orders') } }),
        ],
    };
    const { definition, changed, kept } = upgradeDefinition(def, { lastRun: RUN, ...deps });
    assert.ok(definition.steps[1].repeat);
    assert.deepStrictEqual(changed.filter(c => c.stepId === 'mail'), [
        { stepId: 'mail', step: 'Mail elke order', field: 'forEach', kind: 'for_each', take: 'each', root: 'steps', source: 'Orders ophalen', label: 'Orders' },
        { stepId: 'mail', step: 'Mail elke order', field: 'inputs.to', kind: 'ref', take: 'each', root: 'steps', source: 'Orders ophalen', label: 'Klant › Email' },
        { stepId: 'mail', step: 'Mail elke order', field: 'inputs.id', kind: 'ref', take: 'each', root: 'steps', source: 'Orders ophalen', label: 'ID' },
    ]);
    const keep = definition.steps[2];
    assert.ok(keep.forEach && !keep.repeat);
    assert.deepStrictEqual(keep.inputs.to, ref('loop.row.klant.email'), 'the item ref stays with its forEach');
    assert.equal(keep.inputs.other.kind, 'pick', 'a ref of something else still lifts');
    assert.deepStrictEqual(kept.filter(k => k.stepId === 'keep').map(k => [k.field, k.reason]), [
        ['forEach', 'loop_in_template'],
        ['inputs.to', 'for_each_kept'],
    ]);
});

// Every recent run is its own runState (`runs`): a lift must resolve the
// same on each, not on one composite of the newest outputs.
const runOf = (trigger, steps = {}) => ({ trigger: { output: trigger }, steps, vars: {}, loop: {} });

test('runs: a lift equal on the newest run but not on an older one is kept', () => {
    const def = oneStep({ id: ref('trigger.output.orders.id') });
    const newest = runOf({ orders: { id: 'A-1' } });
    // An older run where the same key sits on a list: the legacy walker
    // reads nothing there, a pick reads every id.
    const older = runOf({ orders: [{ id: 'B-1' }, { id: 'B-2' }] });
    assert.equal(upgradeDefinition(def, { runs: [newest], ...deps }).changed.length, 1, 'the newest run alone shows no difference');
    const { definition, changed, kept } = upgradeDefinition(def, { runs: [newest, older], ...deps });
    assert.deepStrictEqual(changed, []);
    assert.deepStrictEqual(kept.map(k => [k.field, k.reason]), [['inputs.id', 'would_change']]);
    assert.equal(definition, def, 'nothing changed');
});

test('runs: a lift equal on every run is applied, and reads the same on each', () => {
    const def = oneStep({ id: ref('trigger.output.orders.id') });
    const runs = [runOf({ orders: { id: 'A-1' } }), runOf({ other: true }), runOf({ orders: { id: 'C-1' } })];
    const { definition, changed } = upgradeDefinition(def, { runs, ...deps });
    assert.equal(changed.length, 1);
    const after = definition.steps[0].inputs.id;
    assert.equal(after.kind, 'pick');
    for (const state of runs) {
        assert.deepStrictEqual(sent(resolver.resolveValue(after, state, { silent: true })), sent(resolver.resolveValue(ref('trigger.output.orders.id'), state, { silent: true })));
    }
});

test('runs: a value on at least one run; none gives no evidence', () => {
    const def = oneStep({ id: ref('trigger.output.orders.id') });
    const { changed, kept } = upgradeDefinition(def, { runs: [runOf({}), runOf({ a: 1 })], ...deps });
    assert.deepStrictEqual(changed, []);
    assert.deepStrictEqual(kept.map(k => k.reason), ['no_evidence']);
});

test('runs: the work is capped, a long history is not dry-run run by run', () => {
    const def = oneStep({ id: ref('trigger.output.orders.id') });
    const same = Array.from({ length: 5000 }, (_, i) => runOf({ orders: { id: `A-${i}` } }));
    const bad = runOf({ orders: [{ id: 'B-1' }] });
    // A difference among the first runs (the newest) is seen.
    assert.deepStrictEqual(upgradeDefinition(def, { runs: [bad, ...same], ...deps }).changed, []);
    // The store's window is ten runs; far beyond the cap nothing is read.
    assert.equal(upgradeDefinition(def, { runs: [...same, bad], ...deps }).changed.length, 1);
});

test('a datatable value lifted to a pick keeps its key when a later run lacks the value', () => {
    // save_row writes `col = NULL` for a key that resolved to undefined and
    // leaves the column alone for a missing key, so the upgraded pick must
    // resolve to the same KEYS as the legacy ref, not just the same values.
    const def = {
        trigger: { id: 't', kind: 'manual' },
        steps: [{
            id: 'd', type: 'datatable', label: 'Save', op: 'save_row',
            values: { status: ref('trigger.output.status'), note: ref('trigger.output.note') },
        }],
        edges: [],
    };
    const withNote = { trigger: { output: { status: 'open', note: 'call back' } }, steps: {} };
    const { definition, changed } = upgradeDefinition(def, { sample: withNote, lastRun: null, ...deps });
    const lifted = definition.steps[0].values;
    assert.equal(lifted.note.kind, 'pick', 'the ref is lifted on the evidence');
    assert.ok(changed.length >= 1);

    const withoutNote = { trigger: { output: { status: 'closed' } }, steps: {} };
    const legacyOut = resolver.resolveInputs(def.steps[0].values, withoutNote);
    const pickOut = resolver.resolveInputs(lifted, withoutNote);
    assert.deepStrictEqual(Object.keys(pickOut).sort(), Object.keys(legacyOut).sort());
    assert.ok('note' in pickOut, 'the key stays, so save_row still writes NULL there');
    assert.deepStrictEqual(pickOut, legacyOut);
});
