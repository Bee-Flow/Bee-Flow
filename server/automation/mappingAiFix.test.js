/**
 * automation/mappingAiFix.js: the AI fix of "Update mappings" (M8b), with the
 * model faked and everything else real (the upgrade, the resolver, the gate).
 *
 * Proven:
 *   - the equality gate: a proposal is kept only when it resolves to what the
 *     field resolves to now on EVERY runState and on every shape a later run
 *     may give what it reads, and reads exactly what the field reads; one
 *     that differs, writes a `+` formula as a compose (null), reads another
 *     step, or is no valid pick or compose is discarded;
 *   - privacy: the prompt holds the field texts, their slot and the SHAPE of
 *     the data (keys and types), never a value from a run or a sample (a
 *     fixture full of sentinel values); a key that is no field name (an
 *     address, an id, a person's name) is only counted, unless the field
 *     text quotes it;
 *   - a field no runState gives a value (no_evidence; null and an empty
 *     list are none) is never sent, and with nothing to ask the model is
 *     not called at all;
 *   - only kept refs and exprs of the automation's own graph are asked
 *     about: not a changed field, a forEach, a loop's item, a list
 *     function (first/last/count/join), a flowlet's step;
 *   - applying checks every suggestion again, all or nothing.
 *
 * Run: cd server && node --test automation/mappingAiFix.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { upgradeDefinition, createResolver } = require('../shared/mapping/index.mjs');
const parse = require('../shared/expr/parse.mjs');
const { evaluate } = require('./expr');
const { aiFixCandidates, suggestAiFixes, applyAiFixes, dataShape, toBinding, PROPOSE_TOOL } = require('./mappingAiFix');

const ref = (path) => ({ kind: 'ref', path });
const expr = (value) => ({ kind: 'expr', value });
const pick = (from, take = 'one', as = 'native', extra = {}) => ({ kind: 'pick', v: 1, from, take, as, ...extra });
const ORDERS = { root: 'steps', id: 'get', path: ['orders', 'id'] };

// Every value here is a sentinel: none of them may reach the model.
const PAYLOAD = {
    Klant: { naam: 'SENTINEL-Anna', 'E-mail adres': 'sentinel-anna@voorbeeld.nl' },
    'sentinel-key@x.nl': { a: 1 }, 12345: 'SENTINEL-id',
    // Data used as keys: a person's name, a company's.
    'Jan de Vries': { rol: 'SENTINEL-klant' }, 'Order-Smith': 'SENTINEL-order',
};
const LAST_ORDERS = { orders: [{ id: 'SENTINEL-A-100', total: 17.5 }], note: '{"inner": "SENTINEL-in-json"}', empty: null };
const PINNED_ORDERS = { orders: [{ id: 'SENTINEL-B-1', total: 1 }, { id: 'SENTINEL-B-2', total: 2 }], empty: [] };

function definition() {
    return {
        trigger: { id: 't', type: 'trigger', kind: 'webhook' },
        steps: [
            { id: 'get', type: 'integration_action', tool: 'shop_orders', label: 'Orders ophalen', inputs: {}, pinnedOutput: PINNED_ORDERS },
            {
                id: 'mail', type: 'integration_action', tool: 'gmail_send', label: 'Mail klant',
                inputs: {
                    to: ref('trigger.output.Klant["E-mail adres"]'),
                    count: expr('count(steps.get.output.orders)'),
                    ids: expr('join(steps.get.output.orders[*].id, ", ")'),
                    shout: expr('upper(trigger.output.Klant["E-mail adres"])'),
                    greet: expr('"Order " + steps.get.output.orders[0].id'),
                    total: expr('steps.get.output.orders[0].total'),
                    label: expr('steps.get.output.orders[0].id'),
                    nothing: expr('steps.get.output.nowhere'),
                    empty: expr('steps.get.output.empty'),
                },
            },
            { id: 'fe', type: 'integration_action', forEach: { overRef: 'steps.get.output.orders', itemVar: 'o' }, inputs: { id: ref('loop.o.id') } },
            { id: 'lp', type: 'loop', overRef: 'steps.get.output.orders', body: [{ id: 'in', type: 'integration_action', inputs: { name: expr('loop.item.name || "Unknown"') } }] },
            { id: 'call', type: 'layer_call', layerKey: 'L' },
        ],
        layers: { L: { steps: [{ id: 'l1', type: 'integration_action', inputs: { z: expr('count(trigger.output.items)') } }] } },
        edges: [],
    };
}

const lastRun = { trigger: { output: PAYLOAD, kind: 'webhook', firedAt: '2026-10-01T09:00:00Z' }, steps: { get: { output: LAST_ORDERS } }, vars: {}, loop: {} };
const sample = { trigger: { output: PAYLOAD }, steps: { get: { output: PINNED_ORDERS } }, vars: {}, loop: {} };

function upgraded(def = definition(), states = { lastRun, sample }) {
    return { ...upgradeDefinition(def, { ...states, evaluate, parse }), states };
}

/** A fake model: records what it was sent, answers what the test says. */
function fakeChat(answer) {
    const calls = [];
    const chat = async (messages, tool) => {
        calls.push({ messages, tool });
        const fields = JSON.parse(messages[1].content.slice(messages[1].content.indexOf('\n') + 1)).fields;
        const idOf = (text) => fields.find(f => f.text === text)?.id;
        return { structured: { proposals: answer(idOf) }, usage: { input_tokens: 10, output_tokens: 5 } };
    };
    return { chat, calls };
}

