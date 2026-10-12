const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyToolCall } = require('../builderTools');
const { validateDefinition } = require('../validate');

const ref = (path) => ({ kind: 'ref', path });
const wrap = (def) => ({ userId: 'u1', def });

// Main flow: trigger -> fetch -> CALL(enrich) -> mail. The flowlet "enrich"
// takes `email`, sets a greeting from it and returns it as `greeting`.
function definition() {
    return {
        schemaVersion: 2,
        trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} },
        steps: [
            { id: 'fetch', type: 'set', label: 'Fetch', settings: { assignments: [{ var: 'mail', value: ref('trigger.output.email') }] } },
            { id: 'call', type: 'call_layer', layerKey: 'enrich', label: 'Enrich', inputs: { email: ref('steps.fetch.output.mail') } },
            { id: 'send', type: 'set', label: 'Send', settings: { assignments: [{ var: 'to', value: ref('steps.call.output.greeting') }, { var: 'note', value: { kind: 'template', value: 'Hi {{steps.call.output.greeting}}!' } }] } },
        ],
        edges: [{ from: 'trg', to: 'fetch' }, { from: 'fetch', to: 'call' }, { from: 'call', to: 'send' }],
        layers: {
            enrich: {
                title: 'Enrich',
                trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [{ name: 'email', type: 'string', required: true }] },
                steps: [
                    { id: 'fetch', type: 'set', label: 'Greet', settings: { assignments: [{ var: 'g', value: { kind: 'template', value: 'Dear {{trigger.output.email}}' } }] }, forEach: undefined },
                    { id: 'out', type: 'layer_output', label: 'Return', fields: { greeting: ref('steps.fetch.output.g') } },
                ],
                edges: [{ from: 'trg', to: 'fetch' }, { from: 'fetch', to: 'out' }],
            },
        },
    };
}

test('inlining moves the flowlet steps in, maps inputs and returns, and removes the call and the flowlet', async () => {
    const dw = wrap(definition());
    const r = await applyToolCall('builder_inline_layer', { stepId: 'call' }, dw);
    assert.ok(!r.error, r.error);
    const def = dw.def;
    assert.deepEqual(def.steps.map(s => s.label), ['Fetch', 'Greet', 'Send'], 'the flowlet step sits where the call was');
    assert.ok(!def.steps.some(s => s.type === 'call_layer' || s.type === 'layer_output'));
    const greet = def.steps[1];
    assert.notEqual(greet.id, 'fetch', 'fresh id, no clash with the main flow');
    // The flowlet's input became the call's binding, inside the template too.
    assert.equal(greet.settings.assignments[0].value.value, 'Dear {{steps.fetch.output.mail}}');
    // The downstream reads now point at the flowlet's Return binding.
    const send = def.steps[2];
    assert.equal(send.settings.assignments[0].value.path, `steps.${greet.id}.output.g`);
    assert.equal(send.settings.assignments[1].value.value, `Hi {{steps.${greet.id}.output.g}}!`);
    assert.deepEqual(def.edges, [{ from: 'trg', to: 'fetch' }, { from: 'fetch', to: greet.id }, { from: greet.id, to: 'send' }]);
    assert.equal(def.layers.enrich, undefined, 'unused flowlet is removed');
    assert.deepEqual(r.inlined.movedStepIds, [greet.id]);
    const v = validateDefinition(def);
    assert.ok(!v.errors.some(e => /ref\.|edge\.|call_layer\./.test(String(e.code))), JSON.stringify(v.errors));
});

test('a flowlet that is still called elsewhere is kept', async () => {
    const d = definition();
    d.steps.push({ id: 'again', type: 'call_layer', layerKey: 'enrich', inputs: { email: ref('trigger.output.email') } });
    d.edges.push({ from: 'send', to: 'again' });
    const dw = wrap(d);
    const r = await applyToolCall('builder_inline_layer', { stepId: 'call' }, dw);
    assert.ok(!r.error, r.error);
    assert.ok(dw.def.layers.enrich);
    assert.match(r._note, /still called elsewhere/);
});

