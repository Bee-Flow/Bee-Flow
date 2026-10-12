/**
 * The flatten step's validator rules (spec F3-F7) and which of its codes
 * count as "not finished yet" rather than broken.
 *
 * Run: cd server && node --test automation/validate/stepRules/flattenRules.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { validateDefinition } = require('../../validate');
const { COMPLETENESS_CODES } = require('../completenessCodes');
const { FLATTEN_MAIL_STEP } = require('../../../shared/expr/corpus.mjs');

const TRIGGER = { id: 'trg', type: 'trigger', kind: 'manual' };
const READ_MANY = {
    id: 'g_read_many', type: 'integration_action', tool: 'gmail_read_many',
    inputs: { messageIds: { kind: 'literal', value: ['m1'] } },
};

function def(flatten) {
    return {
        trigger: TRIGGER, steps: [READ_MANY, flatten],
        edges: [{ from: 'trg', to: 'g_read_many' }, { from: 'g_read_many', to: flatten.id }],
    };
}
const step = (over = {}) => ({ ...JSON.parse(JSON.stringify(FLATTEN_MAIL_STEP)), ...over });
const all = (r) => [...r.errors, ...r.warnings].map(e => e.code).filter(c => c.startsWith('flatten.'));

test('the J1 stored step validates clean', () => {
    const r = validateDefinition(def(step()));
    assert.deepStrictEqual(all(r), []);
    assert.deepStrictEqual(r.errors.map(e => e.code), []);
});

test('F3: a blank arrayRef is flatten.arrayRef_missing, a completeness code', () => {
    const r = validateDefinition(def(step({ arrayRef: '', parents: undefined })));
    assert.deepStrictEqual(all(r), ['flatten.arrayRef_missing']);
    assert.ok(COMPLETENESS_CODES.has('flatten.arrayRef_missing'));
});

test('F3: a route without [*] is flatten.level_missing, a completeness code', () => {
    const r = validateDefinition(def(step({ arrayRef: 'steps.g_read_many.output.messages', parents: undefined })));
    assert.deepStrictEqual(all(r), ['flatten.level_missing']);
    assert.ok(COMPLETENESS_CODES.has('flatten.level_missing'));
});

test('F4: parents that do not fit the route are flatten.parents_invalid (error)', () => {
    const cases = [
        [],
        [{ ...step().parents[0], overRef: 'steps.g_read_many.output.other' }],
        [{ ...step().parents[0], itemVar: 'item' }],
        [{ ...step().parents[0], itemVar: 'attachment' }],
    ];
    for (const parents of cases) {
        const r = validateDefinition(def(step({ parents })));
        assert.deepStrictEqual(r.errors.map(e => e.code).filter(c => c.startsWith('flatten.')), ['flatten.parents_invalid'], JSON.stringify(parents));
        assert.ok(!COMPLETENESS_CODES.has('flatten.parents_invalid'));
    }
});

test('F5: a malformed field or a repeated `to` is flatten.fields_invalid (error)', () => {
    const p = step().parents[0];
    for (const fields of [[{ from: 'id', to: 'messageId', mode: 'merge' }], [{ from: 'a', to: 'x', mode: 'copy' }, { from: 'b', to: 'x', mode: 'copy' }]]) {
        const r = validateDefinition(def(step({ parents: [{ ...p, fields }] })));
        assert.deepStrictEqual(r.errors.map(e => e.code).filter(c => c.startsWith('flatten.')), ['flatten.fields_invalid']);
    }
});

test('F6: a level without fields is the flatten.columns_unsaved warning, not an error', () => {
    const { fields: _f, ...level } = step().parents[0];
    for (const parents of [[level], undefined]) {
        const r = validateDefinition(def(step({ parents })));
        assert.deepStrictEqual(r.warnings.map(e => e.code).filter(c => c.startsWith('flatten.')), ['flatten.columns_unsaved']);
        assert.deepStrictEqual(r.errors.map(e => e.code).filter(c => c.startsWith('flatten.')), []);
    }
});

test('F7: maxItems follows the shared check', () => {
    const r = validateDefinition(def(step({ maxItems: -5 })));
    assert.ok([...r.errors, ...r.warnings].some(e => /maxItems|max_items/i.test(e.code + e.path)));
});
