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
const { withExtensionFixtures, isFixtureName, FIXTURE_NAMES, KEY_FIXTURE_NAMES } = require('../testUtils/appCatalogExtensions.testkit');

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

// ── The tables outside the component, knob and kind specs (catalogTiersKeys.mts) ──

/** A catalogue with every table that has two tiers. */
function wideCatalogue() {
    return {
        ...catalogue(),
        COMPONENT_SPECS: {
            table: {
                description: 'Rows.',
                props: {
                    columns: { type: 'list', itemShape: { key: { type: 'string' }, align: { type: 'enum', values: ['left', 'right'] }, tones: { type: 'list', itemShape: { value: { type: 'string' } } } } },
                    title: { type: 'string' },
                },
                styleKnobs: ['span'],
            },
        },
        STYLE_KNOBS: { span: { type: 'int', min: 1, max: 12, default: 12 }, radius: { type: 'enum', values: ['none', 'md'], default: 'none' }, padding: { type: 'int', min: 0, max: 8, default: 4 } },
        SCREEN_SPEC: { name: { type: 'string' }, maxWidth: { type: 'enum', values: ['narrow', 'wide'], default: 'wide' } },
        THEME_SPEC: { primary: { type: 'color', default: '#000000' }, radius: { type: 'enum', values: ['sm', 'md'], default: 'md' } },
        DESIGN_SPEC: { motion: { type: 'enum', values: ['none', 'subtle'], default: 'subtle' } },
        NAV_STYLES: ['tabs', 'sidebar'],
        SECTION_STYLE_KNOBS: ['padding'],
        FIELD_TYPES: ['text', 'number'],
        FILTER_OPS: ['eq', 'neq'],
        AGG_FNS: ['count'],
        DATE_BUCKETS: ['day'],
    };
}

test('a key or value added to the screen, theme, design, nav, section, node and item tables, or a data word, is one item each', () => {
    const before = JSON.stringify(wideCatalogue());
    const tables = /** @type {any} */ (wideCatalogue());
    const columns = tables.COMPONENT_SPECS.table.props.columns.itemShape;
    columns.note = { type: 'string', since: 3, description: 'A footnote.' };
    columns.align.values.push('center');
    columns.align.valuesSince = { center: 3 };
    columns.tones.itemShape.icon = { type: 'icon', since: 3 };
    tables.SCREEN_SPEC.layout = { type: 'enum', values: [null, 'split'], since: 3, description: 'Two columns.' };
    tables.SCREEN_SPEC.maxWidth.values.push('ultra');
    tables.SCREEN_SPEC.maxWidth.valuesSince = { ultra: 3 };
    tables.THEME_SPEC.tint = { type: 'color', optional: true, since: 3, description: 'A second colour.' };
    tables.THEME_SPEC.radius.values.push('pill');
    tables.THEME_SPEC.radius.valuesSince = { pill: 4 };
    tables.DESIGN_SPEC.backdrop = { type: 'enum', values: ['none', 'dots'], optional: true, since: 3 };
    tables.DESIGN_SPEC.motion.values.push('expressive');
    tables.DESIGN_SPEC.motion.valuesSince = { expressive: 3 };
    tables.NAV_STYLES.push('dock');
    tables.SECTION_STYLE_KNOBS.push('radius');
    tables.FIELD_TYPES.push('money');
    tables.FILTER_OPS.push('near');
    tables.AGG_FNS.push('median');
    tables.DATE_BUCKETS.push('fortnight');
    const { items, base } = split(tables, {
        keyMarks: {
            section: { title: { since: 3, shape: 'string', description: 'A title.' } },
            sectionStyle: { radius: { since: 3, description: 'Round corners.' } },
            node: { styleWhen: { since: 3, shape: '[…]', description: 'Conditional style.' } },
            nav: { footer: { since: 3, shape: 'string', description: 'A footer.' }, style: { valuesSince: { dock: 3 }, shape: 'tabs|dock', description: 'dock = bottom.' } },
            navGroup: { badge: { since: 3, shape: 'formula', description: 'A count.' } },
        },
        dataMarks: {
            fieldTypes: { money: { since: 3, description: 'An amount.' }, text: { since: 2, description: 'Base.' } },
            fieldOptions: { mask: { since: 3, shape: 'string', description: 'A mask.' } },
            filterOps: { near: { since: 3, description: 'Near.' } },
            aggFns: { median: { since: 3, description: 'Middle.' } },
            dateBuckets: { fortnight: { since: 3, description: 'Two weeks.' } },
        },
    });
    assert.deepEqual(items.map((i) => `${i.family} ${i.name}`), [
        'itemKeys table.columns[].note', 'itemKeys table.columns[].tones[].icon',
        'enumValues design.motion=expressive', 'enumValues nav.style=dock', 'enumValues screen.maxWidth=ultra', 'enumValues table.columns[].align=center', 'enumValues theme.radius=pill',
        'screenKeys screen.layout',
        'sectionKeys section.style.radius', 'sectionKeys section.title',
        'nodeKeys node.styleWhen',
        'themeKeys theme.tint',
        'designKeys design.backdrop',
        'navKeys nav.footer', 'navKeys nav.groups[].badge',
        'data aggFn.median', 'data dateBucket.fortnight', 'data fieldOption.mask', 'data fieldType.money', 'data filterOp.near',
    ]);
    assert.equal(JSON.stringify(base), before, 'the base is the catalogue as it was before the entries');
    // A table nothing was added to is the same object.
    assert.equal(base.STYLE_KNOBS.span, tables.STYLE_KNOBS.span);
});

