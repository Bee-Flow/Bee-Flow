'use strict';
/**
 * A prop, a step field or an action field added after the frozen base (`since` 3 or higher)
 * is emit-when-present: the canonicalizer cleans it when a definition carries it and never
 * writes it for one that does not, whatever default its spec declares. Otherwise the first
 * prop added to `heading` would be written into every stored heading on its next save, and
 * raise that app's schema version for something its author never used.
 *
 * The entries are made up here and taken out again (this file has its own process).
 * Run: node --test appStudio/canonicalize.lateEntries.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const specs = require('./componentSpecs');
const since = require('./schemaSince.mts');
const { canonicalizeAppDefinition } = require('./canonicalize');
const { validateAppDefinition } = require('./validate');
const { isLateEntry } = require('./canonicalize/shared');

const { COMPONENT_SPECS, STEP_SPECS, ACTION_SPECS, emptyDefinition } = specs;

/** One late entry of every default shape the canonicalizers know how to fill. */
const LATE_PROPS = {
    zz_kicker: { type: 'string', maxLen: 60, since: 3 },
    zz_tone: { type: 'enum', values: ['plain', 'loud'], default: 'plain', since: 3 },
    zz_flag: { type: 'boolean', default: true, since: 3 },
    zz_rows: { type: 'list', default: [], since: 3, itemShape: { key: { type: 'string' } } },
    zz_data: { type: 'binding', default: { kind: 'static', value: 0 }, since: 3 },
};
const LATE_FIELDS = {
    zz_note: { type: 'string', nullable: true, since: 3 },
    zz_mode: { type: 'enum', values: ['a', 'b'], default: 'a', since: 3 },
    zz_sticky: { type: 'boolean', default: false, since: 3 },
    zz_after: { type: 'steps', since: 3 },
    zz_seconds: { type: 'int', min: 1, max: 30, since: 3 },
};

/** Run `fn` with the late entries on heading, the toast step and the toast action, indexed for the schema version. */
function withLateEntries(fn) {
    const tables = [[COMPONENT_SPECS.heading.props, LATE_PROPS], [STEP_SPECS.toast.fields, LATE_FIELDS], [ACTION_SPECS.toast.fields, LATE_FIELDS]];
    for (const [table, entries] of tables) Object.assign(table, entries);
    try {
        return since._withCatalogue(since.liveCatalogue(), fn);
    } finally {
        for (const [table, entries] of tables) for (const key of Object.keys(entries)) delete table[key];
    }
}

function app() {
    const def = emptyDefinition('Late entries');
    def.screens[0].sections[0].children = [{ id: 'cmp_head0001', type: 'heading', props: { text: 'Hello' } }];
    def.actions = {
        act_toast001: { kind: 'toast', message: 'Hi' },
        act_seq00001: { kind: 'sequence', steps: [{ kind: 'toast', message: 'Hi' }] },
    };
    return def;
}

const heading = (def) => def.screens[0].sections[0].children[0];
const canon = (def) => canonicalizeAppDefinition(def);

test('isLateEntry: only an integer since above the base', () => {
    for (const s of [3, 4, 12]) assert.equal(isLateEntry({ since: s }), true, String(s));
    for (const s of [undefined, null, 2, 1, 0, '3', 2.5, NaN]) assert.equal(isLateEntry({ since: s }), false, String(s));
    for (const spec of [null, undefined, 'x', 3]) assert.equal(isLateEntry(spec), false);
});

