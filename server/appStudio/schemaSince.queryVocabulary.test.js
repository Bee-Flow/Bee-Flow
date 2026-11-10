'use strict';
/**
 * The query vocabulary this build ships above the base, in the style of
 * schemaSince.families.test.js but against the LIVE marks:
 *   - a query VALUE: the aggregate function `countDistinct`
 *     (core/dataEngine/dataModel/vocabularySince.js)
 *   - KEYS of a data binding: orderBy, expand, fields, groupFilter (componentSpecs/keys/binding/)
 *   - FORMS of a filter: all and not groups, a group inside a group, a clause against another
 *     column, a clause through a relation; and the groupBy entry keys binWidth and relatedField
 *     (componentSpecs/keys/queryShape/)
 * A definition that uses one is stored as schema version 3, the builder's prompt lists it in
 * the extension index only, app_inspect_catalog serves it, the canonicalizer and the validator
 * take it, and the base tier does not know it.
 *
 * Run: node --test appStudio/schemaSince.queryVocabulary.test.js
 */

const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
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

// ---------------------------------------------------------------------------
// Keys of a binding and forms of a filter (componentSpecs/keys/binding, keys/queryShape)
// ---------------------------------------------------------------------------

const CLAUSE = { field: 'channel', op: 'eq', value: 'web' };
const OTHER = { field: 'amount', op: 'gt', value: 10 };

/** A canonical app whose table reads `source`. */
function withSource(/** @type {Record<string, unknown>} */ source) {
    const def = emptyDefinition('Query keys');
    def.screens[0].sections[0].children.push({ id: 'cmp_table001', type: 'table', props: { columns: [], source } });
    return canonicalizeAppDefinition(def).def;
}

/** Each shipped mark: its index name, and a binding that uses it (a group in a group is also an all group: an any group in an any group is merged into it). */
const USES = [
    ['binding.orderBy', { kind: 'records', tableId: 'tbl_ord01', orderBy: [{ field: 'amount', dir: 'desc' }, { field: 'channel' }] }],
    ['binding.orderBy', { kind: 'aggregate', tableId: 'tbl_ord01', groupBy: [{ field: 'channel' }], aggregates: [{ fn: 'count', as: 'n' }], orderBy: [{ field: 'n', dir: 'desc' }] }],
    ['binding.expand', { kind: 'records', tableId: 'tbl_ord01', expand: [{ field: 'customer', pick: ['name'] }] }],
    ['binding.expand', { kind: 'record', tableId: 'tbl_ord01', expand: [{ field: 'customer' }] }],
    ['binding.fields', { kind: 'records', tableId: 'tbl_ord01', fields: ['amount', 'channel'] }],
    ['binding.groupFilter', { kind: 'aggregate', tableId: 'tbl_ord01', groupBy: [{ field: 'channel' }], aggregates: [{ fn: 'count', as: 'n' }], groupFilter: [{ field: 'n', op: 'gte', value: 2 }] }],
    ['filter.all', { kind: 'records', tableId: 'tbl_ord01', filter: [{ all: [CLAUSE, OTHER] }] }],
    ['filter.not', { kind: 'records', tableId: 'tbl_ord01', filter: [{ not: CLAUSE }] }],
    ['filter.nested', { kind: 'records', tableId: 'tbl_ord01', filter: [{ any: [CLAUSE, { all: [CLAUSE, OTHER] }] }] }],
    ['filter.otherField', { kind: 'records', tableId: 'tbl_ord01', filter: [{ field: 'amount', op: 'gt', otherField: 'budget' }] }],
    ['filter.relationField', { kind: 'aggregate', tableId: 'tbl_ord01', filter: [{ field: 'customer.region', op: 'eq', value: 'north' }], aggregates: [{ fn: 'count', as: 'n' }] }],
    ['groupBy.binWidth', { kind: 'aggregate', tableId: 'tbl_ord01', groupBy: [{ field: 'amount', binWidth: 50 }], aggregates: [{ fn: 'count', as: 'n' }] }],
    ['groupBy.relatedField', { kind: 'aggregate', tableId: 'tbl_ord01', groupBy: [{ field: 'customer', relatedField: 'region' }], aggregates: [{ fn: 'count', as: 'n' }] }],
];
const MARKED_NAMES = [...new Set(USES.map(([name]) => name))];

