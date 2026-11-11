/**
 * Column rights (columnRights.mts): who reads and writes a field, what the save-time checks
 * refuse, and that a table without `field.access` is not touched anywhere.
 *
 * The reads are proven on real engines in columnRights.oracle.engines.test.js, the doors in
 * appStudio/columnRights.doors.test.js.
 *
 * Run: cd server && node --test core/dataEngine/columnRights.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const rights = require('./columnRights.mts');
const save = require('./columnRightsSave.mts');
const access = require('./accessFilter');
const qc = require('./queryCompiler');
const { applyFieldRules, applyFieldRulesToRows } = require('./fieldRules.mts');

const field = (key, extra = {}) => ({ id: `fld_${key}00`, key, name: key, type: 'text', ...extra });
const table = (fields, extra = {}) => ({ id: 'tbl_things', key: 'things', fields, access: { default: 'app' }, ...extra });

const THINGS = table([
    field('open'),
    field('for_admin', { access: { read: ['admin'] } }),
    field('nobody', { access: { read: [] } }),
    field('admin_writes', { access: { write: ['admin'] } }),
    field('blind', { access: { read: ['admin'], write: ['admin', 'member'] } }),
    field('for_public', { access: { read: ['public', 'member'] } }),
    field('doubled', { type: 'computed', computed: { expr: 'for_admin || open', stored: true } }),
    field('twice', { type: 'computed', computed: { expr: 'upper("doubled")' } }),
    field('plain_calc', { type: 'computed', computed: { expr: 'upper(open)' } }),
    field('odd_calc', { type: 'computed', computed: { expr: 'open::text', stored: true } }),
]);

test('read: the owner reads everything, a list names who else, and public is named or left out', () => {
    const hidden = (role) => [...rights.hiddenFields(THINGS, role)].sort();
    assert.deepEqual(hidden('owner'), []);
    assert.deepEqual(hidden('admin'), ['for_public', 'nobody', 'odd_calc'], 'a list is the whole list: admin is not in for_public');
    assert.deepEqual(hidden('member'), ['blind', 'doubled', 'for_admin', 'nobody', 'odd_calc', 'twice']);
    assert.deepEqual(hidden('public'), ['blind', 'doubled', 'for_admin', 'nobody', 'odd_calc', 'twice']);
    assert.deepEqual(hidden('stranger'), ['blind', 'doubled', 'for_admin', 'for_public', 'nobody', 'odd_calc', 'twice']);
    assert.deepEqual(hidden(null), hidden('stranger'), 'no role is in no list');
    // The one question another read feature asks.
    assert.equal(access.canReadField(THINGS, 'member', 'open'), true);
    assert.equal(access.canReadField(THINGS, 'member', 'for_admin'), false);
    assert.equal(access.canReadField(THINGS, 'member', 'twice'), false, 'computed over computed over a hidden field');
    assert.equal(access.canReadField(THINGS, 'member', 'plain_calc'), true);
    assert.equal(access.canReadField(THINGS, 'member', 'created_by'), true, 'a system column');
    assert.equal(access.canReadField(THINGS, 'owner', 'no_such_field'), false);
    assert.equal(access.canReadField(THINGS, 'admin', 'for_admin'), true);
});

test('write: a list names who, and without one it follows read', () => {
    const can = (role, key) => access.canWriteField(THINGS, role, key);
    assert.deepEqual(['open', 'for_admin', 'nobody', 'admin_writes', 'blind'].map((k) => can('owner', k)), [true, true, true, true, true]);
    assert.deepEqual(['open', 'for_admin', 'nobody', 'admin_writes', 'blind'].map((k) => can('admin', k)), [true, true, false, true, true]);
    assert.deepEqual(['open', 'for_admin', 'nobody', 'admin_writes', 'blind'].map((k) => can('member', k)), [true, false, false, false, true]);
    assert.equal(can('public', 'for_public'), true);
    assert.equal(can('public', 'blind'), false);
    assert.equal(can('member', 'no_such_field'), false);
});

test('writableValues: refuses by label, never echoes the value, and leaves an empty value out of a create', () => {
    const write = (role, values, op = 'update') => rights.writableValues(THINGS, role, values, op);
    const same = { open: 'a', blind: 'b' };
    assert.equal(write('member', same), same, 'the same object when everything may be written');
    assert.throws(() => write('member', { open: 'a', for_admin: 'zebra-17', nobody: 1 }), (e) => e instanceof access.AccessError
        && e.status === 403 && e.code === 'field_not_writable' && e.fields.join() === 'for_admin,nobody' && !e.message.includes('zebra'));
    assert.throws(() => write('member', { for_admin: null }), /permission to change "for_admin"/);
    assert.deepEqual(write('member', { open: 'a', for_admin: null, nobody: '', admin_writes: [] }, 'create'), { open: 'a' });
    assert.throws(() => write('member', { for_admin: 0 }, 'create'), /for_admin/, 'zero is a value');
    assert.throws(() => write(undefined, { for_admin: 'x' }), /for_admin/, 'a writer without a role');
    const owned = { nobody: 'x' };
    assert.equal(write('owner', owned), owned);
    // Computed, system and unknown keys are the compiler's to judge.
    assert.deepEqual(write('member', { doubled: 'x', id: 'y', no_such: 1, open: 'a' }), { doubled: 'x', id: 'y', no_such: 1, open: 'a' });
});

test('applyFieldRules gates the write first, for one row and for many', () => {
    assert.throws(() => applyFieldRules(THINGS, { for_admin: 'x' }, { op: 'update', role: 'member' }), (e) => e.code === 'field_not_writable');
    assert.throws(() => applyFieldRules(THINGS, { for_admin: 'x' }, { op: 'update' }), (e) => e.code === 'field_not_writable', 'no role given');
    assert.throws(() => applyFieldRulesToRows(THINGS, [{ open: 'a' }, { nobody: 'x' }], { op: 'create', role: 'admin' }), (e) => e.code === 'field_not_writable');
    assert.deepEqual(applyFieldRulesToRows(THINGS, [{ open: 'a', nobody: null }], { op: 'create', role: 'admin' }), [{ open: 'a' }]);
});

test('a table without column rights is the table it was: same objects, same SQL, no verdict', () => {
    const plain = table([field('open'), field('other')]);
    assert.equal(rights.hasColumnRights(plain), false);
    assert.equal(rights.columnRightsFor(plain, 'member'), null);
    const filter = access.compileAccessFilter(plain, 'member', { id: 'u1' }, 'read');
    assert.deepEqual(filter, { where: '1=1', params: [] });
    assert.equal(rights.scopeColumns(plain, filter).tableMeta, plain);
    assert.equal(rights.scopeColumns(plain, { where: '1=1', params: [] }).hidden, null);
    const values = { open: 'a' };
    assert.equal(rights.writableValues(plain, null, values, 'update'), values);
    assert.equal(applyFieldRules(plain, values, { op: 'update' }), values);
    const rows = [values];
    assert.equal(applyFieldRulesToRows(plain, rows, { op: 'create' }), rows);
    assert.match(qc.compileRecordList(plain, {}, filter).sql, /^SELECT \* FROM "things"/);
    assert.equal(access.canReadField(plain, 'anyone', 'open'), true);
});

test('with column rights: a role that reads everything keeps `*`, a restricted role gets its columns by name', () => {
    const forOwner = access.compileAccessFilter(THINGS, 'owner', { id: 'u1' }, 'read');
    assert.deepEqual([forOwner.columns.hidden, forOwner.columns.readOnly], [[], []]);
    assert.match(qc.compileRecordList(THINGS, {}, forOwner).sql, /^SELECT \* FROM "things"/);
    const forMember = access.compileAccessFilter(THINGS, 'member', { id: 'u1' }, 'read');
    assert.deepEqual([...forMember.columns.readOnly].sort(), ['admin_writes', 'for_admin', 'nobody']);
    const { sql } = qc.compileRecordList(THINGS, { readTimeComputed: true }, forMember);
    assert.match(sql, /^SELECT "id", "created_at", "updated_at", "created_by", "org_id", "open", "admin_writes", "for_public", \(upper \( "open" \)\) AS "plain_calc" FROM "things"/);
    assert.match(qc.compileGetById(THINGS, 'r1', forMember).sql, /^SELECT "id", "created_at", "updated_at", "created_by", "org_id", "open", "admin_writes", "for_public" FROM/);
});

test('save: the shape of access, per field', () => {
    const errorsOf = (accessValue, extra = {}) => save.fieldAccessErrors(field('f', { access: accessValue, ...extra }), 'f');
    assert.deepEqual(save.fieldAccessErrors(field('f'), 'f'), []);
    assert.deepEqual(errorsOf({ read: ['admin'], write: [] }), []);
    assert.deepEqual(errorsOf({ read: ['public'] }), []);
    assert.match(errorsOf('admin')[0], /must be an object/);
    assert.match(errorsOf({})[0], /needs read or write/);
    assert.match(errorsOf({ read: 'admin' })[0], /must be a list of role keys/);
    assert.match(errorsOf({ read: ['Admin!'] })[0], /not a role key/);
    assert.match(errorsOf({ read: ['admin', 'admin'] })[0], /twice/);
    assert.match(errorsOf({ read: ['owner'] })[0], /owner always has every field/);
    assert.match(errorsOf({ read: ['a'], roles: ['b'] })[0], /unknown keys: roles/);
    assert.match(errorsOf({ write: ['a'] }, { type: 'computed' })[0], /never written/);
    assert.match(errorsOf({ read: Array.from({ length: 51 }, (_, i) => `r${i}`) })[0], /more than 50 roles/);
});

test('save: what the table as a whole may not combine with column rights', () => {
    const findings = (t, roles) => save.tableColumnRightsFindings(t, 'tables[0]', roles);
    assert.deepEqual(findings(table([field('open')]), [{ key: 'admin' }]), { errors: [], warnings: [] });
    const linked = table([field('a', { access: { read: ['admin'] } })], { source: { kind: 'datatable', datatableId: 'tbl_abcd', mode: 'read' } });
    assert.match(findings(linked, null).errors[0], /linked Studio table: column rights .* are not available/);
    const blindUnique = table([field('code', { unique: true, access: { read: ['admin'], write: ['admin', 'member'] } })]);
    assert.match(findings(blindUnique, null).errors[0], /field "code" is unique, and "member" may write it without reading it/);
    const fineUnique = table([field('code', { unique: true, access: { read: ['admin'] } })]);
    assert.deepEqual(findings(fineUnique, [{ key: 'admin' }]), { errors: [], warnings: [] });
    const unknownRole = table([field('a', { access: { read: ['admin', 'ghost', 'public'] } })]);
    assert.deepEqual(findings(unknownRole, [{ key: 'admin' }]).warnings, ['tables[0] field "a" names the role "ghost", which this app does not have']);
    assert.deepEqual(findings(unknownRole, undefined).warnings, [], 'a model without a roles list is not asked');
});

test('lookup, rollup and many fields: hidden through their relation, never written, and no read list on a delete rule', () => {
    const LINKED = table([
        field('owner_ref', { type: 'relation', relation: { table: 'tbl_people' }, access: { read: ['admin'] } }),
        field('open_ref', { type: 'relation', relation: { table: 'tbl_people' } }),
        field('owner_name', { type: 'lookup', lookup: { relation: 'owner_ref', field: 'name' } }),
        field('open_name', { type: 'lookup', lookup: { relation: 'open_ref', field: 'name' } }),
        field('shout', { type: 'computed', computed: { expr: 'upper(owner_name)' } }),
        field('tags', { type: 'relation', relation: { table: 'tbl_tags', many: true }, access: { read: ['admin'] } }),
        field('total', { type: 'rollup', rollup: { table: 'tbl_kids', relation: 'parent', fn: 'count' } }),
    ]);
    assert.deepEqual([...rights.hiddenFields(LINKED, 'member')].sort(), ['owner_name', 'owner_ref', 'shout', 'tags'], 'a lookup through a hidden relation, and what reads it, follow');
    assert.deepEqual([...rights.hiddenFields(LINKED, 'admin')], []);
    // A lookup or rollup is never written: the compiler refuses a value for it by its own rule.
    assert.deepEqual(rights.writableValues(LINKED, 'member', { open_name: 'x', total: 1 }, 'update'), { open_name: 'x', total: 1 });
    assert.throws(() => rights.writableValues(LINKED, 'member', { tags: ['t1'] }, 'update'), (e) => e.code === 'field_not_writable');
    assert.deepEqual(rights.writableValues(LINKED, 'member', { tags: [] }, 'create'), {}, 'an empty list on a create is left out');
    for (const type of ['lookup', 'rollup']) assert.match(save.fieldAccessErrors(field('f', { type, access: { write: ['a'] } }), 'f')[0], /never written/);
    // A delete rule on a relation some roles may not read would tell them, by its refusals and changes, which records point where.
    const ruled = (accessValue) => save.tableColumnRightsFindings(table([field('parent', { type: 'relation', relation: { table: 'tbl_p', onDelete: 'setNull' }, access: accessValue })]), 'tables[0]', null).errors;
    assert.match(ruled({ read: ['admin'] })[0], /field "parent" follows a delete rule \(onDelete\), and only some roles may read it/);
    assert.deepEqual(ruled({ write: ['admin'] }), [], 'a write list alone is fine: the walk refuses a setNull the role may not write');
});
