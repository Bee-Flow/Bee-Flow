/**
 * Column rights of lookup, rollup and many-relation fields (columnRightsLinked.mts): the pure
 * rules. The reads are proven on both engines in columnRights.oracle.engines.test.js.
 *
 * Run: cd server && node --test core/dataEngine/columnRightsLinked.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const linked = require('./columnRightsLinked.mts');
const access = require('./accessFilter');

const CHILD = {
    id: 'tbl_kids', key: 'kids', access: { default: 'app' },
    fields: [
        { id: 'fld_k1', key: 'parent', type: 'relation', relation: { table: 'tbl_p' } },
        { id: 'fld_k2', key: 'hours', type: 'number', access: { read: ['admin'] } },
        { id: 'fld_k3', key: 'status', type: 'text' },
    ],
};

test('the names a rollup filter compares, at any depth, the relation of a path included', () => {
    const names = linked.filterNames([{ field: 'a', op: 'eq', value: 1 }, { any: [{ field: 'b.c', op: 'eq', value: 1 }, { not: { field: 'd', otherField: 'e' } }] }]);
    assert.deepEqual([...names].sort(), ['a', 'b', 'd', 'e']);
    assert.deepEqual([...linked.filterNames(undefined)], []);
});

test('a rollup that reads a hidden field of the child table is not computed', () => {
    const hidden = new Set(['hours', 'secret_ref']);
    assert.equal(linked.rollupReadsHidden(hidden, { relation: 'parent' }), false, 'a count of readable rows');
    assert.equal(linked.rollupReadsHidden(hidden, { relation: 'secret_ref' }), true, 'through a hidden relation');
    assert.equal(linked.rollupReadsHidden(hidden, { relation: 'parent', field: 'hours' }), true);
    assert.equal(linked.rollupReadsHidden(hidden, { relation: 'parent', filter: [{ field: 'status', op: 'eq', value: 'x' }] }), false);
    assert.equal(linked.rollupReadsHidden(hidden, { relation: 'parent', filter: [{ field: 'hours', op: 'gt', value: 1 }] }), true);
    assert.equal(linked.rollupReadsHidden(new Set(), { relation: 'parent', field: 'hours' }), false);
});

test('the hidden fields of a related table come from the verdict its access filter carries', () => {
    const forMember = access.compileAccessFilter(CHILD, 'member', { id: 'u1' }, 'read');
    assert.deepEqual([...linked.targetHidden({ tableMeta: CHILD, accessFilter: forMember })], ['hours']);
    assert.deepEqual([...linked.targetHidden({ tableMeta: CHILD, accessFilter: { where: '1=0', params: [] } })], [], 'no row is read');
    assert.throws(() => linked.targetHidden({ tableMeta: CHILD, accessFilter: { where: '1=1', params: [] } }), /did not resolve them/, 'fails closed');
});

test('expanding a relation to a table the role reads no row of still reads the list, also when that table has column rights', () => {
    const qc = require('./queryCompiler');
    const { relationRead } = require('./relationRead.mts');
    const KIDS = { ...CHILD, access: { default: 'none', roles: {} } };
    const MAIN = {
        id: 'tbl_main', key: 'main', access: { default: 'none', roles: { member: { read: 'all' } } },
        fields: [{ id: 'fld_m1', key: 'title', type: 'text' }, { id: 'fld_m2', key: 'kid', type: 'relation', relation: { table: 'tbl_kids' } }],
    };
    const who = { role: 'member', viewer: { id: 'u1', role: 'member' } };
    const read = relationRead({ tables: [KIDS, MAIN] }, MAIN, { expand: [{ field: 'kid', pick: ['status'] }] }, who);
    assert.equal(read.related.kid.accessFilter.where, '1=0');
    const compiled = qc.compileRecordList(MAIN, {}, access.compileAccessFilter(MAIN, 'member', who.viewer, 'read'), read);
    assert.equal(compiled.expand.length, 1, 'the expansion stays in the plan and reads null for every record');
    // A related table the role does read is still refused without its verdict.
    const unresolved = { ...read, related: { kid: { tableMeta: KIDS, accessFilter: { where: '1=1', params: [] } } } };
    assert.throws(() => qc.compileRecordList(MAIN, {}, access.compileAccessFilter(MAIN, 'member', who.viewer, 'read'), unresolved), /did not resolve them/);
});