test('a knob that is itself an extension never shows as a base section knob, marked or not', () => {
    const tables = /** @type {any} */ (wideCatalogue());
    tables.STYLE_KNOBS.glow = { type: 'enum', values: ['none', 'soft'], default: 'none', since: 3 };
    tables.SECTION_STYLE_KNOBS.push('glow');
    const { base } = split(tables);
    assert.deepEqual(base.SECTION_STYLE_KNOBS, ['padding']);
});

test('the live tiers follow the spec tables: test entries appear, and are gone again afterwards', () => {
    const itemsBefore = tiers.extensionItems();
    const allTables = Object.keys(tiers.fullCatalogue());
    const baseBefore = JSON.stringify(allTables.map((t) => tiers.baseCatalogue()[t]));
    assert.ok(TABLES.every((t) => allTables.includes(t)));
    assert.ok(!itemsBefore.some((i) => isFixtureName(i.name)));
    withExtensionFixtures(() => {
        const found = tiers.extensionItems().filter((i) => isFixtureName(i.name)).map((i) => `${i.family}:${i.name}`);
        const expected = [
            `componentTypes:${FIXTURE_NAMES.type}`,
            `props:${FIXTURE_NAMES.prop}`,
            `styleKnobs:${FIXTURE_NAMES.knob}`,
            `enumValues:${FIXTURE_NAMES.propValue}`,
            `enumValues:${FIXTURE_NAMES.knobValue}`,
            `stepKinds:${FIXTURE_NAMES.stepKind}`,
            `stepFields:${FIXTURE_NAMES.stepField}`,
            `bindingKinds:${FIXTURE_NAMES.bindingKind}`,
            `topLevelKeys:${FIXTURE_NAMES.topLevelKey}`,
            ...Object.entries(KEY_FIXTURE_NAMES).flatMap(([family, names]) => names.map((name) => `${family}:${name}`)),
        ];
        assert.deepEqual([...found].sort(), [...expected].sort());
        // By family in the order of the index, by name within a family.
        const rank = (/** @type {string} */ entry) => tiers.EXTENSION_FAMILIES.indexOf(/** @type {any} */ (entry.split(':')[0]));
        assert.deepEqual(found, [...found].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1)));
        assert.equal(tiers.hasExtensions(), true);
        const base = tiers.baseCatalogue();
        assert.equal(JSON.stringify(allTables.map((t) => base[t])), baseBefore, 'no base table moved');
        assert.ok(specs.COMPONENT_SPECS.zz_gauge && !base.COMPONENT_SPECS.zz_gauge);
        assert.ok(specs.STEP_KINDS.includes('zz_wait') && !base.STEP_KINDS.includes('zz_wait'));
        // The whole catalogue is the spec hub's own tables, not copies.
        const full = tiers.fullCatalogue();
        for (const t of TABLES) assert.equal(full[t], specs[t], t);
        assert.equal(full.SCREEN_SPEC, specs.SCREEN_SPEC);
        assert.ok(full.FIELD_TYPES.includes('zz_money') && !base.FIELD_TYPES.includes('zz_money'));
    });
    assert.deepEqual(tiers.extensionItems(), itemsBefore);
    assert.equal(JSON.stringify(allTables.map((t) => tiers.baseCatalogue()[t])), baseBefore);
    // With nothing marked the two tiers are one object (whatever ships decides which case this is).
    assert.equal(tiers.fullCatalogue() === tiers.baseCatalogue(), itemsBefore.length === 0);
});