test('only kept refs and exprs of the own graph with a reason worth asking about are candidates', () => {
    const result = upgraded();
    const fields = aiFixCandidates(result).map(c => `${c.entry.stepId}.${c.entry.field}:${c.entry.reason}`);
    assert.deepStrictEqual(fields, [
        'mail.inputs.shout:formula', 'mail.inputs.greet:formula', 'mail.inputs.total:formula',
        'mail.inputs.label:formula', 'mail.inputs.nothing:formula', 'mail.inputs.empty:formula',
    ]);
    // 'to' was upgraded; the forEach and its item ref, and the flowlet, are not asked about.
    assert.ok(result.changed.some(c => c.field === 'inputs.to'));
    // Kept as Formula, and still not asked about: count() and join() differ from
    // any pick on an empty list, a record or a text; the loop's item is bound
    // by no runState, so a dry run would see a constant.
    for (const field of ['inputs.count', 'inputs.ids', 'inputs.name']) {
        assert.ok(result.kept.some(k => k.field === field && k.reason === 'formula'), field);
    }
});

test('the equality gate: kept only when the same on every runState', async () => {
    const TOTAL = pick({ root: 'steps', id: 'get', path: ['orders', 0, 'total'] });
    const { chat, calls } = fakeChat((idOf) => [
        // Right: the same value read the same way, whatever shape it has.
        { id: idOf('steps.get.output.orders[0].total'), binding: TOTAL },
        // No pick upper-cases: the address as it is differs everywhere. Discarded.
        { id: idOf('upper(trigger.output.Klant["E-mail adres"])'), binding: pick({ root: 'trigger', path: ['Klant', 'E-mail adres'] }) },
        // The same text today, but a `+` writes a missing id as "undefined" and
        // a compose as nothing: a later run would differ. Discarded.
        { id: idOf('"Order " + steps.get.output.orders[0].id'), binding: { kind: 'compose', parts: ['Order ', { from: { root: 'steps', id: 'get', path: ['orders', 0, 'id'] }, take: 'one', as: 'text' }] } },
        // Another step that holds the same value in the dry run (the step itself,
        // here): at run time it has not run yet. Discarded.
        { id: idOf('steps.get.output.orders[0].id'), binding: pick({ root: 'steps', id: 'mail', path: ['orders', 0, 'id'] }) },
        // An unknown id and a second answer for the same field are ignored.
        { id: 'f99', binding: pick(ORDERS) },
        { id: idOf('steps.get.output.orders[0].total'), binding: pick(ORDERS, 'all') },
    ]);
    const result = upgraded();
    // The step the wrong proposal reads holds the same orders in the dry run.
    result.states.lastRun = { ...lastRun, steps: { ...lastRun.steps, mail: { output: LAST_ORDERS } } };
    result.states.sample = { ...sample, steps: { ...sample.steps, mail: { output: PINNED_ORDERS } } };
    const out = await suggestAiFixes(result, chat);
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(out.suggestions.map(s => s.field), ['inputs.total']);
    assert.deepStrictEqual(out.counts, { candidates: 6, noEvidence: 2, asked: 4, accepted: 1, discarded: 3, truncated: false });
    assert.deepStrictEqual(out.suggestions[0], {
        stepId: 'mail', step: 'Mail klant', field: 'inputs.total', kind: 'expr', binding: TOTAL,
        take: 'one', root: 'steps', source: 'Orders ophalen', label: 'Orders › Total',
    });

    // What was accepted resolves as the field does, on both runStates.
    const resolver = createResolver({ evaluate, parse });
    const mail = definition().steps[1].inputs;
    for (const s of out.suggestions) {
        const key = s.field.split('.')[1];
        for (const state of [lastRun, sample]) {
            assert.deepStrictEqual(resolver.resolveValue(s.binding, state, { silent: true }), resolver.resolveValue(mail[key], state, { silent: true }));
        }
    }
    assert.ok(!JSON.stringify(out).includes('SENTINEL'), 'the answer holds no value from the data');
});

