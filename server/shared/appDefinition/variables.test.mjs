/**
 * The shared variable vocabulary (variables.mjs) carries its own ceilings
 * because it also runs in the browser; the server catalog's LIMITS and
 * VARIABLE_SPEC must say the same, or an editor-side check and the server's
 * validation would disagree about the same declaration.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import * as shared from './variables.mjs';

const require = createRequire(import.meta.url);
const specs = require('../../appStudio/componentSpecs.js');

test('the ceilings match the server LIMITS and VARIABLE_SPEC', () => {
    assert.equal(shared.MAX_VARIABLES, specs.LIMITS.MAX_VARIABLES);
    assert.equal(shared.MAX_VARIABLE_DEFAULT_BYTES, specs.LIMITS.MAX_VARIABLE_DEFAULT_BYTES);
    assert.equal(shared.MAX_VARIABLE_NAME_LEN, specs.VARIABLE_SPEC.name.maxLen);
    assert.equal(shared.MAX_VARIABLE_LABEL_LEN, specs.VARIABLE_SPEC.label.maxLen);
    assert.equal(shared.MAX_VARIABLE_DESCRIPTION_LEN, specs.VARIABLE_SPEC.description.maxLen);
});

test('text defaults are capped at the server MAX_STRING', () => {
    const long = 'x'.repeat(specs.LIMITS.MAX_STRING + 10);
    assert.deepEqual(shared.coerceVariableDefault('text', long), { value: long.slice(0, specs.LIMITS.MAX_STRING), coerced: true });
    const exact = 'x'.repeat(specs.LIMITS.MAX_STRING);
    assert.deepEqual(shared.coerceVariableDefault('text', exact), { value: exact, coerced: false });
});

test('the server catalog re-exports the shared implementation', () => {
    assert.equal(specs.coerceVariableDefault, shared.coerceVariableDefault);
    assert.equal(specs.seedVariableDefaults, shared.seedVariableDefaults);
    assert.equal(specs.VARIABLE_TYPES, shared.VARIABLE_TYPES);
});

test('the byte ceiling counts UTF-8 bytes, as Buffer.byteLength did', () => {
    const limit = shared.MAX_VARIABLE_DEFAULT_BYTES;
    const atLimit = { s: 'é'.repeat((limit - 8) / 2) };              // {"s":""} is 8 bytes, é is 2
    assert.equal(Buffer.byteLength(JSON.stringify(atLimit), 'utf8'), limit);
    assert.deepEqual(shared.coerceVariableDefault('record', atLimit), { value: atLimit, coerced: false });
    const over = { s: `${atLimit.s}x` };
    assert.deepEqual(shared.coerceVariableDefault('record', over), { value: {}, coerced: true });
    assert.deepEqual(shared.coerceVariableDefault('any', undefined), { value: null, coerced: true });
});

// ── schema 3: screen, kept and derived variables (variableScopes.mjs) ───────

const scopes = await import('./variableScopes.mjs');
const v = (name, extra = {}) => ({ name, label: name, type: 'number', default: 0, description: '', ...extra });

test('derived variables are worked out in the order they read each other', () => {
    const list = [v('total', { derived: { expr: 'vars.net + vars.tax' } }), v('tax', { derived: { expr: 'vars.net * 0.21' } }), v('net', { default: 100 })];
    assert.deepEqual(scopes.derivedPlan(list).order, ['tax', 'total']);
    assert.deepEqual(scopes.applyDerivedVariables(list, { vars: { net: 200, total: 1 } }), { net: 200, total: 242, tax: 42 });
});

test('a cycle is named once, and its members keep their default without being evaluated', () => {
    const list = [v('a', { default: 1, derived: { expr: 'vars.b' } }), v('b', { default: 2, derived: { expr: 'vars["a"]' } }), v('c', { derived: { expr: 'vars.a + 10' } })];
    const plan = scopes.derivedPlan(list);
    assert.deepEqual(plan.cycles, [['a', 'b', 'a']]);
    assert.deepEqual(scopes.applyDerivedVariables(list, { vars: {} }), { a: 1, b: 2, c: 11 });
});

test('reading vars as a whole depends on every other derived variable', () => {
    assert.deepEqual(scopes.varsReadBy('count(keys(vars))'), { names: new Set(), dynamic: true });
    const list = [v('n', { derived: { expr: 'count(keys(vars))' } }), v('m', { derived: { expr: 'vars.n' } })];
    assert.deepEqual(scopes.derivedPlan(list).cycles, [['n', 'm', 'n']]);
});

test('a formula that gives nothing or fails shows the default; nothing derived returns the same object', () => {
    const list = [v('x', { default: 5, derived: { expr: 'vars.missing' } }), v('y', { default: 6, derived: { expr: '1 +' } })];
    assert.deepEqual(scopes.applyDerivedVariables(list, { vars: {} }), { x: 5, y: 6 });
    const plain = { vars: { a: 1 } };
    assert.equal(scopes.applyDerivedVariables([v('a')], plain), plain.vars);
});

test('the derived formula reads the whole scope, not only vars', () => {
    const list = [v('greeting', { type: 'text', default: '', derived: { expr: '"Hi " + currentUser.name + " on " + screen.id' } })];
    assert.equal(scopes.initialVariableValues(list, { currentUser: { name: 'Ann' }, screen: { id: 'scr_a' } }).greeting, 'Hi Ann on scr_a');
});

test('initialVariableValues: defaults, then the given values, then the derived ones', () => {
    const list = [v('a', { default: 1 }), v('b', { default: 2 }), v('sum', { derived: { expr: 'vars.a + vars.b' } })];
    assert.deepEqual(scopes.initialVariableValues(list, { vars: { b: 5 } }), { a: 1, b: 5, sum: 6 });
    assert.deepEqual(scopes.initialVariableValues([v('a', { default: 3 })]), shared.seedVariableDefaults([v('a', { default: 3 })]));
});

test('a new screen puts the screen variables back at their default and leaves the rest', () => {
    const list = [v('tab', { type: 'text', default: 'first', scope: 'screen' }), v('kept', { default: 1 })];
    assert.deepEqual(scopes.resetScreenVariables({ tab: 'second', kept: 9 }, list), { tab: 'first', kept: 9 });
    const same = { tab: 'first', kept: 9 };
    assert.equal(scopes.resetScreenVariables(same, list), same);
    assert.equal(scopes.resetScreenVariables(same, [v('kept')]), same);
});

test('only plain app variables are kept, whatever a screen or derived entry says', () => {
    const list = [v('a', { persist: 'local' }), v('b', { persist: 'session', scope: 'screen' }), v('c', { persist: 'local', derived: { expr: '1' } }), v('d')];
    assert.deepEqual(scopes.persistedVariables(list), [{ name: 'a', type: 'number', persist: 'local' }]);
});
