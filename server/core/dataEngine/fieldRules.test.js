/**
 * Field rules (fieldRules.mts): the save-time shape check and the write-time
 * check + dynamic defaults.
 *
 * Run: cd server && node --test core/dataEngine/fieldRules.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { applyFieldRules, applyFieldRulesToRows, fieldRuleErrors, FieldValidationError } = require('./fieldRules.mts');

const NOW = new Date('2026-11-10T08:30:00.000Z');

function table(...fields) {
    return { key: 't', fields: [{ key: 'title', name: 'Title', type: 'text' }, ...fields] };
}

function refusal(fn) {
    try { fn(); } catch (e) { return e; }
    assert.fail('expected a FieldValidationError');
}

test('a table without rules gets the very same values object back', () => {
    const values = { title: 'x' };
    assert.equal(applyFieldRules(table(), values, { op: 'create' }), values);
    assert.equal(applyFieldRules(table(), values, { op: 'update' }), values);
    const rows = [values];
    assert.equal(applyFieldRulesToRows(table(), rows, { op: 'create' }), rows);
    assert.equal(applyFieldRules(null, values, { op: 'create' }), values);
    assert.equal(applyFieldRules({ key: 't' }, values, { op: 'create' }), values);
});

test('number min/max: in range passes, out of range names the field, a numeric string is read as a number', () => {
    const t = table({ key: 'qty', name: 'Quantity', type: 'number', validation: { min: 1, max: 10 } });
    const values = { qty: '5' };
    assert.equal(applyFieldRules(t, values, { op: 'create' }), values);
    const low = refusal(() => applyFieldRules(t, { qty: 0 }, { op: 'create' }));
    assert.ok(low instanceof FieldValidationError);
    assert.equal(low.status, 422);
    assert.equal(low.code, 'field_invalid');
    assert.deepEqual(low.fieldErrors, { qty: '"Quantity" must be at least 1.' });
    assert.equal(low.message, '"Quantity" must be at least 1.');
    assert.deepEqual(refusal(() => applyFieldRules(t, { qty: 11 }, { op: 'update' })).fieldErrors, { qty: '"Quantity" must be at most 10.' });
    assert.deepEqual(refusal(() => applyFieldRules(t, { qty: 'many' }, { op: 'update' })).fieldErrors, { qty: '"Quantity" must be a number.' });
});

test('empty values pass every rule (required stays its own check)', () => {
    const t = table({ key: 'qty', type: 'number', validation: { min: 1 } }, { key: 'code', type: 'text', validation: { minLength: 3, pattern: '^[A-Z]+$' } });
    for (const empty of [null, undefined, '']) {
        const values = { qty: empty, code: empty };
        assert.equal(applyFieldRules(t, values, { op: 'create' }), values);
    }
});

test('text length counts characters, pattern is case-sensitive, the author message replaces the sentence', () => {
    const t = table({ key: 'code', name: 'Code', type: 'text', validation: { minLength: 2, maxLength: 4, pattern: '^[A-Z]+$' } });
    assert.doesNotThrow(() => applyFieldRules(t, { code: 'ABC' }, { op: 'create' }));
    assert.deepEqual(refusal(() => applyFieldRules(t, { code: 'A' }, { op: 'create' })).fieldErrors, { code: '"Code" must be at least 2 characters.' });
    assert.deepEqual(refusal(() => applyFieldRules(t, { code: 'ABCDE' }, { op: 'create' })).fieldErrors, { code: '"Code" must be at most 4 characters.' });
    assert.deepEqual(refusal(() => applyFieldRules(t, { code: 'abc' }, { op: 'create' })).fieldErrors, { code: '"Code" does not have the expected format.' });
    // Four code points, eight UTF-16 units.
    assert.doesNotThrow(() => applyFieldRules(table({ key: 'e', type: 'text', validation: { maxLength: 4 } }), { e: '😀😀😀😀' }, { op: 'create' }));
    const custom = table({ key: 'code', type: 'text', validation: { pattern: '^[A-Z]{2}$', message: 'Use two capital letters.' } });
    assert.deepEqual(refusal(() => applyFieldRules(custom, { code: 'x' }, { op: 'create' })).fieldErrors, { code: 'Use two capital letters.' });
});

test('enforceOptions: select and multiselect accept only listed values; off by default', () => {
    const options = ['open', { value: 'done', label: 'Done' }];
    const t = table(
        { key: 'status', name: 'Status', type: 'select', options, validation: { enforceOptions: true } },
        { key: 'tags', name: 'Tags', type: 'multiselect', options: ['a', 'b'], validation: { enforceOptions: true } },
        { key: 'loose', type: 'select', options: ['x'] },
    );
    assert.doesNotThrow(() => applyFieldRules(t, { status: 'done', tags: ['a', 'b'], loose: 'anything' }, { op: 'create' }));
    assert.doesNotThrow(() => applyFieldRules(t, { tags: '["a"]' }, { op: 'create' }));
    const e = refusal(() => applyFieldRules(t, { status: 'later', tags: ['a', 'z'] }, { op: 'create' }));
    assert.deepEqual(e.fieldErrors, { status: '"Status" must be one of the listed options.', tags: '"Tags" must be one of the listed options.' });
});

test('update checks only the keys being written (a stored row is never re-checked)', () => {
    const t = table({ key: 'qty', type: 'number', validation: { min: 1 } });
    const values = { title: 'renamed' };
    assert.equal(applyFieldRules(t, values, { op: 'update' }), values);
});

test('dynamic defaults fill on create only, when the value is missing or empty, and never mutate the input', () => {
    const t = table(
        { key: 'stamped_at', type: 'datetime', dynamicDefault: 'now' },
        { key: 'day', type: 'date', dynamicDefault: 'today' },
        { key: 'owner', type: 'text', dynamicDefault: 'currentUser.id' },
    );
    const values = { title: 'x', day: null };
    const out = applyFieldRules(t, values, { op: 'create', viewerId: 'usr_1', now: NOW });
    assert.deepEqual(out, { title: 'x', stamped_at: '2026-11-10T08:30:00.000Z', day: '2026-11-10', owner: 'usr_1' });
    assert.deepEqual(values, { title: 'x', day: null }, 'input untouched');
    // A value the writer sent wins.
    assert.equal(applyFieldRules(t, { day: '2026-01-01' }, { op: 'create', now: NOW }).day, '2026-01-01');
    // No viewer: the key stays absent.
    assert.equal('owner' in applyFieldRules(t, {}, { op: 'create', now: NOW }), false);
    // Update never fills.
    const upd = { title: 'y' };
    assert.equal(applyFieldRules(t, upd, { op: 'update', viewerId: 'usr_1', now: NOW }), upd);
});

test('a batch shares one clock and the first failing row refuses the batch', () => {
    const t = table({ key: 'stamped_at', type: 'datetime', dynamicDefault: 'now' }, { key: 'qty', type: 'number', validation: { max: 3 } });
    const rows = applyFieldRulesToRows(t, [{ qty: 1 }, { qty: 2 }], { op: 'create' });
    assert.equal(rows[0].stamped_at, rows[1].stamped_at);
    assert.throws(() => applyFieldRulesToRows(t, [{ qty: 1 }, { qty: 9 }], { op: 'create' }), FieldValidationError);
});

test('save-time shape: silent without rules, refuses unknown keys, wrong types and inapplicable rules', () => {
    assert.deepEqual(fieldRuleErrors({ key: 'a', type: 'text' }, 'f'), []);
    assert.deepEqual(fieldRuleErrors({ key: 'a', type: 'text', validation: null, dynamicDefault: null }, 'f'), []);
    assert.deepEqual(fieldRuleErrors({ key: 'a', type: 'number', validation: { min: 0, max: 5, message: 'Between 0 and 5.' } }, 'f'), []);
    const messages = (field) => fieldRuleErrors(field, 'f').join(' | ');
    assert.match(messages({ type: 'text', validation: 'yes' }), /f\.validation must be an object/);
    assert.match(messages({ type: 'text', validation: { minLen: 2 } }), /unknown key "minLen"/);
    assert.match(messages({ type: 'text', validation: { min: 1 } }), /validation\.min does not apply to a text field/);
    assert.match(messages({ type: 'number', validation: { min: '1' } }), /validation\.min must be a number/);
    assert.match(messages({ type: 'number', validation: { min: 5, max: 1 } }), /min is larger than max/);
    assert.match(messages({ type: 'text', validation: { minLength: 1.5 } }), /minLength must be a whole number/);
    assert.match(messages({ type: 'text', validation: { minLength: 5, maxLength: 2 } }), /minLength is larger than maxLength/);
    assert.match(messages({ type: 'select', options: [], validation: { enforceOptions: 'yes' } }), /enforceOptions must be true or false/);
    assert.match(messages({ type: 'text', validation: { message: '' } }), /message must be a non-empty text/);
});

test('save-time shape: an unsafe or broken pattern is refused where it is written', () => {
    assert.deepEqual(fieldRuleErrors({ type: 'text', validation: { pattern: '^[0-9]{4} ?[A-Z]{2}$' } }, 'f'), []);
    assert.match(fieldRuleErrors({ type: 'text', validation: { pattern: '(a+)+(?=b)' } }, 'f').join(' '), /pattern is refused/);
    assert.match(fieldRuleErrors({ type: 'text', validation: { pattern: '([a-z' } }, 'f').join(' '), /pattern is refused/);
    assert.match(fieldRuleErrors({ type: 'text', validation: { pattern: 'x'.repeat(501) } }, 'f').join(' '), /longer than 500/);
});

test('save-time shape: dynamicDefault must name a known value on a matching type, and not sit beside default', () => {
    assert.deepEqual(fieldRuleErrors({ type: 'datetime', dynamicDefault: 'now' }, 'f'), []);
    assert.deepEqual(fieldRuleErrors({ type: 'date', dynamicDefault: 'today' }, 'f'), []);
    assert.deepEqual(fieldRuleErrors({ type: 'text', dynamicDefault: 'currentUser.id' }, 'f'), []);
    assert.match(fieldRuleErrors({ type: 'text', dynamicDefault: 'tomorrow' }, 'f').join(' '), /is not one of: now, today, currentUser\.id/);
    assert.match(fieldRuleErrors({ type: 'text', dynamicDefault: 'now' }, 'f').join(' '), /needs a datetime field, not text/);
    assert.match(fieldRuleErrors({ type: 'date', dynamicDefault: 'today', default: '2026-01-01' }, 'f').join(' '), /both default and dynamicDefault/);
});
