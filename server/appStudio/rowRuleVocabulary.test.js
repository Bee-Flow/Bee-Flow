'use strict';
/**
 * The row rule vocabulary added after the frozen base (viewer.orgId, viewer.email,
 * viewer.groups, the membership test `in` and the rule per operation), end to end:
 *
 *   - every word is in the list it extends, after the base words, with a mark in the `rowRule`
 *     family of core/dataEngine/dataModel/vocabularySince.js
 *   - the builder's prompt names none of them outside its extension index, the index lists each
 *     one, and app_inspect_catalog serves the full entry by name and by family
 *   - the pinned text of app_upsert_table does not move, and the tool accepts a rule that uses
 *     the words (its `rowFilters` is an open object in the base schema already)
 *   - a row rule sits in the data model, which has no schema version: an app whose model uses
 *     the words keeps the schema version its definition had
 *
 * Run: node --test appStudio/rowRuleVocabulary.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const vocabulary = require('../core/dataEngine/dataModel/vocabulary');
const { DATA_VOCABULARY_MARKS, FAMILY_LISTS, isAboveBase } = require('../core/dataEngine/dataModel/vocabularySince');
const tiers = require('./catalogTiers.mts');
const since = require('./schemaSince.mts');
const shared = require('../shared/appDefinition/schemaVersion.mjs');
const index = require('./builderPrompt/extensionIndex.mts');
const { validateRowFilter, compileAccessFilter } = require('../core/dataEngine/accessFilter');
const pinned = require('./builderTools/__tests__/toolSchemaHashes.base.json');
const corpusApp = require('./compat/corpus/viewer-row-rules.json');

/** What a row rule could say about the viewer before the marks existed. Never edited. */
const FROZEN_BASE = ['viewer.id', 'viewer.role', 'viewer.organizationId'];
const MARKED = ['viewer.orgId', 'viewer.email', 'viewer.groups', 'in', 'perOperation'];
const NAMES = MARKED.map((word) => `rowRule.${word}`);

test('the base words come first and every later word carries a rowRule mark', () => {
    const list = vocabulary.ROW_RULE_WORDS;
    assert.equal(FAMILY_LISTS.rowRule, list);
    assert.deepEqual(list.slice(0, FROZEN_BASE.length), FROZEN_BASE, 'the base words keep their place; add a new word AFTER them');
    assert.deepEqual(list.slice(FROZEN_BASE.length), MARKED);
    for (const word of list.slice(FROZEN_BASE.length)) {
        const mark = DATA_VOCABULARY_MARKS.rowRule[word];
        assert.ok(mark && isAboveBase(mark.since), `ROW_RULE_WORDS gained "${word}": add it to DATA_VOCABULARY_MARKS.rowRule as { since: 3, description }`);
    }
    for (const word of FROZEN_BASE) assert.equal(Object.hasOwn(DATA_VOCABULARY_MARKS.rowRule, word), false, `${word} is base vocabulary`);
    // The list is built from the attribute table, so an attribute added there shows up here unmarked.
    for (const spec of vocabulary.VIEWER_ATTRIBUTES) assert.ok(list.includes(`viewer.${spec['key']}`));
});

