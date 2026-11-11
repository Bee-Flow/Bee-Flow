// @typecheck
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { canonicalizeAppDefinition } = require('./canonicalize');
const { LIMITS, SECTION_STYLE_DEFAULTS } = require('./componentSpecs');

const codes = (repairs) => new Set(repairs.map((r) => r.code));

function deepFreeze(o) {
    if (o && typeof o === 'object') {
        for (const v of Object.values(o)) deepFreeze(v);
        Object.freeze(o);
    }
    return o;
}

function wrap(overrides = {}) {
    return {
        schemaVersion: 2,
        meta: { name: 'T', description: '', icon: 'LayoutGrid' },
        theme: {},
        homeScreenId: 'scr_main01',
        roles: [],
        screens: [{
            id: 'scr_main01',
            name: 'Home',
            sections: [{ id: 'sec_main01', style: { ...SECTION_STYLE_DEFAULTS }, children: [] }],
        }],
        actions: {},
        ...overrides,
    };
}

const canon = (def) => canonicalizeAppDefinition(deepFreeze(def));
const vars = (list) => canon(wrap({ variables: list }));

// ── emit-when-present ───────────────────────────────────────────────────────
// This is the whole safety story: an app that declares no variables must
// canonicalize to exactly the bytes it had before the key existed, or every
// shipped template's "no structural repairs" contract and every frozen
// published definition would shift on the next save.

test('an app with no variables key produces no variables key', () => {
    const { def } = canon(wrap());
    assert.equal('variables' in def, false);
});

test('the canonical bytes are identical with the key absent', () => {
    const withoutKey = canon(wrap()).def;
    const withEmpty = canon(wrap({ variables: [] })).def;
    assert.deepStrictEqual(withEmpty, withoutKey);
    assert.equal(JSON.stringify(withEmpty), JSON.stringify(withoutKey));
});

test('a non-array variables value is dropped with a repair, not kept', () => {
    const { def, repairs } = canon(wrap({ variables: 'nope' }));
    assert.equal('variables' in def, false);
    assert.ok(codes(repairs).has('variables.invalid'));
});

// ── names ───────────────────────────────────────────────────────────────────

test('a name with a space is repaired rather than dropped', () => {
    const { def, repairs } = vars([{ name: 'my var', type: 'text' }]);
    assert.equal(def.variables[0].name, 'my_var');
    assert.ok(codes(repairs).has('variable.name_repaired'));
});

test('a reserved name is dropped and named as reserved', () => {
    const { def, repairs } = vars([{ name: 'filters', type: 'text' }, { name: 'true', type: 'text' }]);
    assert.equal('variables' in def, false);
    assert.ok(codes(repairs).has('variable.name_reserved'));
});

test('a name that cannot be repaired into an identifier is dropped', () => {
    const { def, repairs } = vars([{ name: '!!!', type: 'text' }]);
    assert.equal('variables' in def, false);
    assert.ok(codes(repairs).has('variable.name_invalid'));
});

test('the later of two same-named variables is dropped', () => {
    const { def, repairs } = vars([
        { name: 'status', type: 'text', default: 'a' },
        { name: 'status', type: 'text', default: 'b' },
    ]);
    assert.equal(def.variables.length, 1);
    assert.equal(def.variables[0].default, 'a');
    assert.ok(codes(repairs).has('variable.duplicate'));
});

test('label falls back to the name, description to empty', () => {
    const { def } = vars([{ name: 'status', type: 'text' }]);
    assert.equal(def.variables[0].label, 'status');
    assert.equal(def.variables[0].description, '');
});

// ── types and defaults ──────────────────────────────────────────────────────

test('an unknown type becomes "any" with a repair', () => {
    const { def, repairs } = vars([{ name: 'x', type: 'colour' }]);
    assert.equal(def.variables[0].type, 'any');
    assert.ok(codes(repairs).has('variable.type_invalid'));
});

test('defaults are coerced to their declared type', () => {
    const { def } = vars([
        { name: 'a', type: 'number', default: '5' },
        { name: 'b', type: 'yesno', default: 'true' },
        { name: 'c', type: 'text', default: 42 },
        { name: 'd', type: 'date', default: '2026-08-10T09:00:00Z' },
        { name: 'e', type: 'list', default: 'nope' },
        { name: 'f', type: 'record', default: [] },
    ]);
    const byName = Object.fromEntries(def.variables.map((v) => [v.name, v.default]));
    assert.equal(byName.a, 5);
    assert.equal(byName.b, true);
    assert.equal(byName.c, '42');
    assert.equal(byName.d, '2026-08-10');
    assert.deepStrictEqual(byName.e, []);
    assert.deepStrictEqual(byName.f, {});
});

test('a missing default becomes the type default without a repair note', () => {
    const { def, repairs } = vars([{ name: 'a', type: 'number' }]);
    assert.equal(def.variables[0].default, 0);
    assert.equal(codes(repairs).has('variable.default_coerced'), false);
});

// A definition is cached, published and frozen — a "today" baked into the
// bytes is wrong the next morning.
test('a date variable defaults to null, never to today', () => {
    const { def } = vars([{ name: 'due', type: 'date' }]);
    assert.equal(def.variables[0].default, null);
});