test('privacy: the prompt holds the field texts and the shape of the data, never a value', async () => {
    const { chat, calls } = fakeChat(() => []);
    await suggestAiFixes(upgraded(), chat);
    const [{ messages, tool }] = calls;
    assert.strictEqual(tool, PROPOSE_TOOL);
    const prompt = messages.map(m => m.content).join('\n');
    assert.ok(!prompt.includes('SENTINEL'), 'no value of a run or a sample reaches the model');
    assert.ok(!prompt.includes('sentinel-anna@'), 'no address either');
    assert.ok(!prompt.includes('sentinel-key@x.nl'), 'a key that is no field name is only counted');
    assert.ok(!prompt.includes('12345'), 'nor is a number used as a key');
    assert.ok(!prompt.includes('2026-10-01'), 'nor a time the run started');
    assert.ok(!prompt.includes('17.5'));
    assert.ok(!prompt.includes('Jan de Vries'), 'a name used as a key is only counted');
    assert.ok(!prompt.includes('Order-Smith'), 'so is a company\'s');
    const payload = JSON.parse(messages[1].content.slice(messages[1].content.indexOf('\n') + 1));
    assert.deepStrictEqual(payload.fields.map(f => f.text), [
        'upper(trigger.output.Klant["E-mail adres"])', '"Order " + steps.get.output.orders[0].id',
        'steps.get.output.orders[0].total', 'steps.get.output.orders[0].id',
    ]);
    assert.deepStrictEqual(payload.fields[0].slot, { as: 'native', multiLine: false });
    assert.deepStrictEqual(payload.dataShape['steps.get'], {
        output: { orders: [{ id: 'text', total: 'number' }], note: { $jsonText: { inner: 'text' } }, empty: [] },
    });
    // 'E-mail adres' is no field name, but the field text quotes it: it says nothing new.
    assert.deepStrictEqual(payload.dataShape.trigger.output, { Klant: { naam: 'text', 'E-mail adres': 'text' }, $otherKeys: 4 });
});

test('a field without data is never sent; with nothing to ask the model is not called', async () => {
    const { chat, calls } = fakeChat(() => []);
    const out = await suggestAiFixes(upgraded(definition(), { lastRun: null, sample: null }), chat);
    assert.strictEqual(calls.length, 0);
    assert.deepStrictEqual(out.counts, { candidates: 6, noEvidence: 6, asked: 0, accepted: 0, discarded: 0, truncated: false });
    assert.deepStrictEqual(out.suggestions, []);

    // With data, 'nothing' (which no runState fills) and 'empty' (null on one,
    // an empty list on the other: no value either) are still left out.
    const second = fakeChat(() => []);
    await suggestAiFixes(upgraded(), second.chat);
    assert.ok(!second.calls[0].messages[1].content.includes('nowhere'));
    assert.ok(!second.calls[0].messages[1].content.includes('output.empty'));
});

test('dataShape: types, lists and JSON texts, never a value', () => {
    assert.deepStrictEqual(dataShape({ a: 'x', b: 1, c: true, d: null, e: [], f: [{ g: 'y' }, { h: 2 }], i: '[1,2]' }), {
        a: 'text', b: 'number', c: 'boolean', d: 'null', e: [], f: [{ g: 'text', h: 'number' }], i: { $jsonText: ['number'] },
    });
    assert.deepStrictEqual(dataShape(['a', 1]), ['number|text']);
    assert.strictEqual(dataShape(undefined), undefined);
});

