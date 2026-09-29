/**
 * `relation.fk === false` — a relation column WITHOUT a foreign key.
 *
 * A mirror of an external table (core/dataEngine/sources/nextcloudTable) keeps
 * relation columns Postgres must not enforce. This pins that the opt-out is
 * honoured on BOTH the CREATE TABLE and the ADD COLUMN path, and that a
 * relation without the flag still gets its FK exactly as before.
 */
const test = require('node:test');
const assert = require('node:assert');
const { ddlForTable, addColumnDdl } = require('./ddl');

const keyById = new Map([['tbl_parent', 'suppliers'], ['tbl_child', 'invoices']]);
const child = (relation) => ({
    id: 'tbl_child', key: 'invoices',
    fields: [{ id: 'fld_ref', key: 'suppliers_ref', type: 'relation', relation }],
});

test('a relation still references its target by default', () => {
    const sql = ddlForTable(child({ table: 'tbl_parent' }), { tableKeyById: keyById, dialect: 'pg' });
    assert.match(sql, /"suppliers_ref" TEXT REFERENCES "suppliers"\(id\)/);
    const add = addColumnDdl('invoices', 'tbl_child',
        { id: 'fld_ref', key: 'suppliers_ref', type: 'relation', relation: { table: 'tbl_parent' } }, keyById, 'pg');
    assert.match(add[0], /REFERENCES "suppliers"\(id\)/);
});

test('fk:false keeps the column and drops the foreign key on both paths', () => {
    const sql = ddlForTable(child({ table: 'tbl_parent', fk: false }), { tableKeyById: keyById, dialect: 'pg' });
    assert.match(sql, /"suppliers_ref" TEXT/);
    assert.doesNotMatch(sql, /REFERENCES/);
    const add = addColumnDdl('invoices', 'tbl_child',
        { id: 'fld_ref', key: 'suppliers_ref', type: 'relation', relation: { table: 'tbl_parent', fk: false } }, keyById, 'pg');
    assert.match(add[0], /ADD COLUMN IF NOT EXISTS "suppliers_ref" TEXT$/);
    assert.doesNotMatch(add[0], /REFERENCES/);
});
