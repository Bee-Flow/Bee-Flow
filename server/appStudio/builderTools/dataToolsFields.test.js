'use strict';

/**
 * The field half of app_upsert_table (dataToolsFields.js): reading an
 * authored field spec, checking its key and type, finding the field it
 * evolves, and building the stored field with what it inherits.
 *
 * Run: cd server && node --test appStudio/builderTools/dataToolsFields.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    coerceFieldDefault, normaliseFieldSpec, checkFieldSpec, priorField, buildField,
} = require('./dataToolsFields');

const MODEL = { tables: [{ id: 'tbl_a', key: 'clients', fields: [] }] };

test('coerceFieldDefault reads a default by the field type', () => {
    assert.deepEqual(coerceFieldDefault('false', 'bool', 'fields[0]'), { value: false });
    assert.deepEqual(coerceFieldDefault('1', 'bool', 'fields[0]'), { value: true });
    assert.deepEqual(coerceFieldDefault(' 12 ', 'number', 'fields[0]'), { value: 12 });
    assert.deepEqual(coerceFieldDefault('2026-01-01', 'date', 'fields[0]'), { value: '2026-01-01' });
    assert.match(coerceFieldDefault('maybe', 'bool', 'fields[3]').error, /^fields\[3\]\.default "maybe" is not a boolean/);
    assert.match(coerceFieldDefault('', 'number', 'fields[1]').error, /is not a number/);
});

test('normaliseFieldSpec reads label as name and derives a missing key', () => {
    /** @type {string[]} */
    const derived = [];
    const given = { label: 'Due date', type: 'date' };
    const raw = normaliseFieldSpec(given, 0, new Set(), derived);
    assert.equal(raw.name, 'Due date');
    assert.equal(raw.label, undefined);
    assert.equal(typeof raw.key, 'string');
    assert.equal(derived.length, 1);
    assert.deepEqual(given, { label: 'Due date', type: 'date' }, 'the input is never touched');

    const explicit = normaliseFieldSpec({ key: 'due', name: 'Due date', type: 'date' }, 1, new Set(), derived);
    assert.equal(explicit.key, 'due');
    assert.equal(derived.length, 1, 'an explicit key derives nothing');
});

test('checkFieldSpec refuses a bad key, a system column, a duplicate and an unknown type', () => {
    const seen = new Set();
    assert.match(checkFieldSpec({ key: 'Bad Key', type: 'text' }, 'fields[0]', seen).error, /must be lowercase snake_case/);
    const system = checkFieldSpec({ key: 'created_at', type: 'text' }, 'fields[0]', seen);
    assert.match(system.error, /reserved system column/);
    assert.ok(system._fixHint);

    const ok = checkFieldSpec({ key: 'title', type: 'text' }, 'fields[0]', seen);
    assert.equal(ok.error, undefined);
    assert.equal(ok.spec.key, 'title');
    assert.ok(seen.has('title'));
    assert.match(checkFieldSpec({ key: 'title', type: 'text' }, 'fields[1]', seen).error, /is duplicated in this call/);
    assert.match(checkFieldSpec({ key: 'amount', type: 'numbr' }, 'fields[2]', seen).error, /is not a field type\. Did you mean "number"\?/);
});

test('priorField finds the field by id, else by key, and refuses an unknown id', () => {
    const old = { id: 'fld_1', key: 'title', type: 'text' };
    const table = { byId: new Map([['fld_1', old]]), byKey: new Map([['title', old]]), oldFields: [old], tableId: 'tbl_a' };
    assert.equal(priorField({ key: 'other', type: 'text', fieldId: 'fld_1' }, 'fields[0]', table).old, old);
    assert.equal(priorField({ key: 'title', type: 'text' }, 'fields[0]', table).old, old);
    assert.equal(priorField({ key: 'fresh', type: 'text' }, 'fields[0]', table).old, null);
    const unknown = priorField({ key: 'title', type: 'text', fieldId: 'fld_9' }, 'fields[0]', table);
    assert.match(unknown.error, /fields\[0\]\.fieldId "fld_9" does not exist on tbl_a/);
    assert.match(unknown._fixHint, /fld_1/);
});

test('buildField keeps the old id and inherits what the spec leaves out', () => {
    const old = {
        id: 'fld_1', key: 'status', name: 'Status', type: 'select', options: ['open', 'done'], default: 'open',
    };
    const { field } = buildField({ key: 'status', type: 'select' }, old, 'fields[0]', MODEL);
    assert.deepEqual(field, {
        id: 'fld_1', key: 'status', name: 'Status', type: 'select', required: false, unique: false,
        default: 'open', options: ['open', 'done'],
    });
    assert.match(buildField({ key: 'kind', type: 'select' }, null, 'fields[1]', MODEL).error, /requires a non-empty options array/);
});

test('buildField reads relation and computed specs', () => {
    const rel = buildField({ key: 'client', type: 'relation', relation: { tableId: 'tbl_a', displayFieldKey: 'name' } }, null, 'fields[0]', MODEL);
    assert.deepEqual(rel.field.relation, { table: 'tbl_a', displayField: 'name' });
    const missing = buildField({ key: 'client', type: 'relation' }, null, 'fields[0]', MODEL);
    assert.match(missing.error, /requires relation: \{ tableId \}/);
    assert.ok(missing._fixHint);

    const stored = { id: 'fld_2', key: 'total', name: 'Total', type: 'computed', computed: { expr: 'a + b', stored: true } };
    const kept = buildField({ key: 'total', type: 'computed', computed: { expr: 'a * b' } }, stored, 'fields[1]', MODEL);
    assert.deepEqual(kept.field.computed, { expr: 'a * b', stored: true }, 'saying nothing about stored keeps it stored');
    assert.match(buildField({ key: 'total', type: 'computed' }, null, 'fields[1]', MODEL).error, /requires computed: \{ expr, type\? \}/);
});
