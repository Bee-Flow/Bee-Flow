'use strict';
/**
 * The data vocabulary of linked records (core/dataEngine/dataModel/linkedFields.js), through the
 * foundation's marks (vocabularySince.js DATA_VOCABULARY_MARKS):
 *
 *   field types     lookup, rollup
 *   field options   lookup, rollup, relation.many, relation.onDelete
 *   table options   indexes
 *
 * Each is an item of the `data` family (extension index, app_inspect_catalog), the full tool
 * schema accepts the types while the core projection and the pinned catalogue text name the base
 * types only, the AI tool keeps every option it is sent, and an app whose model uses them keeps
 * its definition version.
 *
 * Run: node --test appStudio/dataVocabulary.linked.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { DATA_VOCABULARY_MARKS, BASE_FIELD_TYPES } = require('../core/dataEngine/dataModel/vocabularySince');
const { FIELD_TYPES, APP_ONLY_FIELD_TYPES } = require('../core/dataEngine/dataModel/vocabulary');
const { extensionItems } = require('./catalogTiers.mts');
const { renderExtensionIndex, inspectExtensions } = require('./builderPrompt/extensionIndex.mts');

const NAMES = ['fieldType.lookup', 'fieldType.rollup', 'fieldOption.lookup', 'fieldOption.rollup',
    'fieldOption.relation.many', 'fieldOption.relation.onDelete', 'tableOption.indexes'];

test('the words are marked since 3, appended after the base types and app-only', () => {
    assert.deepEqual(FIELD_TYPES.slice(-2), ['lookup', 'rollup']);
    assert.ok(!BASE_FIELD_TYPES.includes('lookup') && !BASE_FIELD_TYPES.includes('rollup'));
    for (const t of ['lookup', 'rollup']) assert.ok(APP_ONLY_FIELD_TYPES.includes(t), t);
    for (const [family, word] of NAMES.map((n) => [n.slice(0, n.indexOf('.')), n.slice(n.indexOf('.') + 1)])) {
        const table = { fieldType: 'fieldTypes', fieldOption: 'fieldOptions', tableOption: 'tableOptions' }[family];
        assert.equal(DATA_VOCABULARY_MARKS[table][word].since, 3, `${family}.${word}`);
    }
});

test('every word is a data item in the index and served in full', () => {
    const items = extensionItems().filter((item) => item.family === 'data');
    for (const name of NAMES) assert.ok(items.some((item) => item.name === name), name);
    for (const index of [renderExtensionIndex(), renderExtensionIndex({ compact: true })]) {
        for (const name of NAMES) assert.ok(index.includes(name), name);
    }
    const { entries, unknown } = inspectExtensions(NAMES, undefined);
    assert.deepEqual(unknown, []);
    assert.match(entries['tableOption.indexes'], /^table\.indexes: \[\{ fields: \[<field key>, …\] \}\] .* — /);
    assert.match(entries['fieldOption.relation.onDelete'], /^field\.relation\.onDelete: "restrict" \| "setNull" \| "cascade" \| null — /);
    assert.match(entries['fieldType.rollup'], /^field type "rollup" — /);
});

test('the tool keeps lookup, rollup, many, onDelete and indexes; the core projection and catalogue text do not move', async () => {
    const { TOOL_SCHEMAS } = require('./builderTools/schemas');
    const { selectToolMenu } = require('./builderModelProfiles');
    const fn = (list) => list.find((t) => t.function.name === 'app_upsert_table').function;
    assert.deepEqual(fn(TOOL_SCHEMAS).parameters.properties.fields.items.properties.type.enum, [...FIELD_TYPES]);
    assert.deepEqual(fn(selectToolMenu({ toolset: 'core' }, TOOL_SCHEMAS)).parameters.properties.fields.items.properties.type.enum, [...BASE_FIELD_TYPES]);
    const { renderCatalogText } = require('./builderPrompt/catalogRender');
    for (const word of ['lookup', 'rollup']) assert.ok(!renderCatalogText().includes(`, ${word}`), word);

    const { mergeTableOp } = require('./builderTools/dataToolsTables');
    const model = { modelVersion: 1, tables: [{ id: 'tbl_cust01', key: 'customers', name: 'Customers', fields: [{ id: 'fld_name01', key: 'name', type: 'text' }] }] };
    const merged = mergeTableOp(model, {
        name: 'Orders',
        indexes: [{ fields: ['amount'] }],
        fields: [
            { key: 'amount', type: 'number' },
            { key: 'customer', type: 'relation', relation: { tableId: 'tbl_cust01', onDelete: 'cascade' } },
            { key: 'others', type: 'relation', relation: { tableId: 'tbl_cust01', many: true } },
            { key: 'customer_name', type: 'lookup', lookup: { relation: 'customer', field: 'name' } },
        ],
    });
    assert.equal(merged.error, undefined, merged.error);
    const byKey = Object.fromEntries(merged.table.fields.map((f) => [f.key, f]));
    assert.deepEqual(merged.table.indexes, [{ fields: ['amount'] }]);
    assert.equal(byKey.customer.relation.onDelete, 'cascade');
    assert.equal(byKey.others.relation.many, true);
    assert.deepEqual(byKey.customer_name.lookup, { relation: 'customer', field: 'name' });
    const again = mergeTableOp(merged.model, { tableId: merged.table.id, fields: [{ key: 'amount', type: 'number' }, { key: 'customer', type: 'relation', relation: { tableId: 'tbl_cust01' } }] });
    assert.equal(again.table.fields[1].relation.onDelete, 'cascade', 'a relation re-sent without onDelete keeps it');
    assert.deepEqual(again.table.indexes, [{ fields: ['amount'] }], 'indexes left out are kept');
    assert.equal(mergeTableOp(merged.model, { tableId: merged.table.id, indexes: null, fields: [{ key: 'amount', type: 'number' }] }).table.indexes, undefined);
});
