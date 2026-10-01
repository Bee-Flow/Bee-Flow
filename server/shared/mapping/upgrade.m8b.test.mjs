/**
 * upgrade.mjs, M8b: legacyBindings / hasLegacyBindings (the builder's check
 * when an automation opens) and checkReplacement (the gate of the AI fix).
 *
 * Proven:
 *   - legacyBindings lists exactly what upgradeDefinition could rewrite: a
 *     forEach, every ref and expr in a binding site, in loop bodies and
 *     parallel branches; not a pick, a compose, a literal's data, a
 *     template, a text site or a flowlet's steps; an upgraded definition
 *     has none left where everything was upgraded;
 *   - checkReplacement accepts a proposal only when it reads exactly what the
 *     legacy binding reads, resolves to exactly what that resolves to on
 *     EVERY runState, one of them gives a value (null and [] are none), and
 *     it keeps agreeing when each value it reads is missing, null, an empty
 *     list, a list, a text, a record or a number: one runState or one shape
 *     that differs refuses it, no data refuses it;
 *   - refused before anything is resolved: a proposal that is no valid pick
 *     or compose, reads a repeat's or a loop's item, reads nothing, or reads
 *     another Source (a later step, the step itself, another key); a legacy
 *     binding that reads a loop's item or a row (no runState binds them, so
 *     a fallback formula looks like a constant), or calls first, last,
 *     count or join (they differ from their pick on [] and on a text).
 *
 * Run: cd server && node --test shared/mapping/upgrade.m8b.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate } from '../expr/index.mjs';
import * as parse from '../expr/parse.mjs';
import { checkReplacement, hasLegacyBindings, legacyBindings, replaceableBinding, upgradeDefinition } from './upgrade.mjs';

const deps = { evaluate, parse };
const ref = (path) => ({ kind: 'ref', path });
const expr = (value) => ({ kind: 'expr', value });
const pick = (from, take = 'one', as = 'native', extra = {}) => ({ kind: 'pick', v: 1, from, take, as, ...extra });
const state = (trigger, steps = {}) => ({ trigger: { output: trigger }, steps, vars: {}, loop: {} });

test('legacyBindings: the sites an upgrade rewrites, nothing else', () => {
    const def = {
        trigger: { kind: 'manual' },
        steps: [
            {
                id: 'a', type: 'integration_action',
                inputs: {
                    to: ref('trigger.output.email'),
                    n: expr('count(trigger.output.items)'),
                    done: pick({ root: 'trigger', path: ['x'] }),
                    lit: { kind: 'literal', value: { kind: 'ref', path: 'not.a.binding' } },
                    tpl: { kind: 'template', value: 'Hi {{trigger.output.name}}' },
                    nested: { list: [ref('trigger.output.a')] },
                },
            },
            { id: 'n', type: 'notification', body: 'Hello {{trigger.output.name}}' },
            { id: 'note', type: 'note', inputs: { x: ref('trigger.output.y') } },
            { id: 'fe', type: 'integration_action', forEach: { overRef: 'trigger.output.items', itemVar: 'it' }, inputs: { v: ref('loop.it.v') } },
            { id: 'lp', type: 'loop', overRef: 'trigger.output.items', body: [{ id: 'in', type: 'set', fields: { t: expr('1 + 1') } }] },
            { id: 'par', type: 'parallel', branches: [[{ id: 'b1', type: 'integration_action', inputs: { q: ref('steps.a.output.q') } }]] },
            { id: 'call', type: 'layer_call', layerKey: 'L' },
        ],
        layers: { L: { steps: [{ id: 'l1', type: 'integration_action', inputs: { z: ref('trigger.output.z') } }] } },
    };
    assert.deepEqual(legacyBindings(def), [
        { stepId: 'a', field: 'inputs.to', kind: 'ref', text: 'trigger.output.email' },
        { stepId: 'a', field: 'inputs.n', kind: 'expr', text: 'count(trigger.output.items)' },
        { stepId: 'a', field: 'inputs.nested.list.0', kind: 'ref', text: 'trigger.output.a' },
        { stepId: 'fe', field: 'forEach', kind: 'for_each', text: 'trigger.output.items' },
        { stepId: 'fe', field: 'inputs.v', kind: 'ref', text: 'loop.it.v' },
        { stepId: 'in', field: 'fields.t', kind: 'expr', text: '1 + 1' },
        { stepId: 'b1', field: 'inputs.q', kind: 'ref', text: 'steps.a.output.q' },
    ]);
    assert.equal(hasLegacyBindings(def), true);
});

test('hasLegacyBindings: false for nothing to upgrade, and after an upgrade that took everything', () => {
    assert.equal(hasLegacyBindings(null), false);
    assert.equal(hasLegacyBindings({ steps: 'x' }), false);
    assert.equal(hasLegacyBindings({ steps: [{ id: 'a', type: 'integration_action', inputs: { a: { kind: 'literal', value: 1 } } }] }), false);
    const def = { trigger: { kind: 'manual' }, steps: [{ id: 'a', type: 'integration_action', inputs: { to: ref('trigger.output.email') } }] };
    assert.equal(hasLegacyBindings(def), true);
    const up = upgradeDefinition(def, { sample: state({ email: 'x@y.z' }), ...deps });
    assert.equal(up.changed.length, 1);
    assert.equal(hasLegacyBindings(up.definition), false);
});

test('checkReplacement: the same value on every runState, and at least one value', () => {
    const lastRun = state({ customer: { name: 'a' } }, { get: { output: { lines: [{ sku: 'x' }] } } });
    const sample = state({ customer: { name: 'b' } }, { get: { output: { lines: [] } } });
    // A path written as a formula, or in a form REF_RE does not read: the same value.
    assert.deepEqual(checkReplacement(expr('trigger.output.customer.name'), pick({ root: 'trigger', path: ['customer', 'name'] }), { lastRun, sample, ...deps }), { ok: true });
    assert.deepEqual(checkReplacement(ref('trigger.output["customer"].name'), pick({ root: 'trigger', path: ['customer', 'name'] }), { lastRun, sample, ...deps }), { ok: true });
    assert.deepEqual(checkReplacement(expr('steps.get.output.lines[0]'), pick({ root: 'steps', id: 'get', path: ['lines', 0] }), { lastRun, sample, ...deps }), { ok: true });
    assert.deepEqual(checkReplacement(ref('trigger.firedAt'), pick({ root: 'run', path: ['firedAt'] }), { lastRun: { ...lastRun, trigger: { ...lastRun.trigger, firedAt: 't' } }, ...deps }), { ok: true });

    // Right on the last run, wrong on the pinned sample: one state is enough to refuse.
    const legacy = expr('trigger.output.n');
    const asText = pick({ root: 'trigger', path: ['n'] }, 'one', 'text');
    assert.deepEqual(checkReplacement(legacy, asText, { lastRun: state({ n: 'x' }), ...deps }), { ok: false, reason: 'would_change' }, 'and on a shape no run held');
    assert.deepEqual(checkReplacement(legacy, asText, { lastRun: state({ n: 'x' }), sample: state({ n: 1 }), ...deps }), { ok: false, reason: 'would_change' });
});

test('checkReplacement: the shapes a later run may hold, not only the ones at hand', () => {
    // first() of [] is null; take 'first' gives no value, so the input would be dropped.
    const items = state({ items: [1, 2] });
    assert.deepEqual(checkReplacement(expr('first(trigger.output.items)'), pick({ root: 'trigger', path: ['items'] }, 'first'), { lastRun: items, ...deps }), { ok: false, reason: 'invalid' });
    // count() of the text 'abc' is 3; take 'count' counts one value.
    assert.deepEqual(checkReplacement(expr('count(trigger.output.items)'), pick({ root: 'trigger', path: ['items'] }, 'count'), { lastRun: items, ...deps }), { ok: false, reason: 'invalid' });
    const lines = pick({ root: 'trigger', path: ['items', 'name'] }, 'all', 'text', { join: 'lines' });
    assert.deepEqual(checkReplacement(expr('join(trigger.output.items[*].name, "\\n")'), lines, { lastRun: state({ items: [{ name: 'a' }] }), ...deps }), { ok: false, reason: 'invalid' });
    // A list function inside another call, or in a string, is read as such.
    assert.equal(replaceableBinding(expr('upper(first(trigger.output.items))')), false);
    assert.equal(replaceableBinding(expr('"first(x)" + trigger.output.a')), true);

    // The same text today; with a missing id a `+` writes "Order undefined", a compose "Order ".
    const greet = expr('"Order " + steps.get.output.id');
    const compose = { kind: 'compose', v: 1, parts: ['Order ', { from: { root: 'steps', id: 'get', path: ['id'] }, take: 'one', as: 'text' }] };
    assert.deepEqual(checkReplacement(greet, compose, { lastRun: state({}, { get: { output: { id: 'A-1' } } }), ...deps }), { ok: false, reason: 'would_change' });
});

test('checkReplacement: no data, no change; undefined on one side is a difference', () => {
    const legacy = ref('trigger.output.name');
    const p = pick({ root: 'trigger', path: ['name'] });
    assert.deepEqual(checkReplacement(legacy, p, deps), { ok: false, reason: 'no_evidence' });
    assert.deepEqual(checkReplacement(legacy, p, { lastRun: state({}), ...deps }), { ok: false, reason: 'no_evidence' });
    // null and [] are no value either: a null everywhere agrees with anything else that is null.
    assert.deepEqual(checkReplacement(legacy, p, { lastRun: state({ name: null }), sample: state({ name: [] }), ...deps }), { ok: false, reason: 'no_evidence' });
    const nulls = state({ missing: null, other: null });
    assert.deepEqual(checkReplacement(ref('trigger.output.missing'), pick({ root: 'trigger', path: ['other'] }), { lastRun: nulls, ...deps }), { ok: false, reason: 'invalid' });
    assert.deepEqual(checkReplacement(ref('trigger.output.missing'), pick({ root: 'trigger', path: ['missing'] }), { lastRun: nulls, ...deps }), { ok: false, reason: 'no_evidence' });
    // A key on a list: the legacy walker reads nothing, the pick reads values.
    const onList = ref('trigger.output.items.name');
    assert.deepEqual(
        checkReplacement(onList, pick({ root: 'trigger', path: ['items', 'name'] }, 'all'), { lastRun: state({ items: [{ name: 'a' }] }), ...deps }),
        { ok: false, reason: 'would_change' },
    );
});

test('checkReplacement: only a valid pick or compose replaces a legacy ref or expr', () => {
    const lastRun = state({ name: 'x' });
    const legacy = ref('trigger.output.name');
    const ok = pick({ root: 'trigger', path: ['name'] });
    assert.deepEqual(checkReplacement(legacy, { ...ok, take: 'some' }, { lastRun, ...deps }), { ok: false, reason: 'invalid' });
    assert.deepEqual(checkReplacement(legacy, { ...ok, v: 2 }, { lastRun, ...deps }), { ok: false, reason: 'invalid' });
    assert.deepEqual(checkReplacement(legacy, ref('trigger.output.name'), { lastRun, ...deps }), { ok: false, reason: 'invalid' });
    assert.deepEqual(checkReplacement(legacy, pick({ root: 'trigger', path: ['name'] }, 'each'), { lastRun, ...deps }), { ok: false, reason: 'invalid' });
    assert.deepEqual(checkReplacement({ kind: 'template', value: '{{trigger.output.name}}' }, ok, { lastRun, ...deps }), { ok: false, reason: 'invalid' });
    assert.deepEqual(checkReplacement(legacy, ok, { lastRun, ...deps }), { ok: true });
});

test('checkReplacement: only the values the legacy binding reads, and only ones a runState holds', () => {
    // The dry run holds every step's final output, a later step's too: a step
    // that echoes the value passes the comparison and reads nothing at run time.
    const echoed = state({}, { get: { output: { id: 'A-1' } }, later: { output: { id: 'A-1' } } });
    const legacy = ref('steps.get.output.id');
    assert.deepEqual(checkReplacement(legacy, pick({ root: 'steps', id: 'later', path: ['id'] }), { lastRun: echoed, ...deps }), { ok: false, reason: 'invalid' });
    assert.deepEqual(checkReplacement(legacy, pick({ root: 'steps', id: 'get', path: ['id'] }), { lastRun: echoed, ...deps }), { ok: true });
    // Reading less than the legacy binding: what it leaves out may matter on a later run.
    const both = expr('steps.get.output.id + steps.later.output.id');
    const part = { from: { root: 'steps', id: 'get', path: ['id'] }, take: 'one', as: 'text' };
    assert.deepEqual(checkReplacement(both, { kind: 'compose', v: 1, parts: [part, part] }, { lastRun: echoed, ...deps }), { ok: false, reason: 'invalid' });

    // A loop's item is bound by no runState: a fallback looks like a constant to a dry run.
    const fallback = expr('loop.item.name || "Unknown"');
    assert.equal(replaceableBinding(fallback), false);
    assert.deepEqual(checkReplacement(fallback, { kind: 'compose', v: 1, parts: ['Unknown'] }, { lastRun: state({}), ...deps }), { ok: false, reason: 'invalid' });
    assert.equal(replaceableBinding(ref('loop.it.v')), false);
    assert.equal(replaceableBinding(ref('item.name')), false);
    assert.equal(replaceableBinding(expr('name + "!"')), false, 'a row\'s own key');
    assert.equal(replaceableBinding(expr('steps.get.output.items[n]')), false, 'a computed index');
    assert.equal(replaceableBinding(expr('"constant"')), false, 'reads nothing');
    // A proposal that reads an item, or nothing at all.
    assert.deepEqual(checkReplacement(legacy, pick({ root: 'loop', id: 'item', path: ['id'] }), { lastRun: echoed, ...deps }), { ok: false, reason: 'invalid' });
    assert.deepEqual(checkReplacement(legacy, { kind: 'compose', v: 1, parts: ['A-1'] }, { lastRun: echoed, ...deps }), { ok: false, reason: 'invalid' });
});
