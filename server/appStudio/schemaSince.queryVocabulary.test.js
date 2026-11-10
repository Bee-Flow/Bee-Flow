'use strict';
/**
 * The query vocabulary this build ships above the base (core/dataEngine/dataModel/vocabularySince.js):
 * the aggregate function `countDistinct`. In the style of schemaSince.families.test.js, but
 * against the LIVE marks: a definition that uses the word is stored as schema version 3, the
 * builder's prompt lists it in the extension index only, app_inspect_catalog serves it, the
 * canonicalizer and the validator take it, and the base tier does not know it.
 *
 * Run: node --test appStudio/schemaSince.queryVocabulary.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const specs = require('./componentSpecs');
const since = require('./schemaSince.mts');
const vocabulary = require('../core/dataEngine/dataModel/vocabulary');
const marks = require('../core/dataEngine/dataModel/vocabularySince');
const { canonicalizeAppDefinition } = require('./canonicalize');
const { validateAppDefinition } = require('./validate');
const { extensionItems, baseCatalogue } = require('./catalogTiers.mts');
const { renderExtensionIndex } = require('./builderPrompt/extensionIndex.mts');
const { renderCatalogText, renderCompactCatalogText } = require('./builderPrompt/catalogRender');
const { applyInspectCatalog } = require('./builderTools/inspectionTools');
const { TOOL_SCHEMAS } = require('./builderTools/schemas');

const { emptyDefinition, SCHEMA_VERSION_BASE } = specs;

const MODEL = {
    tables: [{
        id: 'tbl_ord01', key: 'orders', name: 'Orders',
        fields: [{ id: 'fld_o1', key: 'amount', type: 'number' }, { id: 'fld_o2', key: 'channel', type: 'text' }, { id: 'fld_o3', key: 'buyer', type: 'text' }],
    }],
};

/** A canonical app whose chart reads `aggregates` per channel. */
function withAggregates(/** @type {unknown[]} */ aggregates) {
    const def = emptyDefinition('Query vocabulary');
    def.screens[0].sections[0].children.push({
        id: 'cmp_chart001', type: 'chart',
        props: { source: { kind: 'aggregate', tableId: 'tbl_ord01', groupBy: [{ field: 'channel' }], aggregates } },
    });
    return canonicalizeAppDefinition(def).def;
}

const sourceOf = (/** @type {any} */ def) => def.screens[0].sections[0].children[0].props.source;

test('countDistinct is appended after the base aggregate functions and carries its mark', () => {
    assert.equal(vocabulary.AGG_FNS.at(-1), 'countDistinct');
    assert.deepEqual([...marks.BASE_AGG_FNS], vocabulary.AGG_FNS.slice(0, -1));
    assert.equal(marks.DATA_VOCABULARY_MARKS.aggFns.countDistinct.since, 3);
    assert.deepEqual(marks.QUERY_VALUES_SINCE.fn, { countDistinct: 3 });
});

test('a definition that counts distinct values is stored as version 3; the same chart with a base function stays at the base', () => {
    const base = withAggregates([{ fn: 'count', as: 'orders' }, { fn: 'p50', field: 'amount', as: 'median' }]);
    assert.equal(base.schemaVersion, SCHEMA_VERSION_BASE);
    assert.equal(since.requiredSchemaVersion(base), SCHEMA_VERSION_BASE);

    const distinct = withAggregates([{ fn: 'countDistinct', field: 'buyer', as: 'buyers' }]);
    assert.deepEqual(sourceOf(distinct).aggregates, [{ fn: 'countDistinct', field: 'buyer', as: 'buyers' }], 'the canonicalizer keeps the aggregate');
    assert.equal(distinct.schemaVersion, 3);
    assert.equal(since.requiredSchemaVersion(distinct), 3);
    assert.equal(JSON.stringify(canonicalizeAppDefinition(distinct).def), JSON.stringify(distinct), 'a second pass changes nothing');

    // The word in the author's own data is not a use of it.
    const data = emptyDefinition('Data');
    data.screens[0].sections[0].children.push({ id: 'cmp_table001', type: 'table', props: { columns: [], source: { kind: 'static', value: [{ fn: 'countDistinct' }] } } });
    assert.equal(canonicalizeAppDefinition(data).def.schemaVersion, SCHEMA_VERSION_BASE);
});

test('the validator takes the binding against a data model', () => {
    const { errors } = validateAppDefinition(withAggregates([{ fn: 'countDistinct', field: 'buyer', as: 'buyers' }]), { dataModel: MODEL });
    assert.deepEqual(errors.filter((/** @type {{ path: string }} */ e) => e.path.includes('.source')), []);
});

test('the prompt lists the word in the extension index only, and app_inspect_catalog serves it', () => {
    const item = extensionItems().find((entry) => entry.name === 'aggFn.countDistinct');
    assert.ok(item, 'aggFn.countDistinct is an extension item');
    assert.equal(item.family, 'data');
    for (const index of [renderExtensionIndex(), renderExtensionIndex({ compact: true })]) {
        assert.ok(index.includes('aggFn.countDistinct'), 'listed in the index');
    }
    assert.ok(renderExtensionIndex().includes('Counts the different non-empty values of a field'));

    const byName = applyInspectCatalog({ extensions: ['aggFn.countDistinct'] });
    assert.equal(byName.unknown, undefined);
    assert.match(byName.extensions['aggFn.countDistinct'], /countDistinct/);
    assert.match(byName.extensions['aggFn.countDistinct'], /Needs a field/);
    assert.ok(Object.keys(applyInspectCatalog({ family: 'data' }).extensions).includes('aggFn.countDistinct'));

    // The base tier: neither catalogue text nor the base list names it.
    assert.equal(baseCatalogue().AGG_FNS.includes('countDistinct'), false);
    assert.equal(renderCatalogText().includes('countDistinct'), false);
    assert.equal(renderCompactCatalogText().includes('countDistinct'), false);
});

test('the tool schemas word the base functions only, and take a descriptor that uses the word', () => {
    const tool = TOOL_SCHEMAS.find((/** @type {any} */ entry) => entry.function.name === 'app_upsert_dataset');
    const descriptor = tool.function.parameters.properties.descriptor;
    assert.ok(descriptor.description.includes(`{fn: ${marks.BASE_AGG_FNS.join('|')}, field?, as}`));
    assert.equal(JSON.stringify(tool).includes('countDistinct'), false, 'the pinned wording does not move');
    // The aggregates are open objects: no enum refuses the word.
    assert.deepEqual(descriptor.properties.aggregates, { type: 'array', items: { type: 'object' } });
});
