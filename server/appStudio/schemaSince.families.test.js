'use strict';
/**
 * The schema version a definition needs, per place a `since` mark can sit: a definition that
 * uses the marked thing needs version 3, one that does not keeps version 2.
 *
 * Every mark here is a test-only fixture (testUtils/appCatalogExtensions.testkit.js): nothing
 * depends on what the registries ship. Where the canonicalizer keeps the fixture (it reads the
 * live tables), the version is read off the canonical output; where the fixture sits in a
 * frozen table or in hand-written canonicalizer code, off requiredSchemaVersion itself.
 *
 * Run: node --test appStudio/schemaSince.families.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const specs = require('./componentSpecs');
const since = require('./schemaSince.mts');
const shared = require('../shared/appDefinition/schemaVersion.mjs');
const { canonicalizeAppDefinition } = require('./canonicalize');
const { withExtensionFixtures } = require('../testUtils/appCatalogExtensions.testkit');

const { emptyDefinition, SCHEMA_VERSION_BASE } = specs;

/** A canonical app with a table, a heading and one action, to hang each fixture on. */
function sample() {
    const def = emptyDefinition('Families');
    def.screens[0].sections[0].children.push(
        { id: 'cmp_table001', type: 'table', props: { columns: [{ key: 'name', label: 'Name', toneMap: [{ value: 'a', label: 'A' }] }] } },
        { id: 'cmp_head0001', type: 'heading', props: { text: 'Hello' } },
    );
    def.actions = {
        act_toast001: { kind: 'toast', message: 'Hi' },
        act_seq00001: { kind: 'sequence', steps: [{ kind: 'toast', message: 'Hi' }, { kind: 'generate_file', source: { kind: 'static', value: [] }, format: 'csv', resultVar: 'file' }] },
    };
    def.nav = { style: 'sidebar', groups: [{ id: 'nvg_main', label: 'Main', icon: null, screens: [def.screens[0].id] }] };
    def.design = { preset: 'custom' };
    return canonicalizeAppDefinition(def).def;
}

const table = (def) => def.screens[0].sections[0].children[0];
const heading = (def) => def.screens[0].sections[0].children[1];
const sequence = (def) => Object.values(def.actions).find((a) => a.kind === 'sequence');
const toastAction = (def) => Object.values(def.actions).find((a) => a.kind === 'toast');

/** [what, change the definition so it uses the fixture, does canonicalize keep it]. */
const CASES = [
    ['a field added to a step kind', (def) => { sequence(def).steps[0].zz_duration = 5; }, true],
    ['an enum value added to a step field', (def) => { sequence(def).steps[1].format = 'zz_tsv'; }, true],
    ['a field added to an action kind', (def) => { toastAction(def).zz_sticky = true; }, true],
    ['a key added to the items of a list prop', (def) => { table(def).props.columns[0].zz_note = 'n'; }, true],
    ['an enum value added to an item key', (def) => { table(def).props.columns[0].align = 'zz_justify'; }, true],
    ['a key added to the items of a nested list', (def) => { table(def).props.columns[0].toneMap[0].zz_icon = 'star'; }, true],
    ['an enum value added to a screen key', (def) => { def.screens[0].maxWidth = 'zz_ultra'; }, true],
    ['an event an existing type newly fires', (def) => { def.screens[0].sections[0].children.push({ id: 'cmp_div00001', type: 'divider', props: {}, onCardMove: Object.keys(def.actions)[0] }); }, true],
    ['a knob newly allowed on sections', (def) => { def.screens[0].sections[0].style.weight = 'medium'; }, true],
    ['an enum value added to a theme key', (def) => { def.theme.radius = 'zz_pill'; }, true],
    ['an enum value added to a design key', (def) => { def.design.motion = 'zz_expressive'; }, true],
    ['a screen key', (def) => { def.screens[0].zz_layout = 'split'; }, false],
    ['a section key', (def) => { def.screens[0].sections[0].zz_title = 'Totals'; }, false],
    ['a node key', (def) => { heading(def).zz_styleWhen = [{ when: 'true', style: { color: 'primary' } }]; }, false],
    ['a theme key', (def) => { def.theme.zz_tint = '#112233'; }, false],
    ['a theme key on a public page', (def) => { def.publicAccess = { theme: { zz_tint: '#112233' } }; }, false],
    ['a design key', (def) => { def.design.zz_backdrop = 'dots'; }, false],
    ['a design value on a public page', (def) => { def.publicAccess = { design: { motion: 'zz_expressive' } }; }, false],
    ['a nav key', (def) => { def.nav.zz_footer = 'Made here'; }, false],
    ['a nav style', (def) => { def.nav.style = 'zz_dock'; }, false],
    ['a nav group key', (def) => { def.nav.groups[0].zz_badge = { kind: 'formula', expr: '1' }; }, false],
    ['a filter operator in a binding', (def) => { table(def).props.source = { kind: 'records', tableId: 'tbl_x', filter: [{ field: 'a', op: 'zz_near', value: 1 }] }; }, false],
    ['a filter operator inside an any-group', (def) => { table(def).props.source = { kind: 'records', tableId: 'tbl_x', filter: [{ any: [{ field: 'a', op: 'eq', value: 1 }, { field: 'b', op: 'zz_near', value: 2 }] }] }; }, false],
    ['an aggregate function in a binding', (def) => { table(def).props.source = { kind: 'aggregate', tableId: 'tbl_x', aggregates: [{ fn: 'zz_median', field: 'a', as: 'm' }] }; }, false],
    ['a date bucket in a binding', (def) => { table(def).props.source = { kind: 'aggregate', tableId: 'tbl_x', groupBy: [{ field: 'd', bucket: 'zz_fortnight' }] }; }, false],
    ['a filter operator in a step', (def) => { sequence(def).steps.push({ kind: 'update_record', tableId: 'tbl_x', filter: [{ field: 'a', op: 'zz_near', value: 1 }], values: {} }); }, false],
];

