// @typecheck
'use strict';

/**
 * deleteGroup against a real Postgres (PGlite behind db.js's pool,
 * testUtils/pglitePool.js). Group ids are caller-supplied, so a reused id would
 * re-grant whatever the old group could see: the delete takes the id out of
 * users, agents and organisation defaults, drops the project shares and the
 * document shares, and a failed share cleanup stops the group delete. A
 * missing project_shares table (a fresh install) does not.
 *
 * Run: cd server && node --test stores/user/groups.deleteShares.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const { initDB } = require('./schema');
const { deleteGroup } = require('./groups');

test.before(async () => {
    await initDB();
    await pg.exec(`
        CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, shared_groups TEXT DEFAULT '[]');
        CREATE TABLE IF NOT EXISTS project_shares (id TEXT PRIMARY KEY, shared_with_type TEXT NOT NULL, shared_with_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS studio_documents (id TEXT PRIMARY KEY, shared_groups JSONB NOT NULL DEFAULT '[]'::jsonb);
    `);
});
test.after(close);

async function group(id) {
    await pg.query('INSERT INTO groups (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [id]);
}
const groupExists = async (id) => (await pg.query('SELECT 1 FROM groups WHERE id = $1', [id])).rows.length === 1;

test('a deleted group leaves no reference behind: users, agents, organisation defaults, project shares', async () => {
    await group('g-del');
    await pg.exec(`
        INSERT INTO users (id, username, groups) VALUES ('u-a', 'u-a', '["g-del","users"]'), ('u-b', 'u-b', '["users","g-del"]'), ('u-c', 'u-c', '["g-del"]');
        INSERT INTO agents (id, shared_groups) VALUES ('ag1', '["x","g-del","y"]');
        INSERT INTO organizations (id, name, "defaultGroups") VALUES ('org-del', 'O', '["g-del"]');
        INSERT INTO project_shares (id, shared_with_type, shared_with_id) VALUES
            ('ps1', 'group', 'g-del'), ('ps2', 'user', 'g-del'), ('ps3', 'group', 'other');
        INSERT INTO studio_documents (id, shared_groups) VALUES ('doc1', '["g-del","keep"]');
    `);
    assert.strictEqual(await deleteGroup('g-del'), true);
    const users = (await pg.query("SELECT id, groups FROM users WHERE id LIKE 'u-%' ORDER BY id")).rows;
    assert.deepStrictEqual(users.map((u) => JSON.parse(u.groups)), [['users'], ['users'], []]);
    assert.deepStrictEqual(JSON.parse((await pg.query("SELECT shared_groups FROM agents WHERE id = 'ag1'")).rows[0].shared_groups), ['x', 'y']);
    assert.deepStrictEqual(JSON.parse((await pg.query(`SELECT "defaultGroups" FROM organizations WHERE id = 'org-del'`)).rows[0].defaultGroups), []);
    assert.deepStrictEqual((await pg.query('SELECT id FROM project_shares ORDER BY id')).rows.map((r) => r.id), ['ps2', 'ps3'],
        'only the group shares of this group go');
    assert.deepStrictEqual((await pg.query("SELECT shared_groups FROM studio_documents WHERE id = 'doc1'")).rows[0].shared_groups, ['keep']);
    assert.strictEqual(await groupExists('g-del'), false);
});

test('a failed project-share cleanup stops the group delete (a reused id would re-grant)', async () => {
    await group('g1');
    await pg.exec(`
        CREATE FUNCTION refuse_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'connection reset'; END $$ LANGUAGE plpgsql;
        CREATE TRIGGER refuse_delete BEFORE DELETE ON project_shares FOR EACH ROW EXECUTE FUNCTION refuse_delete();
        INSERT INTO project_shares (id, shared_with_type, shared_with_id) VALUES ('ps-g1', 'group', 'g1');
    `);
    try {
        await assert.rejects(deleteGroup('g1'), /connection reset/);
        assert.strictEqual(await groupExists('g1'), true, 'the group row is not deleted');
    } finally {
        await pg.exec('DROP TRIGGER refuse_delete ON project_shares; DROP FUNCTION refuse_delete()');
    }
});

test('a missing project_shares table does not block the delete', async () => {
    await group('g2');
    await pg.exec('DROP TABLE project_shares');
    assert.strictEqual(await deleteGroup('g2'), true);
    assert.strictEqual(await groupExists('g2'), false);
});
