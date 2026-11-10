'use strict';
/**
 * The paging props table.pagination, list.pagination and data_grid.pagination are props marked
 * `since: 3` (componentSpecs/README.md, "a prop on an existing type"). Shipped, not a fixture:
 *
 *   - a definition that sets one is stored as schemaVersion 3, one that does not keeps 2 and
 *     carries no `pagination` key (canonicalize/shared.js isLateEntry);
 *   - the base tier the pinned prompt renders does not hold them, the extension index lists
 *     them and app_inspect_catalog serves them in full;
 *   - the builder's component tools accept them like any prop, and the validator holds them to
 *     their own values.
 *
 * Run: node --test appStudio/schemaSince.paging.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const specs = require('./componentSpecs');
const since = require('./schemaSince.mts');
const { canonicalizeAppDefinition } = require('./canonicalize');
const { validateAppDefinition } = require('./validate');
const { applyToolCall } = require('./builderTools');
const ops = require('./definitionOps');
const tiers = require('./catalogTiers.mts');
const { renderExtensionIndex } = require('./builderPrompt/extensionIndex.mts');

const { emptyDefinition, SCHEMA_VERSION_BASE } = specs;
const SOURCE = { kind: 'records', tableId: 'tbl_tick01', limit: 20 };
/** [type, a mode it offers]. */
const PAGED = [['table', 'prevNext'], ['list', 'loadMore'], ['data_grid', 'loadMore']];

function appWith(type, props) {
    const def = emptyDefinition('Paged');
    def.screens[0].sections[0].children.push({ id: 'cmp_paged001', type, props: { source: SOURCE, ...props } });
    return def;
}
const node = (def) => def.screens[0].sections[0].children[0];

test('without pagination a paged type keeps the base version and no pagination key', () => {
    for (const [type] of PAGED) {
        for (const props of [{}, { pagination: null }]) {
            const out = canonicalizeAppDefinition(appWith(type, props)).def;
            assert.equal(out.schemaVersion, SCHEMA_VERSION_BASE, type);
            assert.equal(since.requiredSchemaVersion(out), SCHEMA_VERSION_BASE, type);
            assert.equal('pagination' in node(out).props, false, `${type}: an unset later prop is not written`);
        }
    }
});

test('pagination raises the version to 3, sits after the base props, and a second pass changes nothing', () => {
    for (const [type, mode] of PAGED) {
        const def = appWith(type, { pagination: mode });
        assert.equal(since.requiredSchemaVersion(def), 3, type);
        const out = canonicalizeAppDefinition(def).def;
        assert.equal(out.schemaVersion, 3, `${type}: canonicalize stamps 3`);
        assert.equal(node(out).props.pagination, mode);
        const keys = Object.keys(node(out).props);
        assert.equal(keys[keys.length - 1], 'pagination', `${type}: appended after the base props`);
        assert.equal(JSON.stringify(canonicalizeAppDefinition(out).def), JSON.stringify(out), `${type}: idempotent`);
        assert.equal(validateAppDefinition(out).ok, true, type);
    }
});

test('the base tier leaves pagination out; the extension index and app_inspect_catalog carry it', async () => {
    const base = tiers.baseCatalogue().COMPONENT_SPECS;
    const full = tiers.fullCatalogue().COMPONENT_SPECS;
    const index = renderExtensionIndex();
    const names = PAGED.map(([type]) => `${type}.pagination`);
    for (const [type] of PAGED) {
        assert.equal('pagination' in base[type].props, false, `${type}: not in the pinned tier`);
        assert.equal(full[type].props.pagination.since, 3, type);
        assert.ok(index.includes(`${type}.pagination — `), `${type}: listed in the extension index`);
    }
    const items = tiers.extensionItems().filter((item) => names.includes(item.name));
    assert.deepEqual(items.map((item) => item.family), ['props', 'props', 'props']);

    const wrap = { userId: 'u1', orgId: null, appId: null, version: null, builderSessionId: 'bs_page', def: emptyDefinition('Paged') };
    const r = await applyToolCall('app_inspect_catalog', { extensions: names }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.match(r.extensions['table.pagination'], /^table\.pagination: "loadMore"\|"prevNext" — Pages through a records source/);
    assert.match(r.extensions['list.pagination'], /^list\.pagination: "loadMore"\|"prevNext" — /);
    assert.match(r.extensions['data_grid.pagination'], /^data_grid\.pagination: "loadMore" — /);
    const family = await applyToolCall('app_inspect_catalog', { family: 'props' }, wrap);
    for (const name of names) assert.ok(name in family.extensions, `${name} in family props`);
});

test('the component tools write pagination; a mode the type lacks is a validation error', async () => {
    const wrap = { userId: 'u1', orgId: null, appId: null, version: null, builderSessionId: 'bs_page', def: emptyDefinition('Paged') };
    const parentId = wrap.def.screens[0].sections[0].id;
    const r = await applyToolCall('app_add_components', {
        parentId,
        components: [{ tempId: 'grid', type: 'data_grid', props: { source: SOURCE, pagination: 'loadMore' } }],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    const def = canonicalizeAppDefinition(wrap.def).def;
    assert.equal(ops.findNode(def, r.ids.grid).node.props.pagination, 'loadMore');
    assert.equal(def.schemaVersion, 3);

    const bad = canonicalizeAppDefinition(appWith('data_grid', { pagination: 'prevNext' })).def;
    const v = validateAppDefinition(bad);
    assert.ok(v.errors.some((e) => e.code === 'prop.enum' && e.path.endsWith('.props.pagination')), JSON.stringify(v.errors));
});
