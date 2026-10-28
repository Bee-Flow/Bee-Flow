'use strict';

/** Steps that read each other's output are an error (#216). Run: node --test automation/validate/dataRefCycles.test.js */

const test = require('node:test');
const assert = require('node:assert');
const { validateDefinition } = require('../validate');

const trigger = { id: 'trg', type: 'trigger', kind: 'manual' };
const note = (id, text) => ({ id, type: 'notification', title: 't', body: text });
const def = (steps) => ({
    trigger, steps,
    edges: [{ from: 'trg', to: steps[0].id }, ...steps.slice(1).map((s, i) => ({ from: steps[i].id, to: s.id }))],
});
const codes = (v) => [...v.errors, ...v.warnings].map(f => f.code);

test('A reads B and B reads A is an error naming both steps', () => {
    const v = validateDefinition(def([note('a', '{{steps.b.output.x}}'), note('b', '{{steps.a.output.y}}')]));
    const hit = v.errors.find(e => e.code === 'ref.cycle');
    assert.ok(hit, codes(v).join(', '));
    assert.match(hit.message, /a and b/);
    assert.strictEqual(v.ok, false);
});

test('a longer chain of reads is caught too', () => {
    const v = validateDefinition(def([note('a', '{{steps.c.output.x}}'), note('b', '{{steps.a.output.x}}'), note('c', '{{steps.b.output.x}}')]));
    assert.ok(v.errors.some(e => e.code === 'ref.cycle'));
});

test('a cycle through an expression binding is caught', () => {
    const a = { id: 'a', type: 'set', fields: { v: { kind: 'expr', value: 'steps.b.output.w + 1' } } };
    const b = { id: 'b', type: 'set', fields: { w: { kind: 'ref', path: 'steps.a.output.v' } } };
    assert.ok(validateDefinition(def([a, b])).errors.some(e => e.code === 'ref.cycle'));
});

test('a plain forward read is ref.forward (not a cycle), and an ordered read is clean', () => {
    const fwd = validateDefinition(def([note('a', '{{steps.b.output.x}}'), note('b', 'x')]));
    assert.ok(!fwd.errors.some(e => e.code === 'ref.cycle'));
    assert.ok(fwd.errors.some(w => w.code === 'ref.forward'));
    const ordered = validateDefinition(def([note('a', 'x'), note('b', '{{steps.a.output.x}}')]));
    assert.ok(!codes(ordered).includes('ref.cycle'));
});

test('at the draft stage the cycle is a warning (building through it), at activate it blocks', () => {
    const d = def([note('a', '{{steps.b.output.x}}'), note('b', '{{steps.a.output.y}}')]);
    const draft = validateDefinition(d, { stage: 'draft' });
    assert.ok(!draft.errors.some(e => e.code === 'ref.cycle'));
    assert.ok(draft.warnings.some(w => w.code === 'ref.cycle'));
});