test('each key of a binding and each form of a filter this build ships makes the definition version 3', () => {
    assert.deepEqual(Object.keys(specs.KEY_MARKS.binding), ['expand', 'fields', 'groupFilter', 'orderBy']);
    assert.deepEqual(Object.keys(specs.KEY_MARKS.queryShape), ['filter.all', 'filter.nested', 'filter.not', 'filter.otherField', 'filter.relationField', 'groupBy.binWidth', 'groupBy.relatedField']);
    for (const [name, source] of USES) {
        const def = withSource(source);
        for (const key of Object.keys(source)) assert.ok(Object.hasOwn(sourceOf(def), key), `${name}: the canonicalizer keeps ${key}`);
        assert.equal(def.schemaVersion, 3, name);
        assert.equal(since.requiredSchemaVersion(def), 3, name);
        assert.equal(JSON.stringify(canonicalizeAppDefinition(def).def), JSON.stringify(def), `${name}: a second pass changes nothing`);
    }
});

test('a marked key is written after the base keys, and an entry key after field, bucket and as', () => {
    const records = withSource({ orderBy: [{ field: 'amount' }], fields: ['amount'], expand: [{ field: 'customer' }], pick: { row: 'first' }, limit: 5, filter: [CLAUSE], tableId: 'tbl_ord01', kind: 'records' });
    assert.deepEqual(Object.keys(sourceOf(records)), ['kind', 'tableId', 'filter', 'limit', 'pick', 'expand', 'fields', 'orderBy']);
    const aggregate = withSource({ kind: 'aggregate', tableId: 'tbl_ord01', groupFilter: [{ field: 'n', op: 'gt', value: 1 }], groupBy: [{ relatedField: 'region', binWidth: 10, as: 'band', field: 'customer' }], aggregates: [{ fn: 'count', as: 'n' }] });
    assert.deepEqual(Object.keys(sourceOf(aggregate)), ['kind', 'tableId', 'groupBy', 'aggregates', 'groupFilter']);
    assert.deepEqual(Object.keys(sourceOf(aggregate).groupBy[0]), ['field', 'as', 'binWidth', 'relatedField']);
});

test('the base forms stay at the base version, and a key on a kind that does not take it is dropped', () => {
    const base = [
        { kind: 'records', tableId: 'tbl_ord01', filter: [CLAUSE, { any: [CLAUSE, OTHER] }], sort: [{ field: 'amount', dir: 'desc' }], limit: 5 },
        { kind: 'records', tableId: 'tbl_ord01', filter: [{ or: [CLAUSE, { any: [OTHER] }] }] },
        { kind: 'records', tableId: 'tbl_ord01', filter: 'channel == "web" && not(all)' },
        { kind: 'record', tableId: 'tbl_ord01', filter: [{ field: 'id', op: 'eq', value: { kind: 'formula', expr: 'vars.id' }, required: true, ci: true }] },
        { kind: 'aggregate', tableId: 'tbl_ord01', groupBy: [{ field: 'created_at', bucket: 'month', as: 'm' }], aggregates: [{ fn: 'sum', field: 'amount', as: 'total' }], sort: [{ field: 'total', dir: 'desc' }] },
        { kind: 'dataset', datasetId: 'ds_x', params: { a: 1 } },
        // Null is "not set": the key is not written and nothing is stamped.
        { kind: 'records', tableId: 'tbl_ord01', orderBy: null, expand: null, fields: null },
        { kind: 'aggregate', tableId: 'tbl_ord01', groupBy: [{ field: 'amount', binWidth: null, relatedField: null }], aggregates: [{ fn: 'count', as: 'n' }], groupFilter: null },
        // Not a key of these kinds: dropped like any unknown key.
        { kind: 'aggregate', tableId: 'tbl_ord01', aggregates: [{ fn: 'count', as: 'n' }], expand: [{ field: 'customer' }], fields: ['amount'] },
        { kind: 'records', tableId: 'tbl_ord01', groupFilter: [{ field: 'n', op: 'gt', value: 1 }] },
        { kind: 'dataset', datasetId: 'ds_x', orderBy: [{ field: 'amount' }], groupFilter: [], expand: [], fields: [] },
        // The author's own data is not a read.
        { kind: 'static', value: [{ orderBy: [{ field: 'a' }], filter: [{ all: [] }, { not: {} }, { field: 'a.b', otherField: 'c' }] }] },
    ];
    for (const source of base) {
        const def = withSource(source);
        assert.equal(def.schemaVersion, SCHEMA_VERSION_BASE, JSON.stringify(source));
        for (const key of ['orderBy', 'expand', 'fields', 'groupFilter']) {
            if (source.kind !== 'static') assert.equal(Object.hasOwn(sourceOf(def), key), false, `${key} is not written: ${JSON.stringify(source)}`);
        }
    }
});

