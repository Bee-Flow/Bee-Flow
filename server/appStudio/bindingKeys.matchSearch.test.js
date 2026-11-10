'use strict';
/**
 * `match` and `search` as keys of a data binding (componentSpecs/keys/binding/match.js and
 * search.js), proved the way schemaSince.families.test.js proves a mark: a definition that uses
 * one is stamped schema version 3, the AI builder lists it in the extension index and serves its
 * entry through app_inspect_catalog, and the tools accept a binding that carries it, while the
 * prompt outside the index and the base tool schemas stay byte for byte what they were.
 * `ci` on a filter clause stays unmarked: the compiler always honoured it.
 *
 * Run: node --test appStudio/bindingKeys.matchSearch.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const specs = require('./componentSpecs');
const { requiredSchemaVersion } = require('./schemaSince.mts');
const { canonicalizeAppDefinition } = require('./canonicalize');
const { buildSystemPrompt } = require('./builderPrompt');
const { renderExtensionIndex } = require('./builderPrompt/extensionIndex.mts');
const { applyInspectCatalog } = require('./builderTools/inspectionTools');
const { applyToolCall } = require('./builderTools');
const { extensionItems, _catalogueChanged } = require('./catalogTiers.mts');
const { canonicalizeDataModel } = require('./dataModel');
const { baseToolSchemaHashes, pinnedOnly } = require('../testUtils/appCatalogExtensions.testkit');
const pinned = require('./builderTools/__tests__/toolSchemaHashes.base.json');

const KEYS = ['match', 'search'];
const FORMS = [
    { toolset: 'full', catalogMode: 'full' },
    { toolset: 'full', catalogMode: 'filtered' },
    { toolset: 'core', catalogMode: 'filtered' },
];
const TAIL = '\n\nBegin now.';

const SEARCH = { value: { kind: 'formula', expr: 'vars.filters.q' }, fields: ['title'] };

function withSource(source) {
    const def = specs.emptyDefinition('Read keys');
    def.screens[0].sections[0].children.push({ id: 'cmp_tbl00001', type: 'table', props: { source } });
    return def;
}
const sourceOf = (def) => def.screens[0].sections[0].children[0].props.source;

/** Run `fn` with the two marks taken out of the registry, as the catalogue was before them. */
function withoutMarks(fn) {
    const saved = KEYS.map((key) => [key, specs.KEY_MARKS.binding[key]]);
    for (const key of KEYS) delete specs.KEY_MARKS.binding[key];
    _catalogueChanged();
    try { return fn(); } finally {
        for (const [key, mark] of saved) specs.KEY_MARKS.binding[key] = mark;
        _catalogueChanged();
    }
}

test('the marks: since 3, the kinds that read them, a first sentence the index can carry', () => {
    const { match, search } = specs.KEY_MARKS.binding;
    assert.deepEqual([match.since, search.since], [3, 3]);
    assert.deepEqual(match.kinds, ['record', 'records', 'aggregate']);
    assert.deepEqual(search.kinds, ['record', 'records']);
    for (const mark of [match, search]) {
        const first = mark.description.split('. ')[0];
        assert.ok(first.length <= 72, first);
        assert.ok(!mark.description.includes(';'));
    }
});

test('a binding that uses match or search is stamped schema version 3, one that does not keeps 2', () => {
    const uses = [
        { kind: 'records', tableId: 'tbl_task01', match: 'any', filter: [{ field: 'status', op: 'eq', value: 'a' }, { field: 'title', op: 'eq', value: 'b' }] },
        { kind: 'records', tableId: 'tbl_task01', search: SEARCH },
        { kind: 'record', tableId: 'tbl_task01', search: { value: 'fixed', fields: ['title'] } },
        { kind: 'aggregate', tableId: 'tbl_task01', match: 'any', aggregates: [{ fn: 'count', as: 'n' }] },
    ];
    for (const source of uses) {
        const out = canonicalizeAppDefinition(withSource(source)).def;
        assert.equal(out.schemaVersion, 3, JSON.stringify(source));
        assert.equal(requiredSchemaVersion(out), 3);
        for (const key of KEYS) if (key in source) assert.deepEqual(sourceOf(out)[key], source[key], key);
        assert.equal(JSON.stringify(canonicalizeAppDefinition(out).def), JSON.stringify(out), 'a second pass changes nothing');
    }
    // The default spelled out, a search where no compiler reads one, and ci: the base form, version 2.
    const base = [
        { kind: 'records', tableId: 'tbl_task01', match: 'all' },
        { kind: 'aggregate', tableId: 'tbl_task01', search: SEARCH },
        { kind: 'records', tableId: 'tbl_task01', filter: [{ field: 'status', op: 'eq', value: 'a', ci: true }] },
    ];
    for (const source of base) {
        const out = canonicalizeAppDefinition(withSource(source)).def;
        assert.equal(out.schemaVersion, 2, JSON.stringify(source));
        assert.ok(!('match' in sourceOf(out)) && !('search' in sourceOf(out)));
    }
});