test('with nothing marked a definition needs the base version, whatever it holds', () => {
    const base = sample();
    assert.equal(base.schemaVersion, SCHEMA_VERSION_BASE);
    for (const [what, use] of CASES) {
        const def = sample();
        use(def);
        // Unknown to this catalogue: no mark, so no version above the base (the canonicalizer drops or keeps it as it always did).
        assert.equal(since.requiredSchemaVersion(def), SCHEMA_VERSION_BASE, what);
    }
});

test('every place a since mark can sit raises the version of a definition that uses it, and of no other', () => {
    withExtensionFixtures(() => {
        const base = sample();
        assert.equal(since.requiredSchemaVersion(base), SCHEMA_VERSION_BASE, 'the sample uses no fixture');
        assert.equal(base.schemaVersion, SCHEMA_VERSION_BASE);
        for (const [what, use, canonical] of CASES) {
            const def = sample();
            use(def);
            assert.equal(since.requiredSchemaVersion(def), 3, what);
            if (!canonical) continue;
            const out = canonicalizeAppDefinition(def).def;
            assert.equal(out.schemaVersion, 3, `${what}: canonicalize stamps 3`);
            assert.equal(JSON.stringify(canonicalizeAppDefinition(out).def), JSON.stringify(out), `${what}: a second pass changes nothing`);
        }
    });
});

test('a value that is not the marked one, and a marked word in the author\'s own data, leave the version alone', () => {
    withExtensionFixtures(() => {
        const def = sample();
        sequence(def).steps[1].format = 'xlsx';
        table(def).props.columns[0].align = 'left';
        def.screens[0].maxWidth = 'wide';
        def.theme.radius = 'lg';
        // Static payloads are data: an "op" in a row is not a filter clause.
        table(def).props.source = { kind: 'static', value: [{ op: 'zz_near', fn: 'zz_median', bucket: 'zz_fortnight' }] };
        assert.equal(since.requiredSchemaVersion(def), SCHEMA_VERSION_BASE);
        // Names that only look like marks never count.
        const odd = sample();
        Object.assign(odd.screens[0], { constructor: 1, toString: 2 });
        Object.assign(odd.nav, { __proto__: null, hasOwnProperty: 'x' });
        assert.equal(since.requiredSchemaVersion(odd), SCHEMA_VERSION_BASE);
    });
});

test('with every fixture in the catalogue, no corpus app needs another version than it had', () => {
    const dir = path.join(__dirname, 'compat', 'corpus');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    assert.ok(files.length >= 30);
    const versions = () => files.map((file) => {
        const { definition } = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        return [file, since.requiredSchemaVersion(definition), canonicalizeAppDefinition(definition).def?.schemaVersion];
    });
    const before = versions();
    withExtensionFixtures(() => assert.deepEqual(versions(), before));
});

test('the index lists only what is marked: an unmarked catalogue has an empty one', () => {
    assert.equal(shared.sinceIndexIsEmpty(since.buildSinceIndex({})), true);
    const index = since.buildSinceIndex({
        stepSpecs: { toast: { fields: { seconds: { since: 3 }, tone: { valuesSince: { loud: 3, info: 2 } }, message: {} } } },
        actionSpecs: { toast: { fields: { sticky: { since: 4 } } } },
        componentSpecs: {
            table: { props: { columns: { itemShape: { note: { since: 3 }, align: { valuesSince: { justify: 3 } }, tones: { itemShape: { icon: { since: 3 } } }, key: {} } }, title: {} } },
            heading: { eventsSince: { onClick: 3, onSubmit: 2 }, props: {} },
        },
        keyTables: { screen: { layout: { since: 3 }, name: {} }, nav: { style: { valuesSince: { dock: 3 } } }, section: {} },
        queryValuesSince: { op: { near: 3, eq: 2 }, fn: {}, bucket: { fortnight: 3 } },
    });
    assert.deepEqual(JSON.parse(JSON.stringify(index)), {
        componentTypes: {}, props: {}, propValues: {}, styleKnobs: {}, styleValues: {}, stepKinds: {}, actionKinds: {}, bindingKinds: {}, topLevelKeys: {},
        stepFields: { toast: { seconds: 3 } },
        stepFieldValues: { toast: { tone: { loud: 3 } } },
        actionFields: { toast: { sticky: 4 } },
        actionFieldValues: {},
        itemShapes: { table: { columns: { keys: { note: 3 }, values: { align: { justify: 3 } }, items: { tones: { keys: { icon: 3 } } } } } },
        typeNodeKeys: { heading: { onClick: 3 } },
        keys: { screen: { layout: 3 } },
        values: { nav: { style: { dock: 3 } }, query: { op: { near: 3 }, bucket: { fortnight: 3 } } },
    });
});