test('a form of a filter counts in a step filter too', () => {
    const def = emptyDefinition('Step filter');
    def.actions = { act_close: { kind: 'sequence', steps: [{ kind: 'update_record', tableId: 'tbl_ord01', filter: [{ not: CLAUSE }], values: {} }] } };
    assert.equal(since.requiredSchemaVersion(def), 3);
    def.actions.act_close.steps[0].filter = [{ any: [CLAUSE, OTHER] }];
    assert.equal(since.requiredSchemaVersion(def), SCHEMA_VERSION_BASE);
});

test('the corpus apps of these features are valid against their data model and stored as version 3', () => {
    for (const name of ['flex-aggregate-more', 'flex-filter-tree-order-by', 'flex-relation-expand']) {
        const entry = JSON.parse(fs.readFileSync(path.join(__dirname, 'compat', 'corpus', `${name}.json`), 'utf8'));
        const { def } = canonicalizeAppDefinition(entry.definition);
        assert.equal(def.schemaVersion, 3, name);
        const datasets = (entry.datasets || []).map((/** @type {{ id: string }} */ d) => d.id);
        assert.deepEqual(validateAppDefinition(def, { dataModel: entry.dataModel, datasets }).errors, [], name);
    }
});

test('the prompt lists the keys and forms in the extension index only, and app_inspect_catalog serves each', () => {
    const items = extensionItems();
    const family = applyInspectCatalog({ family: 'data' }).extensions;
    const index = renderExtensionIndex();
    const compactIndex = renderExtensionIndex({ compact: true });
    for (const name of MARKED_NAMES) {
        const item = items.find((entry) => entry.name === name);
        assert.ok(item, `${name} is an extension item`);
        assert.equal(item.family, 'data');
        assert.ok(index.includes(`${name} — `) && compactIndex.includes(name), `${name} is listed in the index`);
        const served = applyInspectCatalog({ extensions: [name] });
        assert.equal(served.unknown, undefined, name);
        assert.equal(typeof served.extensions[name], 'string');
        assert.ok(served.extensions[name].length > name.length, `${name} is served in full`);
        assert.ok(Object.hasOwn(family, name), `${name} is served with its family`);
    }
    assert.match(applyInspectCatalog({ extensions: ['binding.expand'] }).extensions['binding.expand'], /binding kinds: record, records/);
    assert.match(applyInspectCatalog({ extensions: ['filter.otherField'] }).extensions['filter.otherField'], /otherField/);

    // The base tier: the catalogue text names none of the new keys.
    for (const text of [renderCatalogText(), renderCompactCatalogText()]) {
        for (const word of ['orderBy', 'groupFilter', 'otherField', 'binWidth', 'relatedField', 'expand:']) assert.equal(text.includes(word), false, word);
    }
});

test('the tools that take a read take the new keys', () => {
    const tool = (/** @type {string} */ name) => TOOL_SCHEMAS.find((/** @type {any} */ entry) => entry.function.name === name).function.parameters.properties;
    const descriptor = tool('app_upsert_dataset').descriptor.properties;
    assert.equal(descriptor.orderBy.type, 'array');
    assert.equal(descriptor.groupFilter.type, 'array');
    const query = tool('app_query_data');
    for (const key of ['orderBy', 'expand', 'fields']) assert.equal(query[key].type, 'array', key);
    // Filters stay open objects: no enum refuses a group or a column comparison.
    assert.deepEqual(descriptor.filters, { type: 'array', items: { type: 'object' } });
});
