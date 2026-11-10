'use strict';
/**
 * Dataset parameters and the schema-version machinery (the style of schemaSince.families.test.js).
 *
 * What the definition holds of this feature is base vocabulary: a dataset binding has carried an
 * optional `params` map ({ name: literal | { kind:'formula', expr } }) since before the frozen
 * base, canonicalize keeps it and the validator checks it. What is new lives in the saved
 * dataset's descriptor (`descriptor.params`, a filter value `{ param }`), which is app data next
 * to the definition, not part of it, and has no schema version (like field types and field
 * options). So a definition that uses parameterised datasets keeps the version it had, the
 * extension index lists nothing for it, and the AI learns it from the two data tools
 * (app_upsert_dataset, app_query_data) whose pinned hashes were updated for it.
 *
 * Run: node --test appStudio/datasetParams.schemaSince.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const specs = require('./componentSpecs');
const since = require('./schemaSince.mts');
const { canonicalizeAppDefinition } = require('./canonicalize');
const { renderExtensionIndex } = require('./builderPrompt/extensionIndex.mts');
const { TOOL_SCHEMAS } = require('./builderTools/schemas');
const { selectToolMenu } = require('./builderModelProfiles');
const { DATASET_PARAM_TYPES } = require('./datasetParams.mts');

const { emptyDefinition, SCHEMA_VERSION_BASE } = specs;

const PARAMS = Object.freeze({ region: 'south', min: { kind: 'formula', expr: 'vars.min' } });

/** A canonical app with a table whose source is a dataset binding that sends params. */
function sample() {
    const def = emptyDefinition('Dataset params');
    def.variables = [{ name: 'min', type: 'number', default: 10 }];
    def.screens[0].sections[0].children.push({
        id: 'cmp_table001', type: 'table',
        props: { columns: [{ key: 'total', label: 'Total' }], source: { kind: 'dataset', datasetId: 'ds_region1', params: structuredClone(PARAMS) } },
    });
    return def;
}

const tool = (/** @type {any[]} */ list, /** @type {string} */ name) => list.find((t) => t.function.name === name).function;

test('a dataset binding with params is base vocabulary: canonicalize keeps it and stamps no new version', () => {
    const def = sample();
    assert.equal(since.requiredSchemaVersion(def), SCHEMA_VERSION_BASE);
    const out = canonicalizeAppDefinition(def).def;
    assert.equal(out.schemaVersion, SCHEMA_VERSION_BASE);
    assert.deepEqual(out.screens[0].sections[0].children[0].props.source, { kind: 'dataset', datasetId: 'ds_region1', params: PARAMS });
    assert.equal(JSON.stringify(canonicalizeAppDefinition(out).def), JSON.stringify(out), 'a second pass changes nothing');
});

test('the dataset-params corpus app keeps schema version 2, stored and canonical', () => {
    const file = path.join(__dirname, 'compat', 'corpus', 'dataset-params.json');
    const { definition, datasets } = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(datasets.some((d) => Array.isArray(d.descriptor?.params) && d.descriptor.params.length), 'the corpus app has a parameterised dataset');
    assert.equal(definition.schemaVersion, SCHEMA_VERSION_BASE);
    assert.equal(since.requiredSchemaVersion(definition), SCHEMA_VERSION_BASE);
    assert.equal(canonicalizeAppDefinition(definition).def.schemaVersion, SCHEMA_VERSION_BASE);
});

test('the extension index lists nothing for dataset parameters', () => {
    const text = renderExtensionIndex();
    for (const word of ['descriptor.params', 'dataset.params', 'param:']) assert.ok(!text.includes(word), word);
});

test('the data tools take dataset parameters, in the full menu and the core band', () => {
    for (const list of [TOOL_SCHEMAS, selectToolMenu({ toolset: 'core' }, TOOL_SCHEMAS)]) {
        assert.equal(tool(list, 'app_query_data').parameters.properties.params.type, 'object');
    }
    const descriptor = tool(TOOL_SCHEMAS, 'app_upsert_dataset').parameters.properties.descriptor;
    assert.deepEqual(descriptor.properties.params, { type: 'array', items: { type: 'object' } });
    assert.ok(descriptor.description.includes(`type?: ${DATASET_PARAM_TYPES.join('|')}`));
    assert.ok(descriptor.description.includes('{ param: "<name>" }'));
});
