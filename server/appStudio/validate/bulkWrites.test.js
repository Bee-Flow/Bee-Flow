/**
 * Bulk writes in the validator and the canonicalizer (package 5): update/delete_record with a
 * filter + limit, writeTo.upsertKey and writeTo.replaceWhere, and backwards compatibility (a
 * definition without them validates and canonicalizes exactly as before).
 *
 * Run: cd server && node --test appStudio/validate/bulkWrites.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateAppDefinition } = require('../validate');
const { canonicalizeAppDefinition } = require('../canonicalize');
const { SECTION_STYLE_DEFAULTS } = require('../componentSpecs');

const codes = (recs, code) => recs.filter((r) => r.code === code);
const OPEN = { default: 'app', roles: {}, rowFilters: {} };
const field = (key, type = 'text') => ({ id: `fld_${key.padEnd(6, '0')}`, key, name: key, type, required: false, unique: false });
const model = {
    modelVersion: 1, roles: [], roleMapping: { default: 'app', byGroup: {} },
    tables: [{ id: 'tbl_ord001', key: 'orders', name: 'Orders', icon: null, access: OPEN, fields: [field('status'), field('po'), field('line', 'number'), field('at', 'datetime')] }],
};

function app(steps) {
    return {
        schemaVersion: 2,
        meta: { name: 'Bulk' },
        theme: {},
        homeScreenId: 'scr_main01',
        screens: [{
            id: 'scr_main01', name: 'Home',
            sections: [{ id: 'sec_main01', style: { ...SECTION_STYLE_DEFAULTS }, children: [
                { id: 'cmp_btn001', type: 'button', props: { label: 'Go' }, onClick: 'act_main01' },
            ] }],
        }],
        actions: { act_main01: { kind: 'sequence', steps } },
    };
}
const validate = (steps) => validateAppDefinition(app(steps), { dataModel: model });
const del = (extra) => ({ kind: 'delete_record', tableId: 'tbl_ord001', ...extra });
const upd = (extra) => ({ kind: 'update_record', tableId: 'tbl_ord001', values: { status: { kind: 'static', value: 'x' } }, ...extra });
const DONE = [{ field: 'status', op: 'eq', value: 'done' }];
const extract = (writeTo) => ({ kind: 'ai_extract', source: { kind: 'formula', expr: 'form.doc' }, schema: [{ name: 'po', type: 'string' }, { name: 'line', type: 'number' }], writeTo: { tableId: 'tbl_ord001', mapping: { po: 'po', line: 'line' }, ...writeTo } });

test('filter mode: a clause list (+ limit) is valid on update and delete', () => {
    const res = validate([del({ filter: DONE, limit: 100 }), upd({ filter: [{ field: 'po', op: 'eq', value: { kind: 'formula', expr: 'vars.po' } }] })]);
    assert.deepEqual(res.errors, []);
});

test('neither recordId nor filter is the old "required" error at .recordId', () => {
    const res = validate([del({})]);
    const req = codes(res.errors, 'action.step_field_required');
    assert.equal(req.length, 1);
    assert.match(req[0].path, /\.recordId$/);
});

test('both, empty, string, too large, unknown field, limit out of range: all refused', () => {
    const many = Array.from({ length: 21 }, () => ({ field: 'status', op: 'eq', value: 'a' }));
    const res = validate([
        del({ recordId: { kind: 'static', value: 'r1' }, filter: DONE }),
        del({ filter: [] }),
        del({ filter: 'status == "done"' }),
        del({ filter: many }),
        del({ filter: [{ field: 'nope', op: 'eq', value: 1 }] }),
        del({ filter: DONE, limit: 501 }),
        del({ recordId: { kind: 'static', value: 'r1' }, limit: 5 }),
        upd({ filter: DONE, expectedUpdatedAt: { kind: 'formula', expr: 'form.updated_at' } }),
    ]);
    assert.equal(codes(res.errors, 'action.record_target_ambiguous').length, 1);
    assert.equal(codes(res.errors, 'action.bulk_filter_empty').length, 1);
    assert.equal(codes(res.errors, 'binding.filter_invalid').length, 1);
    assert.equal(codes(res.errors, 'action.bulk_filter_too_large').length, 1);
    assert.ok(res.errors.some((e) => /nope/.test(e.message)), 'unknown field named');
    assert.ok(res.errors.some((e) => /\.limit$/.test(e.path)), 'limit over the cap');
    assert.equal(codes(res.errors, 'action.step_field_invalid').length, 3, 'limit over the cap, limit without filter, expectedUpdatedAt with filter');
});

test('upsertKey: valid when written; refused when unwritten, duplicated, too long, or next to upsertOn', () => {
    assert.deepEqual(validate([extract({ upsertKey: ['po', 'line'] })]).errors, []);
    const res = validate([
        extract({ upsertKey: ['status'] }),
        extract({ upsertKey: ['po', 'po'] }),
        extract({ upsertKey: ['po', 'line', 'status', 'at', 'po2', 'x'] }),
        extract({ upsertKey: ['po'], upsertOn: 'po' }),
        extract({ upsertKey: [] }),
    ]);
    assert.equal(codes(res.errors, 'action.ai_writeto_invalid').length, 5, JSON.stringify(res.errors.map((e) => e.message)));
});

test('upsertKey: a date constant in the key is a warning', () => {
    const res = validate([extract({ upsertKey: ['po', 'at'], constants: { at: { kind: 'formula', expr: 'now()' } } })]);
    assert.equal(codes(res.warnings, 'action.ai_writeto_key_stamp').length, 1);
});

test('replaceWhere: a clause list is valid; an empty one is refused', () => {
    assert.deepEqual(validate([extract({ replaceWhere: [{ field: 'po', op: 'eq', value: { kind: 'formula', expr: 'vars.po' } }] })]).errors, []);
    const res = validate([extract({ replaceWhere: [] })]);
    assert.equal(codes(res.errors, 'action.bulk_filter_empty').length, 1);
    assert.match(codes(res.errors, 'action.bulk_filter_empty')[0].path, /writeTo\.replaceWhere$/);
});

test('file_intake with upsertKey does not need a base_name mapping', () => {
    const intake = (writeTo) => ({ kind: 'file_intake', threadKey: { kind: 'formula', expr: 'vars.t' }, writeTo: { tableId: 'tbl_ord001', mapping: { po: 'part_key' }, ...writeTo } });
    assert.equal(codes(validate([intake({})]).errors, 'action.file_intake_no_upsert_key').length, 1);
    assert.equal(codes(validate([intake({ upsertKey: ['po'] })]).errors, 'action.file_intake_no_upsert_key').length, 0);
});

test('canonicalize: absent fields stay absent; upsertKey coerced, folded and cut; a records binding unwrapped', () => {
    const plain = app([del({ recordId: { kind: 'static', value: 'r1' } }), extract({ upsertOn: 'po' })]);
    const steps = canonicalizeAppDefinition(plain).def.actions.act_main01.steps;
    assert.deepEqual(Object.keys(steps[0]), ['kind', 'tableId', 'recordId']);
    assert.equal('upsertKey' in steps[1].writeTo, false);
    assert.equal('replaceWhere' in steps[1].writeTo, false);

    const res = canonicalizeAppDefinition(app([
        del({ filter: { kind: 'records', tableId: 'tbl_ord001', filter: DONE } }),
        extract({ upsertKey: 'po', upsertOn: 'po' }),
        extract({ upsertKey: ['po', 'line', 'po', 'a', 'b', 'c', 'd'] }),
    ]));
    const s = res.def.actions.act_main01.steps;
    assert.deepEqual(s[0].filter, DONE);
    assert.deepEqual(s[1].writeTo.upsertKey, ['po']);
    assert.equal('upsertOn' in s[1].writeTo, false, 'upsertOn folded into upsertKey');
    assert.deepEqual(s[2].writeTo.upsertKey, ['po', 'line', 'a', 'b', 'c']);
    assert.ok(JSON.stringify(res.repairs).includes('writeto.upsert_key_coerced'));
    assert.ok(JSON.stringify(res.repairs).includes('writeto.upsert_on_folded'));
});
