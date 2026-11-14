// @typecheck
'use strict';

/**
 * Characterisation (golden) test for describeActionRefusal: the whole answer
 * (_fixHint and _suggestedPatch) for validator records of every code it
 * explains (unknown table with and without a did-you-mean or a known
 * neighbour, unknown fields on a step or a binding, invalid bindings with and
 * without a usable name, unknown action and step fields, a missing required
 * field, navigate without or to an unknown screen, invalid approval stages
 * and hooks) and for records it does not know, alone and mixed, with
 * repeated reasons, junk entries and every tables shape.
 *
 * Regenerate the golden file ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --test appStudio/builderTools/actionRefusal.characterisation.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { describeActionRefusal } = require('./actionNormalise');

const GOLDEN = path.join(__dirname, 'actionRefusal.characterisation.golden.json');

const TABLES = [
    { id: 'tbl_ab12cd', key: 'suppliers', name: 'Suppliers', fields: [{ key: 'name' }, { key: 'email' }] },
    { id: 'tbl_ef34gh', key: 'invoices', name: 'Invoices', fields: [{ key: 'amount' }, { key: 'due_date' }] },
    { id: 'tbl_nofields', key: 'bare', name: 'Bare' },
];
const ACTION = {
    kind: 'create_record', tableId: 'tbl_ef34gh',
    values: { category: { kind: 'field', name: 'category' }, bad: { kind: 'field', name: '9bad' }, plain: 'x' },
    steps: [{ kind: 'create_record', tableId: 'tbl_suppliers_01', values: { v: { name: 'n1' } } }],
};
const unknownTable = (/** @type {Record<string, unknown>} */ o = {}) => ({ code: 'step.unknown_table', path: 'actions.act_1.tableId', message: 'Action "act_1" (create_record) references table "tbl_suppliers_01" which does not exist.', ...o });