test('an oversized default is reset to the type default', () => {
    const big = { blob: 'x'.repeat(LIMITS.MAX_VARIABLE_DEFAULT_BYTES + 100) };
    const { def, repairs } = vars([{ name: 'a', type: 'record', default: big }]);
    assert.deepStrictEqual(def.variables[0].default, {});
    assert.ok(codes(repairs).has('variable.default_coerced'));
});

test('a kept default does not alias the caller’s object', () => {
    const source = { a: 1 };
    const { def } = canon(wrap({ variables: [{ name: 'v', type: 'record', default: source }] }));
    assert.deepStrictEqual(def.variables[0].default, { a: 1 });
    assert.notEqual(def.variables[0].default, source);
});

// ── ceilings and stability ──────────────────────────────────────────────────

test('more than the ceiling is trimmed with a repair', () => {
    const many = Array.from({ length: LIMITS.MAX_VARIABLES + 10 }, (_, i) => ({ name: `v${i}`, type: 'text' }));
    const { def, repairs } = vars(many);
    assert.equal(def.variables.length, LIMITS.MAX_VARIABLES);
    assert.ok(codes(repairs).has('variables.too_many'));
});

test('keys come out in a fixed order, so the bytes are deterministic', () => {
    const { def } = vars([{ description: 'd', default: 'x', type: 'text', label: 'L', name: 'v' }]);
    assert.deepStrictEqual(Object.keys(def.variables[0]), ['name', 'label', 'type', 'default', 'description']);
});

test('canonicalizing twice changes nothing and repairs nothing', () => {
    const first = vars([
        { name: 'my var', type: 'number', default: '5' },
        { name: 'ok', type: 'text', default: 'x', label: 'Ok', description: 'why' },
    ]);
    const second = canonicalizeAppDefinition(first.def);
    assert.deepStrictEqual(second.def, first.def);
    assert.equal(second.repairs.length, 0);
});

// ── schema 3: scope, persist, derived ───────────────────────────────────────

const base = (name, extra = {}) => ({ name, label: name, type: 'number', default: 0, description: '', ...extra });

test('a variable without the schema 3 keys keeps its bytes and the app stays version 2', () => {
    const { def } = vars([base('a')]);
    assert.deepStrictEqual(Object.keys(def.variables[0]), ['name', 'label', 'type', 'default', 'description']);
    assert.equal(def.schemaVersion, 2);
});

test('scope, persist and derived are written after the base keys, and make the app version 3', () => {
    const { def } = vars([base('a', { scope: 'screen' }), base('b', { persist: 'local' }), base('c', { derived: { expr: 'vars.b * 2' } })]);
    assert.deepStrictEqual(def.variables.map((v) => Object.keys(v).slice(5)), [['scope'], ['persist'], ['derived']]);
    assert.deepStrictEqual(def.variables[2].derived, { expr: 'vars.b * 2' });
    assert.equal(def.schemaVersion, 3);
});

test('the base values of the keys are left out', () => {
    const { def, repairs } = vars([base('a', { scope: 'app', persist: false, derived: { expr: '  ' } })]);
    assert.deepStrictEqual(Object.keys(def.variables[0]), ['name', 'label', 'type', 'default', 'description']);
    assert.equal(def.schemaVersion, 2);
    assert.equal(repairs.length, 0);
});

test('repairs: a formula string, persist true, and combinations that mean nothing', () => {
    const { def, repairs } = vars([
        base('a', { derived: 'vars.b + 1', persist: 'local', scope: 'screen' }),
        base('b', { persist: true }),
        base('c', { scope: 'screen', persist: 'session' }),
        base('d', { derived: { kind: 'formula', expr: 'vars.b' } }),
    ]);
    assert.deepStrictEqual(def.variables.map((v) => ({ scope: v.scope, persist: v.persist, derived: v.derived })), [
        { scope: undefined, persist: undefined, derived: { expr: 'vars.b + 1' } },
        { scope: undefined, persist: 'session', derived: undefined },
        { scope: 'screen', persist: undefined, derived: undefined },
        { scope: undefined, persist: undefined, derived: { expr: 'vars.b' } },
    ]);
    const got = codes(repairs);
    for (const code of ['variable.derived_repaired', 'variable.derived_extras_dropped', 'variable.persist_repaired', 'variable.persist_dropped']) assert.ok(got.has(code), code);
});

test('unknown values and a formula over the ceiling are dropped with a note', () => {
    const { def, repairs } = vars([base('a', { scope: 'page', persist: 'cookie', derived: { expr: 'x'.repeat(LIMITS.MAX_FORMULA_LEN + 1) } })]);
    assert.deepStrictEqual(Object.keys(def.variables[0]), ['name', 'label', 'type', 'default', 'description']);
    const got = codes(repairs);
    for (const code of ['variable.scope_invalid', 'variable.persist_invalid', 'variable.derived_too_long']) assert.ok(got.has(code), code);
});

test('a second pass changes nothing', () => {
    const once = vars([base('a', { derived: 'vars.b' }), base('b', { persist: true }), base('c', { scope: 'screen' })]).def;
    const twice = canon(JSON.parse(JSON.stringify(once)));
    assert.equal(JSON.stringify(twice.def), JSON.stringify(once));
    assert.equal(twice.repairs.length, 0);
});
