/**
 * Step ids and generated field names the binding grammar cannot address.
 *
 * Run: node --test automation/validate.bindableNames.test.js
 *
 * bind.js's REF_RE is the authority on what a reference path may contain, and
 * its head production is `[A-Za-z_$][A-Za-z0-9_$]*`. Anything else in a step id
 * or an output field name does NOT fail loudly — it means something else:
 * `steps.my-step.output.n` parses as a SUBTRACTION and evaluates to NaN, which
 * is why the condition below silently takes the wrong branch on every run.
 * Nothing checked either at creation time.
 *
 * These are WARNINGS, not errors, and that is deliberate: the validator sees
 * one definition at a time with no "before" to diff against, so it cannot tell
 * a newly-typed bad id from one a customer automation has carried for months —
 * and an error would make those automations unsaveable.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateDefinition } = require('./validate');
const { evaluate } = require('./expr');

const trigger = () => ({ id: 'trg', kind: 'manual' });
const codesOf = (r) => [...r.errors, ...r.warnings].map(x => x.code);
const findRec = (r, code) => [...r.errors, ...r.warnings].find(x => x.code === code);

test('the symptom: a hyphenated id makes a condition evaluate as a subtraction', () => {
    // Not a validator assertion — the reason the rule exists. If this ever
    // stops being true the warning below can go.
    const state = { steps: { 'my-step': { output: { n: 5 } } } };
    assert.ok(Number.isNaN(evaluate('steps.my-step.output.n', state)), 'reads as steps.my - step.output.n');
    assert.equal(evaluate('steps["my-step"].output.n', state), 5, 'only the bracket form reaches it');
});

test('a step id the binding grammar cannot address is flagged — without blocking the save', () => {
    const def = {
        trigger: trigger(),
        steps: [
            { id: 'my-step', type: 'notification', title: 't', body: 'b', channels: ['notification'] },
            { id: 'ok_step', type: 'notification', title: 't', body: 'b', channels: ['notification'] },
        ],
        edges: [{ from: 'trg', to: 'my-step' }, { from: 'my-step', to: 'ok_step' }],
    };
    const r = validateDefinition(def);
    const rec = r.warnings.find(w => w.code === 'step.id_unbindable');
    assert.ok(rec, `expected step.id_unbindable, got ${JSON.stringify(codesOf(r))}`);
    assert.equal(rec.severity, 'warning');
    assert.match(rec.path, /steps\[0\]\.id/);
    assert.match(rec.hint, /my_step/, 'the hint offers a usable id');
    // Stored automations already carrying such an id must keep saving AND keep
    // activating — the warning is the whole intervention.
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(validateDefinition(def, { stage: 'draft' }).ok, true);
});

test('only ONE id is flagged — the well-formed sibling is left alone', () => {
    const r = validateDefinition({
        trigger: trigger(),
        steps: [
            { id: 'has space', type: 'notification', title: 't', body: 'b', channels: ['notification'] },
            { id: '_fine$1', type: 'notification', title: 't', body: 'b', channels: ['notification'] },
        ],
        edges: [{ from: 'trg', to: 'has space' }, { from: 'has space', to: '_fine$1' }],
    });
    const flagged = r.warnings.filter(w => w.code === 'step.id_unbindable');
    assert.equal(flagged.length, 1);
    assert.match(flagged[0].message, /has space/);
});

test('ids inside a loop body are checked too — they write runState.steps[<id>] as well', () => {
    const r = validateDefinition({
        trigger: trigger(),
        steps: [{
            id: 'lp', type: 'loop', overRef: 'trigger.output.items', itemVar: 'item', maxIterations: 5,
            body: [{ id: 'send-mail', type: 'notification', title: 't', body: 'b', channels: ['notification'] }],
        }],
        edges: [{ from: 'trg', to: 'lp' }],
    });
    const rec = r.warnings.find(w => w.code === 'step.id_unbindable');
    assert.ok(rec, JSON.stringify(codesOf(r)));
    assert.match(rec.path, /steps\[lp\]\.body\.steps\[send-mail\]\.id/);
});

test('an ordinary builder-generated id never trips it', () => {
    const r = validateDefinition({
        trigger: trigger(),
        steps: [{ id: 'cond_7c17a2e6', type: 'condition', expr: 'true' }],
        edges: [{ from: 'trg', to: 'cond_7c17a2e6' }, { from: 'cond_7c17a2e6', to: 'cond_7c17a2e6', label: 'then' }],
    });
    assert.equal(findRec(r, 'step.id_unbindable'), undefined);
});

test('a set field name that cannot be bound downstream is flagged the same way', () => {
    const r = validateDefinition({
        trigger: trigger(),
        steps: [{
            id: 's1', type: 'set',
            fields: { 'total-vat': { kind: 'literal', value: 1 }, total_net: { kind: 'literal', value: 2 } },
        }],
        edges: [{ from: 'trg', to: 's1' }],
    });
    const rec = r.warnings.find(w => w.code === 'set.field_name_unbindable');
    assert.ok(rec, `expected set.field_name_unbindable, got ${JSON.stringify(codesOf(r))}`);
    assert.match(rec.path, /steps\[s1\]\.fields\.total-vat/);
    assert.match(rec.message, /steps\.s1\.output\.total-vat/, 'names the path that will not work');
    assert.match(rec.hint, /\["total-vat"\]/, 'and the bracket form that will');
    assert.equal(r.warnings.filter(w => w.code === 'set.field_name_unbindable').length, 1, 'total_net is fine');
    assert.equal(r.ok, true);
});

test('layer_output field names get the same check', () => {
    const r = validateDefinition({
        trigger: trigger(),
        steps: [{ id: 'out1', type: 'layer_output', fields: { 'customer.email': { kind: 'literal', value: 'a@b.nl' } } }],
        edges: [{ from: 'trg', to: 'out1' }],
    });
    assert.ok(codesOf(r).includes('layer_output.field_name_unbindable'), JSON.stringify(codesOf(r)));
});

test('the reserved __proto__ field name is still a hard ERROR, not merely unbindable', () => {
    // Regression guard: the unbindable check must not swallow the C17 rule —
    // a `__proto__` key is not just awkward to bind, it never exists at all.
    // Built through JSON.parse, which is how a stored definition reaches the
    // validator — and the only way to get `__proto__` as an OWN key (an object
    // literal would set the prototype instead).
    const r = validateDefinition({
        trigger: trigger(),
        steps: [{ id: 's1', type: 'set', fields: JSON.parse('{"__proto__":{"kind":"literal","value":1}}') }],
        edges: [{ from: 'trg', to: 's1' }],
    });
    assert.ok(r.errors.some(e => e.code === 'set.field_name_reserved'), JSON.stringify(codesOf(r)));
    assert.equal(findRec(r, 'set.field_name_unbindable'), undefined, 'reported once, as the more serious problem');
});
