'use strict';
/**
 * Schema versions: the lowest sufficient version, the migration chain, the
 * refusal of a newer definition, and the top-level key registry. The registry
 * and the catalogue ship without any `since` entry, so everything here that
 * needs one runs against a test-only fixture.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const specs = require('./componentSpecs');
const { canonicalizeAppDefinition } = require('./canonicalize');
const { validateAppDefinition } = require('./validate');
const { MIGRATIONS, migrateDefinition, migrateV1toV2 } = require('./migrate');
const { buildPublicDefinition } = require('./publicAccess');
const since = require('./schemaSince.mts');
const registry = require('./definitionKeyRegistry.mts');

const { SCHEMA_VERSION_BASE, SCHEMA_VERSION_CURRENT, emptyDefinition } = specs;

/** A valid one-screen app with a heading, a styled section and one action. */
let sampleJson = null;
function sampleDef() {
    if (sampleJson) return JSON.parse(sampleJson);
    const def = emptyDefinition('Sample');
    def.screens[0].sections[0].children.push({
        id: 'n_head00001', type: 'heading', props: { text: 'Hello' }, style: { span: 12 }, visible: true,
    });
    def.actions = { a_toast0001: { kind: 'sequence', steps: [{ kind: 'toast', message: 'Hi' }] } };
    sampleJson = JSON.stringify(canonicalizeAppDefinition(def).def);
    return JSON.parse(sampleJson);
}

/** The one action of sampleDef (its id is generated). */
const actionOf = (def) => Object.values(def.actions)[0];

/** A fixture top-level key, in the shape definitionKeys/<key>.js exports. */
const NOTES_ENTRY = {
    key: 'fixtureNotes',
    since: 3,
    canon(value, push) {
        if (typeof value !== 'string') { push('fixtureNotes.invalid', 'fixtureNotes', 'fixtureNotes must be a string — dropped.'); return undefined; }
        return value.trim();
    },
    validate(value, { pushE }) {
        if (value === 'bad') pushE({ code: 'fixtureNotes.bad', severity: 'error', path: 'fixtureNotes', message: 'bad', hint: '' });
    },
    public: false,
};

const withNotesKey = (fn, entry = NOTES_ENTRY) => registry._withDefinitionKeys([entry], () => since._withCatalogue({ definitionKeys: [entry] }, fn));

// ── What ships ──────────────────────────────────────────────────────────────

test('the registry ships empty, and every since entry of the catalogue is above the base', () => {
    assert.deepEqual(registry.loadDefinitionKeys(), []);
    const index = since.buildSinceIndex({
        componentSpecs: specs.COMPONENT_SPECS, styleKnobs: specs.STYLE_KNOBS, stepSpecs: specs.STEP_SPECS,
        actionSpecs: specs.ACTION_SPECS, bindingKindSince: specs.BINDING_KIND_SINCE, definitionKeys: registry.definitionKeys(),
    });
    // The first catalogue additions (image.srcFrom, LK6) put entries here; none may claim the base.
    const marks = JSON.stringify(index).match(/:\d+/g) || [];
    assert.ok(marks.every((m) => Number(m.slice(1)) > SCHEMA_VERSION_BASE), marks.join(' '));
    assert.equal(index.props.image?.srcFrom, 3);
});

test('every definition needs the base version today, and canonicalize writes it', () => {
    const def = sampleDef();
    assert.equal(since.requiredSchemaVersion(def), SCHEMA_VERSION_BASE);
    assert.equal(def.schemaVersion, 2);
    assert.equal(Object.keys(def)[0], 'schemaVersion');
});

test('a definition tagged 3 that needs only 2 is written as 2, without a repair', () => {
    const tagged = { ...sampleDef(), schemaVersion: 3 };
    assert.equal(validateAppDefinition(tagged).ok, true, 'any accepted version at or above the required one validates');
    const { def, repairs, refused } = canonicalizeAppDefinition(tagged);
    assert.equal(refused, undefined);
    assert.equal(def.schemaVersion, 2);
    assert.deepEqual(repairs.filter((r) => r.code === 'shape.schema_version'), []);
    assert.equal(JSON.stringify(def), JSON.stringify(sampleDef()));
});