test('a definition that does not use a late prop or field keeps its bytes and its version', () => {
    const before = canon(app());
    assert.equal(before.def.schemaVersion, 2);
    withLateEntries(() => {
        const after = canon(app());
        // Ids are generated per run: compare the stored bytes of one canonical definition.
        assert.equal(JSON.stringify(canon(before.def).def), JSON.stringify(before.def));
        assert.equal(after.def.schemaVersion, 2);
        assert.deepEqual(Object.keys(heading(after.def).props), Object.keys(heading(before.def).props));
        assert.deepEqual(Object.values(after.def.actions).map((a) => Object.keys(a)), Object.values(before.def.actions).map((a) => Object.keys(a)));
        assert.deepEqual(Object.keys(Object.values(after.def.actions)[1].steps[0]), ['kind', 'message', 'tone']);
        // No repair says a late prop was "filled from spec defaults".
        assert.ok(!after.repairs.some((r) => r.message.includes('zz_')), JSON.stringify(after.repairs));
        assert.deepEqual(validateAppDefinition(after.def).errors, []);
    });
});

test('null means not set: a late prop sent as null is left out, like an absent one', () => {
    withLateEntries(() => {
        const def = app();
        Object.assign(heading(def).props, { zz_kicker: null, zz_tone: null, zz_flag: undefined });
        const out = canon(def).def;
        assert.ok(!Object.keys(heading(out).props).some((k) => k.startsWith('zz_')));
        assert.equal(out.schemaVersion, 2);
    });
});

test('a late prop or field the definition carries is cleaned, kept, and makes it version 3', () => {
    withLateEntries(() => {
        const def = app();
        Object.assign(heading(def).props, { zz_kicker: 'x'.repeat(80), zz_tone: 'loud', zz_flag: false });
        const out = canon(def).def;
        assert.equal(heading(out).props.zz_kicker.length, 60, 'truncated like any string prop');
        assert.equal(heading(out).props.zz_tone, 'loud');
        assert.equal(heading(out).props.zz_flag, false, 'false is a value, not an absence');
        assert.ok(!('zz_rows' in heading(out).props) && !('zz_data' in heading(out).props));
        assert.equal(out.schemaVersion, 3);
        assert.equal(JSON.stringify(canon(out).def), JSON.stringify(out), 'a second pass changes nothing');

        const withStep = app();
        Object.values(withStep.actions)[1].steps[0].zz_seconds = '5';
        Object.values(withStep.actions)[0].zz_sticky = true;
        const stepped = canon(withStep).def;
        assert.deepEqual(Object.values(stepped.actions)[1].steps[0], { kind: 'toast', message: 'Hi', tone: 'info', zz_seconds: 5 });
        assert.deepEqual(Object.values(stepped.actions)[0], { kind: 'toast', message: 'Hi', tone: 'info', zz_sticky: true });
        assert.equal(stepped.schemaVersion, 3);
    });
});

test('an invalid value for a late field falls back the way a base field does, only because it was sent', () => {
    withLateEntries(() => {
        const def = app();
        Object.values(def.actions)[1].steps[0].zz_mode = 'nope';
        const out = canon(def);
        assert.equal(Object.values(out.def.actions)[1].steps[0].zz_mode, 'a');
        assert.ok(out.repairs.some((r) => r.path.endsWith('.zz_mode')));
    });
});

test('nothing shipped declares a late prop or field with a required flag', () => {
    // Required and emit-when-present contradict each other: a definition stored before the
    // entry existed could never satisfy it.
    for (const [type, spec] of Object.entries(COMPONENT_SPECS)) {
        if (isLateEntry(spec)) continue; // every prop of a type that is itself new may be required
        for (const [key, prop] of Object.entries(spec.props)) {
            assert.ok(!(isLateEntry(prop) && prop.required), `${type}.${key}: a prop added to an existing type cannot be required`);
        }
    }
    for (const [table, label] of [[STEP_SPECS, 'step'], [ACTION_SPECS, 'action']]) {
        for (const [kind, spec] of Object.entries(table)) {
            if (isLateEntry(spec)) continue;
            for (const [key, field] of Object.entries(spec.fields)) {
                assert.ok(!(isLateEntry(field) && field.required), `${label} ${kind}.${key}: a field added to an existing kind cannot be required`);
            }
        }
    }
});