test('toBinding: only a pick or a compose, in its stored form', () => {
    assert.deepStrictEqual(toBinding({ kind: 'pick', from: 'steps.get.output.orders[*].id', take: 'all', as: 'text', join: 'comma', extra: 'x' }),
        pick(ORDERS, 'all', 'text', { join: 'comma' }));
    assert.strictEqual(toBinding({ kind: 'expr', value: '1' }), null);
    assert.strictEqual(toBinding({ kind: 'compose', parts: [] }), null);
    assert.strictEqual(toBinding({ kind: 'compose', parts: ['a', { nope: 1 }] }), null);
    assert.strictEqual(toBinding('steps.get.output.x'), null);
});

test('applying: every suggestion checked again, all or nothing', () => {
    const result = upgraded();
    const good = { stepId: 'mail', field: 'inputs.total', binding: pick({ root: 'steps', id: 'get', path: ['orders', 0, 'total'] }) };
    const ok = applyAiFixes(result, [good]);
    assert.ok(!ok.refused);
    assert.deepStrictEqual(ok.definition.steps[1].inputs.total, good.binding);
    assert.deepStrictEqual(ok.applied.map(a => [a.field, a.ai, a.take]), [['inputs.total', true, 'one']]);
    assert.deepStrictEqual(result.definition.steps[1].inputs.total, expr('steps.get.output.orders[0].total'), 'the upgrade result is not changed');

    const differs = { stepId: 'mail', field: 'inputs.shout', binding: pick({ root: 'trigger', path: ['Klant', 'E-mail adres'] }) };
    assert.deepStrictEqual(applyAiFixes(result, [good, differs]), { refused: { stepId: 'mail', field: 'inputs.shout', reason: 'would_change' } });
    // count() as a count agrees on both runStates, and not on an empty list or a text: never the fix's.
    const count = { stepId: 'mail', field: 'inputs.count', binding: pick({ root: 'steps', id: 'get', path: ['orders'] }, 'count') };
    assert.deepStrictEqual(applyAiFixes(result, [count]).refused.reason, 'stale');
    assert.deepStrictEqual(applyAiFixes(result, [{ stepId: 'mail', field: 'inputs.to', binding: good.binding }]).refused.reason, 'stale', 'an upgraded field is not the AI fix\'s');
    assert.deepStrictEqual(applyAiFixes(result, [{ stepId: 'l1', field: 'inputs.z', binding: good.binding }]).refused.reason, 'stale', 'nor a flowlet\'s');
    assert.deepStrictEqual(applyAiFixes(result, [{ ...good, binding: { kind: 'pick' } }]).refused.reason, 'invalid');
    const noData = upgraded(definition(), { lastRun: null, sample: null });
    assert.deepStrictEqual(applyAiFixes(noData, [good]).refused.reason, 'no_evidence');
});

test('every recent run is its own runState: a proposal equal on the newest run and not on an older one is dropped, and refused on apply', async () => {
    const def = {
        trigger: { id: 't', type: 'trigger', kind: 'webhook' },
        steps: [{ id: 'mail', type: 'integration_action', label: 'Mail', inputs: { id: expr('trigger.output.orders.id') } }],
        edges: [],
    };
    const run = (output) => ({ trigger: { output }, steps: {}, vars: {}, loop: {} });
    const newest = run({ orders: { id: 'SENTINEL-A-1' } });
    const older = run({ orders: [{ id: 'SENTINEL-B-1' }, { id: 'SENTINEL-B-2' }] });
    const fix = { stepId: 'mail', field: 'inputs.id', binding: pick({ root: 'trigger', path: ['orders', 'id'] }) };
    const answer = (idOf) => [{ id: idOf('trigger.output.orders.id'), binding: fix.binding }];

    // On the newest run alone the proposal agrees.
    const one = upgraded(def, { runs: [newest], sample: null });
    assert.strictEqual((await suggestAiFixes(one, fakeChat(answer).chat)).counts.accepted, 1);
    assert.ok(!applyAiFixes(one, [fix]).refused);

    const both = upgraded(def, { runs: [newest, older], sample: null });
    const out = await suggestAiFixes(both, fakeChat(answer).chat);
    assert.deepStrictEqual([out.counts.accepted, out.counts.discarded], [0, 1]);
    // A run that came in since the suggestion was made: the apply-time check sees it.
    assert.deepStrictEqual(applyAiFixes(both, [fix]), { refused: { stepId: 'mail', field: 'inputs.id', reason: 'would_change' } });

    const agreeing = upgraded(def, { runs: [newest, run({ orders: { id: 'SENTINEL-C-1' } })], sample: null });
    assert.ok(!applyAiFixes(agreeing, [fix]).refused, 'equal on every run is accepted');
});
