/**
 * Unit — datatable column normalisation. DB-free.
 *
 * The load-bearing assertion in this file is the boring one: every returned
 * field has an id. `migrationPlan` matches fields by id, so a field without one
 * is not "unmatched" — it is invisible, and the column is silently never
 * created in Postgres.
 *
 * Run: node --test --test-force-exit core/dataEngine/dataModel/datatableFields.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
    normalizeFields, backfillModelFieldIds, DATATABLE_FIELD_TYPES, FIELD_ID_RE,
} = require('./datatableFields');
const { migrationPlan } = require('./migrationPlan');

test('every normalised field gets an id', () => {
    const r = normalizeFields([{ key: 'email', name: 'Email', type: 'text' }], []);
    assert.strictEqual(r.ok, true);
    assert.match(r.fields[0].id, FIELD_ID_RE);
});

test('the planner actually emits DDL for a normalised field (the whole point)', () => {
    // Regression: with id-less fields this plan came back EMPTY, so the route
    // skipped applyMigration and answered 200 for a column the table never grew.
    const before = { tables: [] };
    const created = normalizeFields([{ key: 'email', name: 'Email', type: 'text' }], []);
    const after = { tables: [{ id: 'tbl_a1', key: 't', name: 't', fields: created.fields }] };

    const createPlan = migrationPlan(before, after, { dialect: 'pg' });
    assert.strictEqual(createPlan.length, 1);
    assert.match(createPlan[0], /"email"/, 'the author column is in the CREATE TABLE');

    const grown = normalizeFields(
        [...created.fields, { key: 'hits', name: 'Hits', type: 'number' }],
        created.fields,
    );
    const later = { tables: [{ id: 'tbl_a1', key: 't', name: 't', fields: grown.fields }] };
    const addPlan = migrationPlan(after, later, { dialect: 'pg' });
    assert.strictEqual(addPlan.length, 1);
    assert.match(addPlan[0], /ADD COLUMN.*"hits"/i);
});

test('an existing column keeps its id, so a save is never a drop-and-recreate', () => {
    const first = normalizeFields([{ key: 'email', name: 'Email', type: 'text' }], []);
    // A client that never learned about ids sends the key only.
    const again = normalizeFields([{ key: 'email', name: 'E-mail address', type: 'text' }], first.fields);
    assert.strictEqual(again.fields[0].id, first.fields[0].id);
    assert.strictEqual(again.fields[0].name, 'E-mail address');
});

test('a rename keeps the id, so the planner emits RENAME rather than DROP + ADD', () => {
    const first = normalizeFields([{ key: 'email', name: 'Email', type: 'text' }], []);
    const renamed = normalizeFields(
        [{ id: first.fields[0].id, key: 'contact_email', name: 'Email', type: 'text' }],
        first.fields,
    );
    assert.strictEqual(renamed.fields[0].id, first.fields[0].id);

    const plan = migrationPlan(
        { tables: [{ id: 'tbl_a1', key: 't', name: 't', fields: first.fields }] },
        { tables: [{ id: 'tbl_a1', key: 't', name: 't', fields: renamed.fields }] },
        { dialect: 'pg' },
    );
    assert.ok(plan.some(s => /RENAME COLUMN/i.test(s)), `expected a rename, got ${JSON.stringify(plan)}`);
    assert.ok(!plan.some(s => /DROP COLUMN/i.test(s)), 'a rename must never drop the column');
});

test('two fields never share an id even when the caller repeats one', () => {
    const first = normalizeFields([{ key: 'a', name: 'A', type: 'text' }], []);
    const id = first.fields[0].id;
    const r = normalizeFields([
        { id, key: 'a', name: 'A', type: 'text' },
        { id, key: 'b', name: 'B', type: 'text' },
    ], first.fields);
    assert.strictEqual(r.ok, true);
    assert.notStrictEqual(r.fields[0].id, r.fields[1].id);
});

test('system columns, reserved prefixes and bad keys are refused', () => {
    for (const key of ['id', 'created_at', 'updated_at', 'created_by', 'org_id']) {
        assert.strictEqual(normalizeFields([{ key, name: key, type: 'text' }], []).ok, false, key);
    }
    assert.strictEqual(normalizeFields([{ key: 'pg_x', name: 'x', type: 'text' }], []).ok, false);
    assert.strictEqual(normalizeFields([{ key: 'sqlite_x', name: 'x', type: 'text' }], []).ok, false);
    assert.strictEqual(normalizeFields([{ key: 'Email', name: 'x', type: 'text' }], []).ok, false, 'uppercase');
    assert.strictEqual(normalizeFields([{ key: '9lives', name: 'x', type: 'text' }], []).ok, false, 'leading digit');
    assert.strictEqual(normalizeFields([{ key: '', name: 'x', type: 'text' }], []).ok, false, 'empty');
});

test('duplicate keys are refused', () => {
    const r = normalizeFields([
        { key: 'a', name: 'A', type: 'text' },
        { key: 'a', name: 'Also A', type: 'text' },
    ], []);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /both use the key/);
});

test('relation and computed are not datatable column types', () => {
    assert.ok(!DATATABLE_FIELD_TYPES.includes('relation'));
    assert.ok(!DATATABLE_FIELD_TYPES.includes('computed'));
    for (const type of ['relation', 'computed', 'nonsense', '']) {
        assert.strictEqual(normalizeFields([{ key: 'x', name: 'x', type }], []).ok, false, type);
    }
    for (const type of DATATABLE_FIELD_TYPES) {
        const field = { key: 'x', name: 'x', type };
        if (type === 'select' || type === 'multiselect') field.options = ['one'];
        assert.strictEqual(normalizeFields([field], []).ok, true, type);
    }
});

test('a list column needs options, and they are de-duplicated', () => {
    assert.strictEqual(normalizeFields([{ key: 'x', name: 'x', type: 'select' }], []).ok, false);
    const r = normalizeFields([{ key: 'x', name: 'x', type: 'select', options: ['a', 'a', ' b '] }], []);
    assert.deepStrictEqual(r.fields[0].options, ['a', 'b']);
});

test('a non-array or over-long list is refused rather than truncated', () => {
    assert.strictEqual(normalizeFields(null, []).ok, false);
    assert.strictEqual(normalizeFields('nope', []).ok, false);
    const many = Array.from({ length: 400 }, (_, i) => ({ key: `c${i}`, name: `c${i}`, type: 'text' }));
    assert.strictEqual(normalizeFields(many, []).ok, false);
});

test('backfillModelFieldIds repairs a model written before ids existed', () => {
    const legacy = { modelVersion: 1, tables: [{ id: 'tbl_a', key: 'das', name: 'das', fields: [{ key: 't', name: 'test', type: 'text' }] }] };
    const { model, changed } = backfillModelFieldIds(legacy);
    assert.strictEqual(changed, true);
    assert.match(model.tables[0].fields[0].id, FIELD_ID_RE);
    // Idempotent: a second pass changes nothing.
    assert.strictEqual(backfillModelFieldIds(model).changed, false);
});

test('backfillModelFieldIds leaves a healthy model untouched by identity', () => {
    const healthy = { modelVersion: 1, tables: [{ id: 'tbl_a', key: 'k', name: 'k', fields: [{ id: 'fld_abc123', key: 't', name: 't', type: 'text' }] }] };
    const { model, changed } = backfillModelFieldIds(healthy);
    assert.strictEqual(changed, false);
    assert.strictEqual(model, healthy, 'same object back when there was nothing to fix');
});
