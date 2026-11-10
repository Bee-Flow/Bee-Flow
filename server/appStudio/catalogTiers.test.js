/**
 * catalogTiers.mts: the base and the extension tier of the AI builder's catalogue.
 *
 * Nothing here depends on what the registries ship: the split is a pure function of a catalogue
 * (splitCatalogue), and the live tiers are checked with test-only entries
 * (testUtils/appCatalogExtensions.testkit.js), looked at through their own names.
 * Run: node --test appStudio/catalogTiers.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const specs = require('./componentSpecs');
const tiers = require('./catalogTiers.mts');
const { withExtensionFixtures, isFixtureName, FIXTURE_NAMES } = require('../testUtils/appCatalogExtensions.testkit');

const TABLES = /** @type {const} */ (['COMPONENT_SPECS', 'STYLE_KNOBS', 'ACTION_KINDS', 'ACTION_SPECS', 'STEP_KINDS', 'STEP_SPECS', 'DATA_MUTATING_STEP_KINDS']);

/** A small catalogue in the shape of the spec hub. */
function catalogue() {
    return {
        COMPONENT_SPECS: {
            heading: { description: 'A title.', props: { text: { type: 'string' }, tone: { type: 'enum', values: ['plain', 'loud'], default: 'plain' } }, styleKnobs: ['span'] },
        },
        STYLE_KNOBS: { span: { type: 'int', min: 1, max: 12, default: 12 } },
        ACTION_KINDS: ['toast'],
        ACTION_SPECS: { toast: { fields: { message: { type: 'string' } } } },
        STEP_KINDS: ['toast', 'save'],
        STEP_SPECS: { toast: { fields: { message: { type: 'string' } } }, save: { mutatesData: true, fields: {} } },
        DATA_MUTATING_STEP_KINDS: ['save'],
    };
}
const split = (/** @type {any} */ tables, extra = {}) => tiers.splitCatalogue({ tables, ...extra });

test('a catalogue without a since mark is its own base: no item, the very same tables', () => {
    const tables = catalogue();
    const { items, base } = split(tables, { bindingKindSince: {}, definitionKeys: [] });
    assert.deepEqual(items, []);
    assert.equal(base, tables);
});

test('only an integer since above the base makes an extension', () => {
    for (const since of [3, 4, 17]) assert.equal(tiers.isExtensionSince(since), true, String(since));
    for (const since of [undefined, null, 0, 1, 2, 2.5, '3', NaN]) assert.equal(tiers.isExtensionSince(since), false, String(since));
    const tables = catalogue();
    Object.assign(tables.COMPONENT_SPECS.heading.props, { old: { type: 'string', since: 2 } });
    assert.deepEqual(split(tables).items, []);
});

