/**
 * The parts of legacy.mjs and resolve.mjs the corpus cannot show as data:
 * reference isolation, the injected engine, the unresolved-path callback.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cloneLiteral, interpolateTemplate, walkPath } from './legacy.mjs';
import { createLegacyResolver } from './resolve.mjs';

const evaluate = (src, scope) => {
    if (src === 'throw') throw new Error('bad');
    return { src, hasSecret: scope.secrets && 'k' in scope.secrets };
};

test('createLegacyResolver needs an engine', () => {
    assert.throws(() => createLegacyResolver(), TypeError);
    assert.throws(() => createLegacyResolver({}), TypeError);
});

test('expr bindings go through the injected engine, which never sees secrets unless allowed', () => {
    const { resolveValue } = createLegacyResolver({ evaluate });
    const state = { secrets: { k: 1 } };
    assert.deepStrictEqual(resolveValue({ kind: 'expr', value: 'x' }, state), { src: 'x', hasSecret: false });
    assert.deepStrictEqual(resolveValue({ kind: 'expr', value: 'x' }, state, { allowSecrets: true }), { src: 'x', hasSecret: true });
    assert.equal(resolveValue({ kind: 'expr', value: 'throw' }, state), undefined);
    assert.deepStrictEqual(state, { secrets: { k: 1 } }, 'the run state itself is not touched');
});

test('literal values are copies: a step mutating its input cannot change the definition', () => {
    const { resolveValue, resolveInputs } = createLegacyResolver({ evaluate });
    const binding = { kind: 'literal', value: { nested: { count: 5 } } };
    resolveValue(binding, {}).nested.count = 999;
    assert.equal(binding.value.nested.count, 5);
    const shared = { count: 1 };
    const out = resolveInputs({ a: { kind: 'literal', value: shared }, b: { kind: 'literal', value: shared } }, {});
    out.a.count = 42;
    assert.equal(out.b.count, 1);
    assert.equal(cloneLiteral(7), 7);
    assert.equal(cloneLiteral(null), null);
});

test('cloneLiteral falls back to JSON where structuredClone cannot copy', () => {
    const value = { a: 1, fn() {} };
    assert.deepStrictEqual(cloneLiteral(value), { a: 1 });
});

test('onUnresolved hears every path that resolved to undefined, through both entry points', () => {
    const heard = [];
    const { interpolateTemplate: bound, resolveValue } = createLegacyResolver({ evaluate, onUnresolved: (p) => heard.push(p) });
    const state = { trigger: { output: { a: 1, nil: null } } };
    assert.equal(bound('{{trigger.output.a}} {{ trigger.output.b }} {{trigger.output.nil}}', state), '1  ');
    assert.equal(resolveValue({ kind: 'template', value: '{{x.y}}' }, state), '');
    assert.deepStrictEqual(heard, ['trigger.output.b', 'x.y']);
    assert.equal(interpolateTemplate('{{nope}}', state), '', 'the plain export works without a callback');
});

test('interpolateTemplate without a warnings array, or without a run state, still renders', () => {
    assert.equal(interpolateTemplate('a{{b}}c', {}), 'ac');
    assert.equal(interpolateTemplate('a{{b}}c', null), 'ac');
    assert.equal(interpolateTemplate('a{{b}}c', undefined, { leaveUnresolved: true }), 'a{{b}}c');
});

test('walkPath is strict: the dotted index and the bare hyphen the old previews accepted are undefined', () => {
    const root = { steps: { s1: { output: { items: [{ x: 'A' }] } } }, trigger: { output: { body: { 'content-type': 'json' } } } };
    assert.equal(walkPath('steps.s1.output.items.0.x', root), undefined);
    assert.equal(walkPath('trigger.output.body.content-type', root), undefined);
    assert.equal(walkPath('steps.s1.output.items[0].x', root), 'A');
    assert.equal(walkPath('trigger.output.body["content-type"]', root), 'json');
});
