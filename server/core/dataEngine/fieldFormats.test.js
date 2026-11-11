/**
 * fieldFormats.mts: the schema-3 field shapes. Save time through validateDataModel (format,
 * display, autonumber, json), write time through applyFieldRules (a text format, JSON text).
 *
 * Run: cd server && node --test core/dataEngine/fieldFormats.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { fieldShapeErrors } = require('./fieldFormats.mts');
const { applyFieldRules, FieldValidationError } = require('./fieldRules.mts');
const { validateDataModel } = require('../../appStudio/dataModel/modelValidate');
const { canonicalizeDataModel } = require('../../appStudio/dataModel/canonicalize');

const tableOf = (fields) => ({ fields: fields.map((f, i) => ({ id: `fld_f${i}000`, key: `f${i}`, name: `Field ${i}`, ...f })) });
const modelOf = (fields) => ({ modelVersion: 1, tables: [{ id: 'tbl_t00001', key: 't', ...tableOf(fields) }] });

test('a field that uses none of it is never refused', () => {
    for (const type of ['text', 'number', 'date', 'select', 'json', 'user']) {
        assert.deepEqual(fieldShapeErrors({ type, options: [] }, 'f'), []);
    }
    assert.deepEqual(validateDataModel(modelOf([{ type: 'text' }, { type: 'number' }])).errors, []);
});

test('save time: format, display and autonumber are judged per type', () => {
    const errs = (field) => fieldShapeErrors(field, 'f');
    assert.deepEqual(errs({ type: 'text', format: 'email' }), []);
    assert.match(errs({ type: 'number', format: 'email' })[0], /applies to a text field/);
    assert.match(errs({ type: 'text', format: 'fax' })[0], /is not one of: email, url, phone/);
    assert.deepEqual(errs({ type: 'number', display: { currency: 'EUR', decimals: 2 } }), []);
    assert.deepEqual(errs({ type: 'datetime', display: { dateStyle: 'long' } }), []);
    assert.match(errs({ type: 'number', display: { currency: 'eur' } })[0], /ISO 4217/);
    assert.match(errs({ type: 'number', display: { decimals: 11 } })[0], /0 to 10/);
    assert.match(errs({ type: 'number', display: { currency: 'EUR', unit: 'kg' } })[0], /both currency and unit/);
    assert.match(errs({ type: 'text', display: { decimals: 2 } })[0], /does not apply to a text field/);
    assert.match(errs({ type: 'date', display: { dateStyle: 'tiny' } })[0], /short, medium, long, full/);
    assert.match(errs({ type: 'number', display: { color: 'red' } })[0], /unknown key "color"/);
    assert.match(errs({ type: 'number', display: 'EUR' })[0], /must be an object/);
    assert.deepEqual(errs({ type: 'autonumber', unique: true }), []);
    assert.equal(errs({ type: 'autonumber', unique: false, required: true, default: 1 }).length, 3);
    assert.match(errs({ type: 'json', default: '{x' })[0], /must be JSON text/);
    assert.deepEqual(errs({ type: 'json', default: '[]' }), []);
});

test('canonicalize makes an autonumber unique and not required, and leaves other fields alone', () => {
    const { model } = canonicalizeDataModel(modelOf([{ type: 'autonumber', required: true }, { type: 'text' }]));
    const [auto, text] = model.tables[0].fields;
    assert.deepEqual([auto.unique, auto.required, text.unique, text.required], [true, false, false, false]);
    assert.deepEqual(validateDataModel(model).errors, []);
});

test('the dynamic default currentUser.id fits a user field', () => {
    assert.deepEqual(validateDataModel(modelOf([{ type: 'user', dynamicDefault: 'currentUser.id' }])).errors, []);
    const out = applyFieldRules(tableOf([{ type: 'user', dynamicDefault: 'currentUser.id' }]), {}, { op: 'create', viewerId: 'usr_9' });
    assert.equal(out.f0, 'usr_9');
});

test('write time: a value must have the text format; an empty one passes; the sentence names the label', () => {
    const table = tableOf([{ type: 'text', format: 'email' }, { type: 'text', format: 'url' }, { type: 'text', format: 'phone' }]);
    const ok = { f0: 'a.b@example.org', f1: 'https://example.org/x?y=1', f2: '+31 (0)20-123 4567' };
    assert.equal(applyFieldRules(table, ok, { op: 'create' }), ok, 'the same object back when everything passes');
    assert.doesNotThrow(() => applyFieldRules(table, { f0: '', f1: null }, { op: 'update' }));
    const bad = ['no-at.example.org', 'a@@b.org', 'a b@c.org', 'a@b', 'a@b.c'];
    for (const v of bad) assert.throws(() => applyFieldRules(table, { f0: v }, { op: 'update' }), FieldValidationError, v);
    for (const v of ['ftp://x.org', 'javascript:alert(1)', 'https://', 'www.example.org']) {
        assert.throws(() => applyFieldRules(table, { f1: v }, { op: 'update' }), FieldValidationError, v);
    }
    for (const v of ['12', '06-1234x567', '1+2345678', '123456789012345678901']) {
        assert.throws(() => applyFieldRules(table, { f2: v }, { op: 'update' }), FieldValidationError, v);
    }
    try {
        applyFieldRules(table, { f0: 'secret-value' }, { op: 'create' });
    } catch (e) {
        assert.equal(e.fieldErrors.f0, '"Field 0" must be an e-mail address.');
        assert.ok(!e.message.includes('secret-value'), 'never the value');
    }
});

test('write time: a json field takes JSON text or any value; a validation message still wins', () => {
    const table = tableOf([{ type: 'json' }, { type: 'text', format: 'email', validation: { message: 'Use your work address.' } }]);
    assert.doesNotThrow(() => applyFieldRules(table, { f0: '{"a":1}' }, { op: 'create' }));
    assert.doesNotThrow(() => applyFieldRules(table, { f0: { a: 1 } }, { op: 'create' }));
    assert.throws(() => applyFieldRules(table, { f0: '{a:1}' }, { op: 'create' }), /must be valid JSON/);
    assert.throws(() => applyFieldRules(table, { f1: 'nope' }, { op: 'create' }), /Use your work address\./);
});
