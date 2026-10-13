'use strict';

/**
 * pgliteDb / dbFacade answer the way the hand-written `facadeFor(pg)` copies
 * in the project and stage tests did: node-postgres's `{ rows, rowCount }`
 * (rowCount from affectedRows for a write), `getOne` null for no row, and a
 * client whose release() does nothing.
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const { pgliteDb, dbFacade } = require('./pgliteDb');

const { pg, db } = pgliteDb();
const facade = dbFacade(db);
after(() => pg.close());

test('run, getOne, getAll and getClient share the one session', async () => {
    await pg.exec('CREATE TABLE t (id INT PRIMARY KEY, name TEXT)');
    const ins = await facade.run('INSERT INTO t (id, name) VALUES ($1, $2), ($3, $4)', [1, 'a', 2, 'b']);
    assert.strictEqual(ins.rowCount, 2);
    assert.deepStrictEqual(await facade.getOne('SELECT name FROM t WHERE id = $1', [2]), { name: 'b' });
    assert.strictEqual(await facade.getOne('SELECT name FROM t WHERE id = $1', [9]), null);
    assert.deepStrictEqual(await facade.getAll('SELECT id FROM t ORDER BY id'), [{ id: 1 }, { id: 2 }]);
    const client = await facade.getClient();
    assert.strictEqual(client.release(), undefined);
    const sel = await client.query('SELECT id FROM t');
    assert.strictEqual(sel.rows.length, 2);
    // PGlite reports affectedRows 0 for a read, and the facades took it as is.
    assert.strictEqual(sel.rowCount, 0);
    assert.strictEqual(facade.query, db.query);
});

test('db.tx runs inside one transaction', async () => {
    await assert.rejects(db.tx(async (c) => {
        await c.query('DELETE FROM t');
        throw new Error('roll back');
    }));
    assert.strictEqual((await facade.getAll('SELECT id FROM t')).length, 2);
});