test('no corpus app needs another version than it had without the marks', () => {
    const dir = path.join(__dirname, 'compat', 'corpus');
    const versions = () => fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((file) => {
        const { definition } = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        return [file, requiredSchemaVersion(definition), canonicalizeAppDefinition(definition).def?.schemaVersion];
    });
    assert.deepEqual(versions(), withoutMarks(versions));
});

test('the extension index lists both, and app_inspect_catalog serves their entries', () => {
    const names = extensionItems().map((item) => item.name);
    assert.ok(names.includes('binding.match') && names.includes('binding.search'), names.join(', '));
    for (const index of [renderExtensionIndex(), renderExtensionIndex({ compact: true })]) {
        assert.ok(index.includes('binding.match') && index.includes('binding.search'));
    }
    const { extensions } = applyInspectCatalog({ extensions: ['binding.match', 'binding.search'] });
    assert.equal(extensions['binding.match'], `binding.match: ${specs.KEY_MARKS.binding.match.shape} — binding kinds: record, records, aggregate — ${specs.KEY_MARKS.binding.match.description}`);
    assert.equal(extensions['binding.search'], `binding.search: ${specs.KEY_MARKS.binding.search.shape} — binding kinds: record, records — ${specs.KEY_MARKS.binding.search.description}`);
    assert.ok(Object.keys(applyInspectCatalog({ family: 'data' }).extensions).includes('binding.search'));
});

test('the prompt outside the index and the base tool schemas do not move', () => {
    const now = FORMS.map((form) => buildSystemPrompt(form));
    const indexes = [renderExtensionIndex(), renderExtensionIndex({ compact: true })];
    const before = withoutMarks(() => ({
        prompts: FORMS.map((form) => buildSystemPrompt(form)),
        indexes: [renderExtensionIndex(), renderExtensionIndex({ compact: true })],
    }));
    for (const i of [0, 1]) {
        const strip = (prompt, index) => (index ? prompt.replace(`\n\n${index}${TAIL}`, TAIL) : prompt);
        assert.equal(strip(now[i], indexes[i]), strip(before.prompts[i], before.indexes[i]), JSON.stringify(FORMS[i]));
    }
    assert.equal(now[2], before.prompts[2], 'the small band has the prompt it had');
    const hashes = baseToolSchemaHashes();
    assert.deepEqual(pinnedOnly(hashes.full, pinned.full), pinned.full);
    assert.deepEqual(pinnedOnly(hashes.core, pinned.core), pinned.core);
});

test('the tools accept a binding with match and search and keep both keys', async () => {
    const def = specs.emptyDefinition('Read keys');
    const dataModel = canonicalizeDataModel({
        tables: [{ id: 'tbl_task01', key: 'tasks', name: 'Tasks', fields: [{ id: 'fld_ti01', key: 'title', type: 'text' }, { id: 'fld_st01', key: 'status', type: 'text' }] }],
    }).model;
    const wrap = { userId: 'u1', def, dataModel, datasetIds: [] };
    const source = {
        kind: 'records', tableId: 'tbl_task01', match: 'any', search: SEARCH,
        filter: [{ field: 'status', op: 'eq', value: 'a' }, { field: 'title', op: 'eq', value: 'b' }],
    };
    const added = await applyToolCall('app_add_components', { parentId: def.screens[0].sections[0].id, components: [{ type: 'table', props: { source } }] }, wrap);
    assert.ok(!added.error && !added.failed, JSON.stringify(added));
    const kept = sourceOf(wrap.def);
    assert.equal(kept.match, 'any');
    assert.deepEqual(kept.search, SEARCH);
    assert.equal(canonicalizeAppDefinition(wrap.def).def.schemaVersion, 3);
});
