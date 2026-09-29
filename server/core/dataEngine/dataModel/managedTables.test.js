/**
 * The two shapes a managed kind can take, side by side: http_cache locks a
 * DECLARED subset and welcomes extra columns; nextcloud_table and
 * spreadsheet_file lock the WHOLE list because none of it is the author's.
 */
const test = require('node:test');
const assert = require('node:assert');
const {
    MANAGED_KINDS, HTTP_CACHE_FIELDS, FORM_ANSWERS_FIELDS, isManagedKind, isSourceManagedKind,
    isDefinitionManagedKind, isSchemaLockedKind, managedKindSpec, managedFieldsError,
} = require('./managedTables');

test('form_answers is the third shape: definition-owned, schema-locked, aged like an ordinary table', () => {
    assert.ok(isManagedKind('form_answers'));
    assert.equal(isSourceManagedKind('form_answers'), false, 'not a mirror — nothing to sync');
    assert.ok(isDefinitionManagedKind('form_answers'));
    assert.equal(isDefinitionManagedKind('nextcloud_table'), false);
    assert.equal(isDefinitionManagedKind('http_cache'), false);
    assert.ok(isSchemaLockedKind('form_answers'));
    assert.ok(isSchemaLockedKind('nextcloud_table'));
    assert.equal(isSchemaLockedKind('http_cache'), false);
    const spec = managedKindSpec('form_answers');
    assert.deepEqual(spec.fields.map(f => f.key), ['run_id', 'completed_at']);
    assert.equal(spec.fields, FORM_ANSWERS_FIELDS);
    assert.equal(spec.fieldsFromDefinition, true);
    assert.equal(spec.fieldsFromSource, undefined);
    assert.equal(spec.retentionField, 'created_at', 'answers age by when they were given');
    assert.equal(spec.defaultRetentionDays, null);
    assert.ok(spec.defaultDescription.length > 20);
    assert.ok(spec.warning.length > 20);
    // Every list is refused — the intact one included — and the sentence
    // points at the form, never at a source or at Nextcloud.
    const intact = spec.fields.map(f => ({ ...f }));
    for (const fields of [intact, [], [...intact, { key: 'x', type: 'text' }], null]) {
        const msg = managedFieldsError('form_answers', fields) || '';
        assert.match(msg, /form/);
        assert.doesNotMatch(msg, /Nextcloud|source/);
    }
});

test('nextcloud_table is a managed kind whose columns come from the source', () => {
    assert.ok(isManagedKind('nextcloud_table'));
    assert.ok(isSourceManagedKind('nextcloud_table'));
    assert.equal(isSourceManagedKind('http_cache'), false);
    assert.equal(isSourceManagedKind('nope'), false);
    const spec = managedKindSpec('nextcloud_table');
    assert.deepEqual(spec.fields, []);
    assert.equal(spec.fieldsFromSource, true);
    assert.equal(spec.retentionField, null);
    assert.ok(spec.defaultDescription.length > 20);
    assert.ok(spec.warning.length > 20);
});

test('nextcloud_table refuses every column list, an identical one included', () => {
    for (const fields of [[], [{ key: 'x', type: 'text' }], null]) {
        assert.match(managedFieldsError('nextcloud_table', fields) || '', /Nextcloud/);
    }
});

test('http_cache is untouched: its own columns intact are allowed, extras welcome, a drop refused', () => {
    const intact = HTTP_CACHE_FIELDS.map(f => ({ ...f }));
    assert.equal(managedFieldsError('http_cache', intact), null);
    assert.equal(managedFieldsError('http_cache', [...intact, { key: 'note', type: 'text' }]), null);
    assert.match(managedFieldsError('http_cache', intact.slice(1)) || '', /cache_key/);
    assert.equal(managedFieldsError('plain_table_kind', []), null);
});

test('spreadsheet_file is the second source-managed kind, with its own words', () => {
    assert.ok(isManagedKind('spreadsheet_file'));
    assert.ok(isSourceManagedKind('spreadsheet_file'));
    const spec = managedKindSpec('spreadsheet_file');
    assert.deepEqual(spec.fields, []);
    assert.equal(spec.fieldsFromSource, true);
    assert.equal(spec.retentionField, null);
    assert.equal(spec.sourceLabel, 'the spreadsheet');
    assert.equal(spec.builderKind, 'spreadsheet');
    assert.ok(spec.defaultDescription.length > 20);
    assert.ok(spec.warning.length > 20);
    // the refusal names ITS source, not Nextcloud
    for (const fields of [[], [{ key: 'x', type: 'text' }], null]) {
        const msg = managedFieldsError('spreadsheet_file', fields) || '';
        assert.match(msg, /the spreadsheet/);
        assert.doesNotMatch(msg, /Nextcloud/);
    }
});

test('every kind carries the fields the client mirror is checked against', () => {
    for (const [kind, spec] of Object.entries(MANAGED_KINDS)) {
        assert.equal(spec.kind, kind);
        assert.ok(Array.isArray(spec.fields));
        assert.equal(typeof spec.label, 'string');
        // A source-managed kind must be able to say where its columns come
        // from and what the builder calls it — both are read by the registry.
        if (spec.fieldsFromSource) {
            assert.equal(typeof spec.sourceLabel, 'string', `${kind}: sourceLabel`);
            assert.equal(typeof spec.builderKind, 'string', `${kind}: builderKind`);
        }
    }
});