// ── requiredSchemaVersion ───────────────────────────────────────────────────

test('requiredSchemaVersion answers the highest since a definition uses', () => {
    const base = sampleDef();
    const cases = [
        ['component type', { componentSpecs: { heading: { since: 3 } } }],
        ['prop', { componentSpecs: { heading: { props: { text: { since: 3 } } } } }],
        ['prop enum value', { componentSpecs: { heading: { props: { text: { valuesSince: { Hello: 3 } } } } } }],
        ['style knob', { styleKnobs: { span: { since: 3 } } }],
        ['style enum value', { styleKnobs: { span: { valuesSince: { 12: 4 } } } }, 4],
        ['section style knob', { styleKnobs: { padding: { since: 3 } } }],
        ['step kind', { stepSpecs: { toast: { since: 3 } } }],
        ['action kind', { actionSpecs: { sequence: { since: 3 } } }],
        ['top-level key', { definitionKeys: [{ key: 'actions', since: 5 }] }, 5],
    ];
    for (const [label, catalogue, expected = 3] of cases) {
        since._withCatalogue(catalogue, () => {
            assert.equal(since.requiredSchemaVersion(base), expected, label);
        });
    }
    // Something marked that the definition does not use leaves it at the base.
    since._withCatalogue({ componentSpecs: { chart: { since: 3 } }, stepSpecs: { loop: { since: 3 } }, styleKnobs: { weight: { since: 3 } } }, () => {
        assert.equal(since.requiredSchemaVersion(base), SCHEMA_VERSION_BASE);
    });
    assert.equal(since.requiredSchemaVersion(base), SCHEMA_VERSION_BASE, 'the override ends with the callback');
});

test('requiredSchemaVersion reads binding kinds and nested steps, not the payload of a static binding', () => {
    const def = sampleDef();
    def.screens[0].sections[0].children[0].props.text = { kind: 'static', value: { kind: 'lookup' } };
    actionOf(def).steps = [{
        kind: 'condition', when: 'true',
        then: [{ kind: 'loop', steps: [{ kind: 'set_variable', value: { kind: 'lookup', id: 'x' } }] }],
        else: [],
    }];
    since._withCatalogue({ bindingKindSince: { lookup: 3 } }, () => {
        assert.equal(since.requiredSchemaVersion(def), 3, 'a binding inside a nested step counts');
        actionOf(def).steps = [];
        assert.equal(since.requiredSchemaVersion(def), SCHEMA_VERSION_BASE, 'a static payload is data');
        def.screens[0].sections[0].children[0].visibleWhen = { kind: 'lookup' };
        assert.equal(since.requiredSchemaVersion(def), 3, 'a node logic field counts');
    });
    since._withCatalogue({ stepSpecs: { deep_step: { since: 3 } } }, () => {
        actionOf(def).steps = [{ kind: 'switch', cases: [{ when: '1', steps: [{ kind: 'deep_step' }] }], default: [] }];
        assert.equal(since.requiredSchemaVersion(def), 3, 'a step inside a switch case counts');
    });
});

test('requiredSchemaVersion never throws on garbage and ignores inherited names', () => {
    for (const bad of [null, undefined, 3, 'x', [], { screens: 'x', actions: [] }, { screens: [null, { sections: [null, { children: [null, 7] }] }] }]) {
        since._withCatalogue({ componentSpecs: { heading: { since: 3 } } }, () => {
            assert.equal(since.requiredSchemaVersion(bad), SCHEMA_VERSION_BASE);
        });
    }
    since._withCatalogue({ componentSpecs: { heading: { since: 3 } } }, () => {
        const def = sampleDef();
        def.screens[0].sections[0].children[0].type = 'constructor';
        def.constructor = 1;
        assert.equal(since.requiredSchemaVersion(def), SCHEMA_VERSION_BASE);
    });
    assert.equal(since.buildSinceIndex({ componentSpecs: { heading: { since: 2 }, text: { since: '3' } } }).componentTypes.heading, undefined);
});

// ── Canonicalize and validate with a since entry ────────────────────────────