test('a literal Return replaces a whole-binding read but cannot stand inside a template: refused, nothing changes', async () => {
    const d = definition();
    d.layers.enrich.steps[1].fields.greeting = { kind: 'literal', value: 'hello' };
    const ok = wrap(structuredClone(d));
    const r = await applyToolCall('builder_inline_layer', { stepId: 'call' }, ok);
    // The template read `Hi {{...greeting}}` cannot hold a literal binding: refused.
    assert.match(r.error, /Cannot inline flowlet "enrich"/);
    assert.match(r.error, /Nothing changed/);
    assert.deepEqual(ok.def, d, 'a refusal leaves the definition untouched');

    // Without the template read, the whole-binding read takes the literal over.
    d.steps[2].settings.assignments.pop();
    const fine = wrap(d);
    assert.ok(!(await applyToolCall('builder_inline_layer', { stepId: 'call' }, fine)).error);
    assert.deepEqual(fine.def.steps[2].settings.assignments[0].value, { kind: 'literal', value: 'hello' });
});

test('an input read inside an expression is refused, naming the step, and nothing changes', async () => {
    const d = definition();
    d.layers.enrich.steps.splice(1, 0, { id: 'chk', type: 'condition', label: 'Check', expr: 'trigger.output.email != ""' });
    d.layers.enrich.edges = [{ from: 'trg', to: 'fetch' }, { from: 'fetch', to: 'chk' }, { from: 'chk', to: 'out', label: 'then' }];
    const dw = wrap(structuredClone(d));
    const r = await applyToolCall('builder_inline_layer', { stepId: 'call' }, dw);
    assert.match(r.error, /read the flowlet's inputs in a form that cannot be mapped/);
    assert.deepEqual(dw.def, d);
});

test('a call with an error branch, a forEach, or inside a loop body is refused', async () => {
    const withError = definition();
    withError.steps.push({ id: 'oops', type: 'set', label: 'Oops', settings: { assignments: [] } });
    withError.edges.push({ from: 'call', to: 'oops', label: 'on_error' });
    assert.match((await applyToolCall('builder_inline_layer', { stepId: 'call' }, wrap(withError))).error, /error branch/);

    const perItem = definition();
    perItem.steps[1].forEach = { overRef: 'trigger.output.items', itemVar: 'it' };
    assert.match((await applyToolCall('builder_inline_layer', { stepId: 'call' }, wrap(perItem))).error, /forEach/);

    const looped = definition();
    looped.steps.push({ id: 'lp', type: 'loop', label: 'Each', body: [{ id: 'inner', type: 'call_layer', layerKey: 'enrich', inputs: { email: ref('trigger.output.email') } }] });
    assert.match((await applyToolCall('builder_inline_layer', { stepId: 'inner' }, wrap(looped))).error, /loop body/);
});

test('unknown steps and steps that are not a flowlet call are refused with a hint', async () => {
    assert.match((await applyToolCall('builder_inline_layer', { stepId: 'nope' }, wrap(definition()))).error, /Unknown stepId/);
    assert.match((await applyToolCall('builder_inline_layer', { stepId: 'send' }, wrap(definition()))).error, /not a call_layer step/);
    assert.match((await applyToolCall('builder_inline_layer', {}, wrap(definition()))).error, /needs stepId/);
});

test('a branching flowlet keeps its labels and fans back in to the follower', async () => {
    const d = definition();
    d.layers.enrich.steps = [
        { id: 'chk', type: 'condition', label: 'Check', expr: 'true' },
        { id: 'a', type: 'set', label: 'A', settings: { assignments: [] } },
        { id: 'out', type: 'layer_output', label: 'Return', fields: { greeting: ref('trigger.output.email') } },
    ];
    d.layers.enrich.edges = [{ from: 'trg', to: 'chk' }, { from: 'chk', to: 'a', label: 'then' }, { from: 'chk', to: 'out', label: 'else' }, { from: 'a', to: 'out' }];
    const dw = wrap(d);
    const r = await applyToolCall('builder_inline_layer', { stepId: 'call' }, dw);
    assert.ok(!r.error, r.error);
    const [chk, a] = r.inlined.movedStepIds;
    assert.deepEqual(dw.def.edges.filter(e => e.from === chk).sort((x, y) => x.label.localeCompare(y.label)), [
        { from: chk, to: 'send', label: 'else' }, { from: chk, to: a, label: 'then' }]);
    assert.ok(dw.def.edges.some(e => e.from === a && e.to === 'send'));
    // A pass-through Return (trigger.output.email) resolved all the way to the call's input.
    assert.equal(dw.def.steps.find(s => s.id === 'send').settings.assignments[0].value.path, 'steps.fetch.output.mail');
});

test('the tool is a staged mutation in approve mode and scoped like the other graph tools', () => {
    const { MUTATING_TOOLS, SCOPED_GRAPH_TOOLS } = require('../builderTools');
    assert.ok(MUTATING_TOOLS.has('builder_inline_layer'));
    assert.ok(SCOPED_GRAPH_TOOLS.has('builder_inline_layer'));
});