test('every place a mark can sit becomes one item; the base is the catalogue without them', () => {
    const before = JSON.stringify(catalogue());
    const tables = /** @type {any} */ (catalogue());
    tables.COMPONENT_SPECS.gauge = { since: 3, description: 'A meter.', props: { value: { type: 'binding' } }, styleKnobs: ['span', 'glow'] };
    tables.COMPONENT_SPECS.heading.props.kicker = { type: 'string', since: 3, description: 'A line above.' };
    tables.COMPONENT_SPECS.heading.props.tone.values.push('quiet');
    tables.COMPONENT_SPECS.heading.props.tone.valuesSince = { quiet: 3, loud: 2 };
    tables.COMPONENT_SPECS.heading.styleKnobs.push('glow');
    tables.STYLE_KNOBS.glow = { type: 'enum', values: ['none', 'soft'], default: 'none', since: 3, description: 'A halo.' };
    tables.STEP_KINDS.push('wait', 'fetch');
    tables.STEP_SPECS.wait = { since: 3, fields: {} };
    tables.STEP_SPECS.fetch = { since: 4, mutatesData: true, fields: {} };
    tables.DATA_MUTATING_STEP_KINDS.push('fetch');
    tables.STEP_SPECS.toast.fields.seconds = { type: 'int', since: 3 };
    tables.ACTION_KINDS.push('beep');
    tables.ACTION_SPECS.beep = { since: 3, description: 'A sound.', fields: {} };
    tables.ACTION_SPECS.toast.fields.seconds = { type: 'int', since: 3 };
    const { items, base } = split(tables, {
        bindingKindSince: { lookup: 3, formula: 2 },
        bindingKindDocs: { lookup: { description: 'One value.' } },
        definitionKeys: [{ key: 'notes', since: 3, description: 'A note.' }],
        stepDescriptions: new Map([['wait', 'Pause.']]),
    });
    assert.deepEqual(items.map((i) => [i.family, i.name, i.description]), [
        ['componentTypes', 'gauge', 'A meter.'],
        ['props', 'heading.kicker', 'A line above.'],
        ['styleKnobs', 'glow', 'A halo.'],
        ['enumValues', 'heading.tone=quiet', ''],
        ['stepKinds', 'fetch', ''],
        ['stepKinds', 'wait', 'Pause.'],
        ['stepFields', 'toast.seconds', ''],
        ['actionKinds', 'beep', 'A sound.'],
        ['actionFields', 'toast.seconds', ''],
        ['bindingKinds', 'lookup', 'One value.'],
        ['topLevelKeys', 'notes', 'A note.'],
    ]);
    // The props of an extension type belong to its own entry.
    assert.ok(!items.some((i) => i.name.startsWith('gauge.')));
    assert.equal(JSON.stringify(base), before, 'the base is the catalogue as it was before the entries');
    assert.notEqual(base, tables);
    // An entry nothing was added to is the same object, not a copy.
    assert.equal(base.STYLE_KNOBS.span, tables.STYLE_KNOBS.span);
});

test('items are sorted by family, then by name in code-point order', () => {
    const tables = /** @type {any} */ (catalogue());
    for (const name of ['zeta', 'Alpha', 'beta', 'alpha_2', 'alpha']) tables.COMPONENT_SPECS[name] = { since: 3, props: {}, styleKnobs: [] };
    tables.STYLE_KNOBS.aaa = { type: 'int', since: 3 };
    assert.deepEqual(split(tables).items.map((i) => i.name), ['Alpha', 'alpha', 'alpha_2', 'beta', 'zeta', 'aaa']);
});

test('the live tiers follow the spec tables: test entries appear, and are gone again afterwards', () => {
    const itemsBefore = tiers.extensionItems();
    const baseBefore = JSON.stringify(TABLES.map((t) => tiers.baseCatalogue()[t]));
    assert.ok(!itemsBefore.some((i) => isFixtureName(i.name)));
    withExtensionFixtures(() => {
        assert.deepEqual(tiers.extensionItems().filter((i) => isFixtureName(i.name)).map((i) => `${i.family}:${i.name}`), [
            `componentTypes:${FIXTURE_NAMES.type}`,
            `props:${FIXTURE_NAMES.prop}`,
            `styleKnobs:${FIXTURE_NAMES.knob}`,
            `enumValues:${FIXTURE_NAMES.propValue}`,
            `enumValues:${FIXTURE_NAMES.knobValue}`,
            `stepKinds:${FIXTURE_NAMES.stepKind}`,
            `stepFields:${FIXTURE_NAMES.stepField}`,
            `bindingKinds:${FIXTURE_NAMES.bindingKind}`,
            `topLevelKeys:${FIXTURE_NAMES.topLevelKey}`,
        ]);
        assert.equal(tiers.hasExtensions(), true);
        const base = tiers.baseCatalogue();
        assert.equal(JSON.stringify(TABLES.map((t) => base[t])), baseBefore, 'the base tables did not move');
        assert.ok(specs.COMPONENT_SPECS.zz_gauge && !base.COMPONENT_SPECS.zz_gauge);
        assert.ok(specs.STEP_KINDS.includes('zz_wait') && !base.STEP_KINDS.includes('zz_wait'));
        assert.equal(tiers.fullCatalogue(), specs);
    });
    assert.deepEqual(tiers.extensionItems(), itemsBefore);
    assert.equal(JSON.stringify(TABLES.map((t) => tiers.baseCatalogue()[t])), baseBefore);
});