test('canonicalize writes 3 only for a definition that uses a since-3 entry; the validator wants at least that', () => {
    since._withCatalogue({ componentSpecs: { heading: { since: 3 } } }, () => {
        const withHeading = canonicalizeAppDefinition(sampleDef()).def;
        assert.equal(withHeading.schemaVersion, 3);
        assert.equal(validateAppDefinition(withHeading).ok, true);
        const lowered = validateAppDefinition({ ...withHeading, schemaVersion: 2 });
        assert.deepEqual(lowered.errors.map((e) => e.code), ['shape.schema_version']);

        const without = canonicalizeAppDefinition(emptyDefinition('Plain')).def;
        assert.equal(without.schemaVersion, 2);
    });
});

test('the validator still refuses version 1 and a version that is not one', () => {
    const def = sampleDef();
    for (const v of [1, 0, '2', 2.5, undefined, null]) {
        const { errors } = validateAppDefinition({ ...def, schemaVersion: v });
        assert.ok(errors.some((e) => e.code === 'shape.schema_version'), `schemaVersion ${JSON.stringify(v)}`);
    }
});

// ── Migration chain ─────────────────────────────────────────────────────────

test('the chain has one step per version, in order, up to the newest', () => {
    assert.deepEqual(MIGRATIONS.map((m) => [m.from, m.to]), [[1, 2], [2, 3]]);
    assert.equal(MIGRATIONS[MIGRATIONS.length - 1].to, SCHEMA_VERSION_CURRENT);
});

test('migrateDefinition walks to the target, never mutates, never downgrades', () => {
    const v1 = Object.freeze({ schemaVersion: 1, meta: Object.freeze({ name: 'A' }), screens: Object.freeze([]) });
    const to3 = migrateDefinition(v1);
    assert.equal(to3.schemaVersion, 3);
    assert.deepEqual(to3.roles, []);
    assert.equal(to3.screens, v1.screens, 'nested references are kept');
    assert.deepEqual(migrateDefinition(v1, 2), migrateV1toV2(v1));

    const v2 = { schemaVersion: 2, roles: [{ id: 'r' }], screens: [] };
    const step = migrateDefinition(v2);
    assert.deepEqual(step, { ...v2, schemaVersion: 3 }, 'v2 to v3 is an identity apart from the tag');
    assert.notEqual(step, v2);

    const v3 = { schemaVersion: 3, screens: [] };
    assert.equal(migrateDefinition(v3, 2), v3, 'above the target: returned as is');
    const newer = { schemaVersion: 4, screens: [], future: true };
    assert.equal(migrateDefinition(newer), newer);

    assert.equal(migrateDefinition({ screens: [] }).schemaVersion, 3, 'no tag starts at 1');
    assert.deepEqual(migrateDefinition({ schemaVersion: 'x' }).roles, []);
    for (const bad of [null, undefined, 42, 'str', [1]]) assert.equal(migrateDefinition(bad), bad);
});

// ── Refusing a newer definition ─────────────────────────────────────────────

test('a definition above the newest version is refused untouched, not normalised', () => {
    const newer = { schemaVersion: SCHEMA_VERSION_CURRENT + 1, meta: { name: 'Future' }, screens: [], futureKey: { a: 1 } };
    const snapshot = JSON.stringify(newer);
    const out = canonicalizeAppDefinition(newer);
    assert.equal(out.refused, 'schema_newer');
    assert.equal(out.def, newer, 'the very same object comes back');
    assert.equal(JSON.stringify(newer), snapshot);
    assert.deepEqual(out.repairs, []);
    assert.equal(since.isSchemaNewer(newer), true);
    assert.equal(since.isSchemaNewer({ schemaVersion: SCHEMA_VERSION_CURRENT }), false);
    assert.equal(since.isSchemaNewer({ schemaVersion: '9' }), false, 'only a number is a version');

    const verdict = validateAppDefinition(newer);
    assert.equal(verdict.ok, false);
    assert.deepEqual(verdict.errors.map((e) => e.code), ['shape.schema_newer']);

    const err = since.schemaNewerError(newer);
    assert.equal(err.status, 422);
    assert.equal(err.code, 'schema_newer');
    assert.deepEqual(Object.keys(since.schemaNewerBody(newer)), ['error', 'code']);
});

// ── Top-level key registry ──────────────────────────────────────────────────

