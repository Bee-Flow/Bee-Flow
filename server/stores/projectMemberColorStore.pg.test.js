/**
 * project_member_colors against PGlite, through makeProjectMemberColorStore.
 *
 * Run: cd server && node --test stores/projectMemberColorStore.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../testUtils/pgliteDb');
const { makeProjectMemberColorStore, DDL } = require('./projectMemberColorStore');

const { pg, db } = pgliteDb();
const store = makeProjectMemberColorStore(db);

before(async () => {
    await pg.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL)');
    await pg.exec(DDL);
    for (const id of ['p1', 'p2']) await pg.query('INSERT INTO projects (id, name, owner_id) VALUES ($1, $1, $2)', [id, 'owner']);
});
after(async () => { await pg.close(); });

test('the schema can be created again without changes', async () => {
    await pg.exec(DDL);
    assert.strictEqual((await pg.query(`SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_name = 'project_member_colors'`)).rows[0].n, 1);
});

test('a person is given a colour, and changing it replaces it, per project', async () => {
    assert.deepStrictEqual(await store.listColors('p1'), {});
    await store.setColor('p1', 'ann', '#3b82f6');
    await store.setColor('p1', 'ben', '#22c55e');
    await store.setColor('p2', 'ann', '#f43f5e');
    assert.deepStrictEqual(await store.listColors('p1'), { ann: '#3b82f6', ben: '#22c55e' });
    await store.setColor('p1', 'ann', '#8b5cf6');
    assert.deepStrictEqual(await store.listColors('p1'), { ann: '#8b5cf6', ben: '#22c55e' });
    assert.deepStrictEqual(await store.listColors('p2'), { ann: '#f43f5e' }, 'another project is untouched');
});

test('null takes the colour away, and a person who leaves takes theirs with them', async () => {
    assert.strictEqual(await store.setColor('p1', 'ann', null), null);
    assert.deepStrictEqual(await store.listColors('p1'), { ben: '#22c55e' });
    assert.strictEqual(await store.clearFor('p1', 'ben'), 1);
    assert.strictEqual(await store.clearFor('p1', 'ben'), 0);
    assert.deepStrictEqual(await store.listColors('p1'), {});
});

test('deleting the project removes its colours', async () => {
    await store.setColor('p2', 'cy', '#14b8a6');
    await pg.query('DELETE FROM projects WHERE id = $1', ['p2']);
    assert.deepStrictEqual(await store.listColors('p2'), {});
});
