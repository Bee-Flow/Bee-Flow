/**
 * bindings — the AI builder never corrupts a valid path, and never touches
 * the inputs a patch did not name.
 *
 * REGRESSION (findings C1 / audit:binding-modes, 2026-10): every builder tool
 * ran its inputs through a canonicaliser that rewrote `[0]` to `.0`, cut
 * `["Story Points"]` to `.Story` and `[*]` to a trailing dot; and
 * builder_update_step merged the step's existing inputs into the patch and
 * re-canonicalised them all, so one AI edit of `subject` silently broke a
 * hand-mapped `to`. Each case here resolves to the same value before and
 * after the builder saw it.
 *
 * Run: cd server && node --test automation/builderTools/bindings.paths.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateAndFixBindings, sanitizeForEach, loopVarsReadBy } = require('./bindings');
const { applyUpdateStep } = require('./stepEditing');
const { resolveValue } = require('../bind');

const ref = path => ({ kind: 'ref', path });
// Steps whose output nothing declares (ai_steps without an outputSchema), so
// only the path grammar is under test. Not code steps: refCheck knows their
// { result, logs, httpCalls } envelope and would read these under .result.
const draft = { trigger: { id: 'trg', kind: 'manual' }, steps: [{ id: 'g', type: 'ai_step' }, { id: 'shop', type: 'ai_step' }, { id: 'j', type: 'ai_step' }], edges: [] };
const runState = {
    trigger: { output: {} },
    steps: {
        g: { output: { value: [{ subject: 'Invoice 1', from: { emailAddress: { address: 'a@x.nl' } } }, { subject: 'Invoice 2' }], '@odata.nextLink': 'https://next', headers: { 'content-type': 'application/json', content: 'WRONG' } } },
        shop: { output: { order: { price: '10.00', 'price-with-tax': '12.10' } } },
        j: { output: { fields: { 'Story Points': 5, Story: 'wrong' } } },
    },
};

const CASES = {
    first: 'steps.g.output.value[0].from.emailAddress.address',
    all: 'steps.g.output.value[*].subject',
    next: 'steps.g.output["@odata.nextLink"]',
    ct: 'steps.g.output.headers["content-type"]',
    sp: 'steps.j.output.fields["Story Points"]',
    tax: 'steps.shop.output.order["price-with-tax"]',
};

test('every bracket path survives validateAndFixBindings verbatim and resolves to the same value', () => {
    const inputs = Object.fromEntries(Object.entries(CASES).map(([k, p]) => [k, ref(p)]));
    const r = validateAndFixBindings(inputs, draft);
    assert.equal(r.error, null);
    for (const [k, p] of Object.entries(CASES)) {
        assert.equal(r.inputs[k].path, p, k);
        assert.deepEqual(resolveValue(r.inputs[k], runState), resolveValue(ref(p), runState), k);
    }
    assert.equal(resolveValue(r.inputs.tax, runState), '12.10', 'price-with-tax, not price');
    assert.equal(resolveValue(r.inputs.sp, runState), 5);
    assert.deepEqual(resolveValue(r.inputs.all, runState), ['Invoice 1', 'Invoice 2']);
    assert.equal(r.notes, undefined, 'nothing was rewritten, so nothing is said');
});

test('builder_update_step leaves the inputs the patch did not name byte-identical', () => {
    const g = {
        trigger: { kind: 'manual', id: 'trg' },
        steps: [
            { id: 'graph', type: 'integration_action', tool: 'x', inputs: {} },
            { id: 'notify', type: 'integration_action', tool: 'outlook_send_mail', inputs: {
                to: ref('steps.graph.output.value[0].from.emailAddress.address'),
                points: ref('steps.graph.output.fields["Story Points"]'),
                all: ref('steps.graph.output.value[*].subject'),
                odd: { kind: 'ref', path: 'steps.graph.output.weird path' },
                subject: { kind: 'literal', value: 'hi' },
            } },
        ],
        edges: [],
    };
    const before = JSON.parse(JSON.stringify(g.steps[1].inputs));
    const r = applyUpdateStep(g, { stepId: 'notify', patch: { inputs: { subject: { kind: 'literal', value: 'Re' } } } }, { def: g });
    assert.ok(!r.error, r.error);
    const after = g.steps[1].inputs;
    for (const k of ['to', 'points', 'all', 'odd']) assert.deepEqual(after[k], before[k], `${k} untouched`);
    assert.deepEqual(after.subject, { kind: 'literal', value: 'Re' });
});

test('a forEach over a [*] path keeps it (it used to become "results.")', () => {
    const r = sanitizeForEach({ overRef: 'steps.read.output.results[*].output.attachments', itemVar: 'a' }, draft);
    assert.ok(!r.error, r.error);
    assert.equal(r.forEach.overRef, 'steps.read.output.results[*].output.attachments');
});

test('template placeholders are scanned quote-aware and respelled canonically', () => {
    const r = validateAndFixBindings({
        body: { kind: 'template', value: 'Key {{ steps.g.output["a}b"] }} and {{ trigger.output.attachments.0.filename }}' },
    }, draft);
    assert.equal(r.error, null);
    assert.equal(r.inputs.body.value, 'Key {{steps.g.output["a}b"]}} and {{trigger.output.attachments[0].filename}}');
    assert.match(r.notes.join('\n'), /\[0\], not \.0/);
});

test('a template placeholder that is an expression is said, not silently kept', () => {
    const r = validateAndFixBindings({ body: { kind: 'template', value: 'Total {{ steps.g.output.total + 1 }}' } }, draft);
    assert.equal(r.error, null);
    assert.match(r.notes.join('\n'), /is not a path/);
});

test('loopVarsReadBy reads the var through brackets and quote-aware placeholders', () => {
    const reads = loopVarsReadBy({ a: ref('loop.f["Story Points"]'), b: { kind: 'template', value: '{{ loop.x.output["a}b"] }}' } });
    assert.deepEqual(reads.map(r => r.v), ['f', 'x']);
});

// A snowflake id (Discord, Twitter) as a key is beyond the safe-integer
// range: read as a number it would round to another id. The shared grammar
// quotes such a digit key (formatKey), and the builder must keep every
// digit — in a ref, a template, and checked against a dry run that has it.
test('a quoted snowflake key keeps its digits through the builder', () => {
    const { rememberStepShape } = require('./refCheck');
    const id = '123456789012345678901';
    const dw = { def: draft };
    rememberStepShape(dw, draft.steps[0], { [id]: 'snow', items: { [id]: { id: 'deep' } } });
    for (const p of [`steps.g.output["${id}"]`, `steps.g.output.items["${id}"].id`]) {
        const r = validateAndFixBindings({ v: ref(p), t: { kind: 'template', value: `x {{${p}}}` } }, draft, { draftWrap: dw });
        assert.equal(r.error, null, p);
        assert.equal(r.inputs.v.path, p);
        assert.equal(r.inputs.t.value, `x {{${p}}}`);
        assert.equal(r.notes, undefined, p);
    }
    const snowState = { trigger: { output: {} }, steps: { g: { output: { [id]: 'snow' } } } };
    const dotted = validateAndFixBindings({ v: ref(`steps.g.output.${id}`) }, draft, { draftWrap: dw });
    assert.equal(dotted.inputs.v.path, `steps.g.output["${id}"]`, 'the dotted spelling is quoted, not rounded');
    assert.equal(resolveValue(dotted.inputs.v, snowState), 'snow');
});

// REGRESSION (code review 2026-10): `..` inside a quoted key was collapsed,
// so the template rendered empty (`["Total.."]` → `["Total."]`).
test('a quoted key with dots in it is kept byte for byte in a ref and a template', () => {
    const p = 'steps.g.output["Total.."]';
    const r = validateAndFixBindings({ v: ref(p), t: { kind: 'template', value: `N: {{${p}}}` } }, draft, {});
    assert.equal(r.inputs.v.path, p);
    assert.equal(r.inputs.t.value, `N: {{${p}}}`);
    assert.equal(resolveValue(r.inputs.v, { trigger: { output: {} }, steps: { g: { output: { 'Total..': 42 } } } }), 42);
});