test('a registered key is canonicalized after the base keys, only when present', () => {
    withNotesKey(() => {
        const base = sampleDef();
        assert.equal(JSON.stringify(canonicalizeAppDefinition(base).def), JSON.stringify(base), 'absent stays absent, same bytes');

        const { def } = canonicalizeAppDefinition({ ...base, fixtureNotes: '  hello  ' });
        assert.equal(def.fixtureNotes, 'hello');
        assert.equal(def.schemaVersion, 3);
        assert.equal(Object.keys(def).at(-1), 'fixtureNotes');
        assert.equal(validateAppDefinition(def).ok, true);
        assert.equal(JSON.stringify(canonicalizeAppDefinition(def).def), JSON.stringify(def), 'idempotent');

        const dropped = canonicalizeAppDefinition({ ...base, fixtureNotes: 7 });
        assert.equal('fixtureNotes' in dropped.def, false);
        assert.equal(dropped.def.schemaVersion, 2);
        assert.ok(dropped.repairs.some((r) => r.code === 'fixtureNotes.invalid'));

        const bad = validateAppDefinition({ ...def, fixtureNotes: 'bad' });
        assert.ok(bad.errors.some((e) => e.code === 'fixtureNotes.bad'));
    });
    // Outside the fixture the key is unknown again: dropped like any unknown key.
    const { def } = canonicalizeAppDefinition({ ...sampleDef(), fixtureNotes: 'hello' });
    assert.equal('fixtureNotes' in def, false);
    assert.equal(def.schemaVersion, 2);
});

test('a registered key reaches a public page only with public: true', () => {
    const surface = { title: 'Form', entryScreenId: 's1', screens: [], actionIds: new Set() };
    const stored = { ...sampleDef(), fixtureNotes: 'internal' };
    withNotesKey(() => {
        assert.equal('fixtureNotes' in buildPublicDefinition(stored, surface), false);
    });
    withNotesKey(() => {
        assert.equal(buildPublicDefinition(stored, surface).fixtureNotes, 'internal');
        assert.equal('fixtureNotes' in buildPublicDefinition(sampleDef(), surface), false);
    }, { ...NOTES_ENTRY, public: true });
    withNotesKey(() => {
        assert.equal('fixtureNotes' in buildPublicDefinition(stored, surface), false, 'only the boolean true opens it');
    }, { ...NOTES_ENTRY, public: 'yes' });
});

test('a malformed registry entry fails loudly', () => {
    const ok = { key: 'x', since: 3, canon: (v) => v };
    assert.equal(registry.checkEntry(ok).since, 3);
    assert.throws(() => registry.checkEntry(null), /must export an object/);
    assert.throws(() => registry.checkEntry({ ...ok, key: '' }), /"key"/);
    assert.throws(() => registry.checkEntry({ ...ok, key: 'screens' }), /base key/);
    assert.throws(() => registry.checkEntry({ ...ok, since: 2 }), /"since"/);
    assert.throws(() => registry.checkEntry({ ...ok, since: undefined }), /"since"/);
    assert.throws(() => registry.checkEntry({ ...ok, canon: 'no' }), /"canon"/);
    assert.throws(() => registry.checkEntry({ ...ok, validate: 1 }), /"validate"/);
    assert.throws(() => registry.checkEntry(ok, 'y'), /must equal the file name/);
    assert.deepEqual(registry.loadDefinitionKeys('/nonexistent/definition/keys'), []);
});

// ── Export envelopes ────────────────────────────────────────────────────────

test('an export envelope keeps its version until a contained definition needs 3', () => {
    const def = sampleDef();
    assert.equal(since.envelopeVersionFor(1, [def]), 1);
    assert.equal(since.envelopeVersionFor(2, []), 2);
    assert.equal(since.envelopeVersionFor(2, [null, def, 'x']), 2);
    since._withCatalogue({ componentSpecs: { heading: { since: 3 } } }, () => {
        assert.equal(since.envelopeVersionFor(1, [emptyDefinition('p'), def]), 2);
        assert.equal(since.envelopeVersionFor(2, [def]), 3);
    });
    assert.deepEqual(since.supportedEnvelopeVersions([1], 1), [1, 2]);
    assert.deepEqual(since.supportedEnvelopeVersions([1, 2], 2), [1, 2, 3]);
});