/** @type {Record<string, [unknown, Record<string, unknown>?]>} */
const CASES = {
    notAList: ['nope'],
    emptyList: [[]],
    junkEntries: [[null, 0, '', { code: 'x.y' }]],
    unknownTableZero: [[unknownTable()], { tables: [] }],
    unknownTableHintDym: [[unknownTable({ hint: 'Did you mean "tbl_ab12cd"?' })]],
    unknownTableSuggest: [[unknownTable({ message: 'references table "tbl_supplier" which does not exist', code: 'action.unknown_table' })]],
    unknownTableNoMessage: [[unknownTable({ message: undefined, path: 'actions.act_1.steps[0].tableId', code: 'binding.unknown_table' })]],
    unknownTableNothingClose: [[unknownTable({ message: 'references table "tbl_zzzzzz" which does not exist' })]],
    unknownFieldValues: [[{ code: 'step.unknown_field', path: 'actions.act_1.values.emial', message: 'references field "emial" which is not on table "tbl_ab12cd".', hint: 'Did you mean "email"?' }]],
    unknownFieldByKey: [[{ code: 'binding.unknown_field', path: 'actions.act_1.values.x', message: 'references field "x" which is not on table "invoices".' }]],
    unknownFieldNotValues: [[{ code: 'step.unknown_field', path: 'actions.act_1.recordId', message: 'references field "x" which is not on table "tbl_ab12cd".', hint: 'Did you mean "email"?' }]],
    unknownFieldNoFieldsTable: [[{ code: 'step.unknown_field', path: 'actions.act_1.values.x', message: 'references field "x" which is not on table "tbl_nofields".' }]],
    unknownFieldNoMatch: [[{ code: 'step.unknown_field', path: 'actions.act_1.values.x', message: 'something else' }]],
    actionUnknownFieldPrefix: [[{ code: 'action.step_unknown_field.extra', path: 'actions.act_1.x' }]],
    bindingKindInvalid: [[{ code: 'binding.kind_invalid', path: 'actions.act_1.values.category.kind', message: 'Unknown binding kind "field".' }]],
    bindingKindInvalidBadName: [[{ code: 'binding.kind_invalid', path: 'actions.act_1.values.bad.kind' }]],
    bindingInvalidString: [[{ code: 'binding.invalid', path: 'actions.act_1.values.plain' }]],
    bindingInvalidNested: [[{ code: 'binding.invalid', path: 'actions.act_1.steps[0].values.v' }]],
    bindingInvalidMissing: [[{ code: 'binding.invalid', path: 'actions.act_1.values.none' }]],
    actionUnknownField: [[{ code: 'action.unknown_field', path: 'actions.act_1', message: 'Action "act_1" has unknown fields for kind "create_record": inputMapping, onSuccess.', hint: 'Legal fields: tableId, values.' }]],
    stepUnknownField: [[{ code: 'action.step_unknown_field', path: 'actions.act_1.steps[0].foo', message: 'Step 0 has an unknown field "foo".', hint: 'Remove it.' }]],
    unknownFieldNoMessage: [[{ code: 'action.unknown_field', path: 'actions.act_1' }]],
    requiredValues: [[{ code: 'action.step_field_required', path: 'actions.act_1', message: 'Step is missing required `values`.' }]],
    requiredValuesNoTable: [[{ code: 'action.step_field_required', path: 'actions.act_1', message: 'Step is missing required `values`.' }], { action: { tableId: 'tbl_gone' } }],
    requiredValuesBareTable: [[{ code: 'action.step_field_required', path: 'actions.act_1', message: 'missing required `values`' }], { action: { tableId: 'tbl_nofields' } }],
    requiredOther: [[{ code: 'action.step_field_required', path: 'actions.act_1.steps[1]', message: 'Step is missing required `tableId`.' }]],
    requiredNoMessage: [[{ code: 'action.step_field_required', path: 'actions.act_1' }]],
    navigateMissing: [[{ code: 'action.navigate_missing', path: 'actions.act_1.screenId' }]],
    navigateMissingNoSuffix: [[{ code: 'action.navigate_missing', path: 'actions.act_1.steps[2]' }]],
    approvalStages: [[{ code: 'action.approval_stages_invalid', path: 'actions.act_1.stages', message: 'A stage needs approvers.' }]],
    approvalStagesNoMessage: [[{ code: 'action.approval_stages_invalid', path: 'actions.act_1.stages' }]],
    approvalHook: [[{ code: 'action.approval_hook_invalid', path: 'actions.act_1.onDecided', message: 'onDecided.set must map outcomes.' }]],
    navigateUnresolved: [[{ code: 'action.navigate_unresolved', path: 'actions.act_1.screenId', hint: 'Did you mean "scr_home"?' }]],
    stepNavigateUnresolved: [[{ code: 'action.step_navigate_unresolved', path: 'actions.act_1.steps[0].screenId' }]],
    effectsNavigateUnresolved: [[{ code: 'action.effects_navigate_unresolved', path: 'actions.act_1.onSuccess.navigate.screenId', hint: 'Did you mean "scr_list"?' }]],
    unknownCode: [[{ code: 'action.toast_message_missing', path: 'actions.act_1.message', message: 'x' }]],
    otherAction: [[{ code: 'binding.kind_invalid', path: 'actions.act_2.values.category.kind' }]],
    noActionId: [[{ code: 'binding.kind_invalid', path: 'actions.act_1.values.category.kind' }], { actionId: undefined }],
    repeatedReasons: [[
        { code: 'action.navigate_missing', path: 'actions.act_1.screenId' }, { code: 'action.navigate_missing', path: 'actions.act_1.screenId' },
        { code: 'action.toast_message_missing', path: 'actions.act_1.message' },
    ]],
    mixed: [[
        unknownTable({ hint: 'Did you mean "tbl_ab12cd"?' }),
        { code: 'step.unknown_field', path: 'actions.act_1.values.emial', message: 'references field "emial" which is not on table "tbl_ab12cd".', hint: 'Did you mean "email"?' },
        { code: 'binding.kind_invalid', path: 'actions.act_1.values.category.kind' },
        { code: 'action.navigate_unresolved', path: 'actions.act_1.screenId', hint: 'Did you mean "scr_home"?' },
        { code: 'action.unknown_field', path: 'actions.act_1', message: 'Action has unknown fields for kind "x": a, b.' },
        { code: 'unknown.thing', path: 'x' },
    ]],
    tablesNotList: [[unknownTable()], { tables: 'tbl_ab12cd' }],
    tablesWithJunk: [[unknownTable({ message: 'references table "tbl_supplier" which' }), { code: 'step.unknown_field', path: 'actions.act_1.values.q', message: 'field "q" which is not on table "bare"' }], { tables: [null, ...TABLES] }],
    noOpts: [[unknownTable()], undefined],
};

test('describeActionRefusal: every case matches the golden result', () => {
    /** @type {Record<string, unknown>} */
    const actual = {};
    for (const [name, [errors, over]] of Object.entries(CASES)) {
        const opts = name === 'noOpts' ? undefined : { actionId: 'act_1', action: ACTION, tables: TABLES, ...over };
        actual[name] = describeActionRefusal(/** @type {any} */ (errors), /** @type {any} */ (opts));
    }
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n');
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    assert.deepEqual(Object.keys(actual), Object.keys(golden));
    for (const name of Object.keys(actual)) assert.deepEqual(actual[name], golden[name], name);
});
