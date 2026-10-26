// @typecheck strict
'use strict';

/**
 * usePglitePool answers db.js's pool the way node-postgres does — the shape
 * the inline db.js facades it replaced in the datatable and store tests
 * answered with (rows, fields, rowCount, command), and the shape
 * stores/lib/pgAppEngine reads.
 */

const { test, after } = require('node:test');
const assert = require('node:assert');

const db = require('../db');
const realQuery = db.pool.query;
const { usePglitePool } = require('./pglitePool');

const { query, restore, close } = usePglitePool();
after(close);

test('a schema string of several statements runs through the simple protocol', async () => {
    const res = await query('CREATE TABLE t (id INT PRIMARY KEY, name TEXT); CREATE INDEX t_name ON t (name)');
    assert.strictEqual(res.command, 'CREATE');
    assert.deepStrictEqual(res.rows, []);
    assert.strictEqual(res.rowCount, 0);
});

test('a write answers its affected rows and names its command', async () => {
    const res = await query('INSERT INTO t (id, name) VALUES ($1, $2), ($3, $4)', [1, 'a', 2, 'b']);
    assert.strictEqual(res.command, 'INSERT');
    assert.strictEqual(res.rowCount, 2);
    assert.deepStrictEqual(res.fields, []);
});

test('a read is a SELECT with its fields, and rowCount is the row count', async () => {
    const res = await query('SELECT id, name FROM t ORDER BY id');
    assert.strictEqual(res.command, 'SELECT');
    assert.strictEqual(res.rowCount, 2);
    assert.deepStrictEqual(res.fields.map((/** @type {{ name: string }} */ f) => f.name), ['id', 'name']);
    assert.deepStrictEqual(res.rows, [{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
    const ret = await query('UPDATE t SET name = $1 WHERE id = $2 RETURNING id', ['c', 1]);
    assert.strictEqual(ret.command, 'SELECT', 'RETURNING has result columns, as the facades counted it');
    assert.strictEqual(ret.rowCount, 1);
});

test('db.js itself goes through the pool: run, getOne, getAll, exec and withTransaction', async () => {
    assert.strictEqual((await db.run('DELETE FROM t WHERE id = $1', [2])).rowCount, 1);
    assert.deepStrictEqual(await db.getOne('SELECT name FROM t WHERE id = $1', [1]), { name: 'c' });
    assert.deepStrictEqual(await db.getAll('SELECT id FROM t'), [{ id: 1 }]);
    await db.exec('CREATE TABLE u (id INT)');
    await assert.rejects(db.withTransaction(async (c) => {
        await c.query('INSERT INTO u (id) VALUES ($1)', [7]);
        throw new Error('roll back');
    }), /roll back/);
    assert.deepStrictEqual(await db.getAll('SELECT id FROM u'), [], 'the rollback reached PGlite');
    await db.withTransaction((c) => c.query('INSERT INTO u (id) VALUES ($1)', [8]));
    assert.deepStrictEqual(await db.getAll('SELECT id FROM u'), [{ id: 8 }]);
});

test('restore hands the pool its own query back', () => {
    restore();
    assert.strictEqual(db.pool.query, realQuery);
});