test('the extension index lists each word and app_inspect_catalog serves its entry, by name and by family', () => {
    const items = tiers.extensionItems().filter((item) => item.ownerTable === 'data' && item.owner === 'rowRule');
    assert.deepEqual(items.map((item) => item.name).sort(), [...NAMES].sort());
    for (const item of items) {
        assert.equal(item.family, 'data');
        const gloss = index.gloss(item.description);
        assert.ok(gloss.length <= index.GLOSS_MAX_CHARS && !gloss.endsWith('…') && item.description.startsWith(`${gloss}. `), `${item.name}: the first sentence fits the index line whole`);
    }
    const line = index.renderExtensionIndex().split('\n').find((l) => l.startsWith('data: '));
    assert.ok(line, 'the index has a data line');
    for (const name of NAMES) assert.ok(line.includes(`${name} — `), `${name} is in the index`);

    const byName = index.inspectExtensions(NAMES, '');
    assert.deepEqual(byName.unknown, []);
    assert.match(byName.entries['rowRule.perOperation'], /^row rule "perOperation" — .*an operation left out follows the read formula \(never broader than read\).*`true` gives that operation every row/);
    assert.match(byName.entries['rowRule.in'], /record\.team in viewer\.groups/);
    assert.match(byName.entries['rowRule.viewer.groups'], /^row rule "viewer\.groups" — /);
    const byFamily = index.inspectExtensions([], 'data');
    for (const name of NAMES) assert.equal(byFamily.entries[name], byName.entries[name]);
});

test('the pinned text of app_upsert_table does not move, and names no marked word', () => {
    const { TOOL_SCHEMAS } = require('./builderTools/schemas');
    const { baseToolSchemaHashes } = require('../testUtils/appCatalogExtensions.testkit');
    assert.equal(baseToolSchemaHashes().full.app_upsert_table, pinned.full.app_upsert_table);
    const tool = TOOL_SCHEMAS.find((/** @type {any} */ t) => t.function.name === 'app_upsert_table');
    const text = JSON.stringify(tool);
    for (const word of ['viewer.orgId', 'viewer.email', 'viewer.groups']) assert.equal(text.includes(word), false, `${word} is described by its mark, not by the tool schema`);
    // The base schema leaves the value of a role's rule open, so both forms pass it as they are.
    assert.deepEqual(tool.function.parameters.properties.access.properties.rowFilters, { type: 'object' });
});

test('a rule that uses the words is accepted at save time and compiles for every operation', () => {
    const table = { key: 'tasks', fields: [{ key: 'team', type: 'text' }, { key: 'assignee', type: 'text' }], access: { default: 'app', rowFilters: {} } };
    const rule = { read: 'record.team in viewer.groups || record.assignee == viewer.email', delete: 'true' };
    assert.deepEqual(validateRowFilter(rule, table), { ok: true, errors: [] });
    table.access.rowFilters = { staff: rule };
    const viewer = { id: 'u1', email: 'a@example.org', groups: ['g1', 'g2'], orgId: 'o1' };
    const read = compileAccessFilter(table, 'staff', viewer, 'read', { dialect: 'sqlite' });
    assert.equal(read.where, '(1=1) AND ((("team" IN (?, ?)) OR ("assignee" = ?)))');
    assert.deepEqual(read.params, ['g1', 'g2', 'a@example.org']);
    // Left out: update follows the read rule. Written out as `true`: delete has every row.
    assert.deepEqual(compileAccessFilter(table, 'staff', viewer, 'update', { dialect: 'sqlite' }), read);
    assert.deepEqual(compileAccessFilter(table, 'staff', viewer, 'delete', { dialect: 'sqlite' }), { where: '(1=1) AND (?)', params: [1] });
});

test('a row rule lives in the data model: the definition beside it keeps its schema version', () => {
    const rules = corpusApp.dataModel.tables.flatMap((/** @type {any} */ t) => Object.values(t.access?.rowFilters || {}));
    const text = JSON.stringify(rules);
    assert.ok(text.includes('viewer.groups') && rules.some((/** @type {unknown} */ r) => r !== null && typeof r === 'object'), 'the corpus app uses the marked words');
    assert.equal(since.requiredSchemaVersion(corpusApp.definition), shared.SCHEMA_VERSION_BASE);
    // Like a field type and a field option, a rowRule word has no entry in the schema-version index.
    const flat = JSON.stringify(since.buildSinceIndex(since.liveCatalogue()));
    for (const word of ['viewer.orgId', 'viewer.email', 'viewer.groups', 'perOperation']) assert.equal(flat.includes(word), false, word);
});
