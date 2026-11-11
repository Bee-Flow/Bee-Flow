'use strict';
/**
 * The data vocabulary this package added after the frozen base, through the foundation's marks
 * (core/dataEngine/dataModel/vocabularySince.js DATA_VOCABULARY_MARKS):
 *
 *   field types    autonumber, json, user
 *   field options  validation, dynamicDefault, format, display
 *
 * What the marks must give, and what they must leave alone:
 *   - each word is an item of the `data` family: in the prompt's extension index, served in full
 *     by app_inspect_catalog, its gloss within the index rules;
 *   - the full tool schemas accept the field types (enum, after the base), the core projection
 *     and the pinned catalogue text name the base types only, and the base tool-schema hashes
 *     stay the capture;
 *   - a field type or option lives in the data model, which has no schema version of its own:
 *     an app whose data model uses them keeps the definition version it had
 *     (catalogContract.test.js counts these items out of the schema-version index).
 *
 * Run: node --test appStudio/dataVocabulary.shipped.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { DATA_VOCABULARY_MARKS, BASE_FIELD_TYPES } = require('../core/dataEngine/dataModel/vocabularySince');
const { FIELD_TYPES } = require('../core/dataEngine/dataModel/vocabulary');
const { extensionItems } = require('./catalogTiers.mts');
const { renderExtensionIndex, inspectExtensions, GLOSS_MAX_CHARS, gloss } = require('./builderPrompt/extensionIndex.mts');

const FIELD_TYPE_WORDS = ['autonumber', 'json', 'user'];
const FIELD_OPTION_WORDS = ['validation', 'dynamicDefault', 'format', 'display'];
const NAMES = [...FIELD_TYPE_WORDS.map((w) => `fieldType.${w}`), ...FIELD_OPTION_WORDS.map((w) => `fieldOption.${w}`)];

const tool = (list, name) => list.find((t) => t.function.name === name).function;

test('the words are marked since 3 and appended after the base types', () => {
    // Later packages append their own words after these (dataVocabulary.linked.test.js).
    assert.deepEqual(Object.keys(DATA_VOCABULARY_MARKS.fieldTypes).slice(0, FIELD_TYPE_WORDS.length), FIELD_TYPE_WORDS);
    assert.deepEqual(Object.keys(DATA_VOCABULARY_MARKS.fieldOptions).slice(0, FIELD_OPTION_WORDS.length), FIELD_OPTION_WORDS);
    for (const table of [DATA_VOCABULARY_MARKS.fieldTypes, DATA_VOCABULARY_MARKS.fieldOptions]) {
        for (const mark of Object.values(table)) assert.equal(mark.since, 3);
    }
    assert.deepEqual(FIELD_TYPES.slice(BASE_FIELD_TYPES.length, BASE_FIELD_TYPES.length + FIELD_TYPE_WORDS.length), FIELD_TYPE_WORDS);
});

test('every word is a data item: in the extension index and served in full by app_inspect_catalog', () => {
    const items = extensionItems().filter((item) => item.family === 'data');
    for (const name of NAMES) assert.ok(items.some((item) => item.name === name), name);
    for (const description of [...Object.values(DATA_VOCABULARY_MARKS.fieldTypes), ...Object.values(DATA_VOCABULARY_MARKS.fieldOptions)].map((m) => m.description)) {
        const first = description.slice(0, description.indexOf('. '));
        assert.ok(first.length <= GLOSS_MAX_CHARS && !first.includes(';'), first);
        assert.equal(gloss(description), first, 'the gloss is the whole first sentence, never cut');
    }
    for (const index of [renderExtensionIndex(), renderExtensionIndex({ compact: true })]) {
        for (const name of NAMES) assert.ok(index.includes(name), name);
    }
    const byName = inspectExtensions(NAMES, undefined);
    assert.deepEqual(byName.unknown, []);
    assert.deepEqual(Object.keys(byName.entries).sort(), [...NAMES].sort());
    assert.match(byName.entries['fieldOption.format'], /^field\.format: "email" \| "url" \| "phone" \| null — /);
    assert.match(byName.entries['fieldOption.dynamicDefault'], /^field\.dynamicDefault: "now" \| "today" \| "currentUser\.id" \| null — /);
    assert.match(byName.entries['fieldOption.display'], /dateStyle\?: short\|medium\|long\|full/);
    assert.match(byName.entries['fieldType.autonumber'], /^field type "autonumber" — .*never write, seed or default it/);
    const family = inspectExtensions([], 'data');
    for (const name of NAMES) assert.ok(Object.hasOwn(family.entries, name), name);
});

test('the full tool schemas accept the types; the core projection, the catalogue text and the base hashes do not move', () => {
    const { TOOL_SCHEMAS } = require('./builderTools/schemas');
    const { selectToolMenu } = require('./builderModelProfiles');
    const { baseToolSchemaHashes, pinnedOnly } = require('../testUtils/appCatalogExtensions.testkit');
    const pinned = require('./builderTools/__tests__/toolSchemaHashes.base.json');
    const fullTypes = tool(TOOL_SCHEMAS, 'app_upsert_table').parameters.properties.fields.items.properties.type.enum;
    assert.deepEqual(fullTypes, [...FIELD_TYPES]);
    const core = selectToolMenu({ toolset: 'core' }, TOOL_SCHEMAS);
    assert.deepEqual(tool(core, 'app_upsert_table').parameters.properties.fields.items.properties.type.enum, [...BASE_FIELD_TYPES]);
    assert.ok(tool(TOOL_SCHEMAS, 'app_inspect_catalog').parameters.properties.family.enum.includes('data'));
    const fieldProps = tool(TOOL_SCHEMAS, 'app_upsert_table').parameters.properties.fields.items.properties;
    for (const word of FIELD_OPTION_WORDS) assert.equal(fieldProps[word], undefined, `${word} is no schema property: the schema stays open`);
    const hashes = baseToolSchemaHashes();
    assert.deepEqual(pinnedOnly(hashes.full, pinned.full), pinned.full);
    assert.deepEqual(pinnedOnly(hashes.core, pinned.core), pinned.core);
    const { renderCatalogText } = require('./builderPrompt/catalogRender');
    assert.ok(renderCatalogText().includes(`Field types: ${BASE_FIELD_TYPES.join(', ')}.`));
    for (const word of FIELD_TYPE_WORDS) assert.ok(!renderCatalogText().includes(`, ${word}`), word);
});

test('an app whose data model uses them keeps its definition version; the model keeps every option', () => {
    const { canonicalizeAppDefinition } = require('./canonicalize');
    const { canonicalizeDataModel } = require('./dataModel/canonicalize');
    const { validateDataModel } = require('./dataModel/modelValidate');
    const stored = JSON.parse(fs.readFileSync(path.join(__dirname, 'compat/corpus/data-model-field-types.json'), 'utf8'));
    const rules = JSON.parse(fs.readFileSync(path.join(__dirname, 'compat/corpus/data-model-field-rules.json'), 'utf8'));
    for (const app of [stored, rules]) {
        assert.equal(canonicalizeAppDefinition(app.definition).def.schemaVersion, app.definition.schemaVersion);
        assert.deepEqual(validateDataModel(canonicalizeDataModel(app.dataModel).model).errors, []);
    }
    const fields = canonicalizeDataModel(stored.dataModel).model.tables.flatMap((t) => t.fields);
    const used = new Set(fields.flatMap((f) => [f.type, ...FIELD_OPTION_WORDS.filter((k) => f[k] !== undefined)]));
    for (const word of ['autonumber', 'json', 'user', 'format', 'display']) assert.ok(used.has(word), `the corpus app uses ${word}`);
    const ruleFields = canonicalizeDataModel(rules.dataModel).model.tables.flatMap((t) => t.fields);
    for (const word of ['validation', 'dynamicDefault']) assert.ok(ruleFields.some((f) => f[word] !== undefined), `the rules app uses ${word}`);
});
