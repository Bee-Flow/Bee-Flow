/**
 * project-org-backfill-2026-09 against PGlite, with the owner's organisation
 * injected (the real resolver is orgScope, tested on its own).
 *
 * Pinned: an org-less project gets its owner's organisation; a project that
 * has one is never touched; an owner without an organisation leaves the
 * project org-less; a second run is a no-op.
 *
 * Run: cd server && node --test migrations/project-org-backfill-2026-09.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../testUtils/pgliteDb');
const { up } = require('./project-org-backfill-2026-09');

const { pg, db } = pgliteDb();
const facade = {
    getAll: async (sql, params) => (await db.query(sql, params)).rows,
    run: (sql, params) => db.query(sql, params),
};
const ORGS = { tom: 'bee-flow2', ann: 'org-a', solo: null };
const resolveOrg = async (ownerId) => ORGS[ownerId] ?? null;

before(async () => {
    await pg.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, organization_id TEXT DEFAULT '')`);
    await pg.exec(`INSERT INTO projects (id, owner_id, organization_id) VALUES
        ('today', 'tom', ''), ('nulled', 'tom', NULL), ('kept', 'ann', 'org-b'), ('mine', 'solo', ''),
        ('sealed', 'tom', ''), ('sealed-conv', 'tom', '')`);
    // What is written under the project key so far: stamping an organisation would re-key it.
    await pg.exec(`CREATE TABLE project_chats (id TEXT PRIMARY KEY, project_id TEXT)`);
    await pg.exec(`INSERT INTO project_chats (id, project_id) VALUES ('c1', 'sealed')`);
    await pg.exec(`CREATE TABLE direct_conversations (id TEXT PRIMARY KEY, project_id TEXT, crypto_scope TEXT)`);
    await pg.exec(`INSERT INTO direct_conversations (id, project_id, crypto_scope) VALUES
        ('d1', 'sealed-conv', 'project'), ('d2', 'today', 'owner')`);
});
after(async () => { await pg.close(); });

const orgOf = async (id) => (await db.query('SELECT organization_id FROM projects WHERE id = $1', [id])).rows[0].organization_id;

test('org-less projects get their owner organisation; others are left alone', async () => {
    assert.strictEqual(await up({ db: facade, resolveOrg, initSchema: async () => {} }), 2);
    assert.strictEqual(await orgOf('today'), 'bee-flow2');
    assert.strictEqual(await orgOf('nulled'), 'bee-flow2');
    assert.strictEqual(await orgOf('kept'), 'org-b', 'a stored organisation is never replaced');
    assert.strictEqual(await orgOf('mine'), '', 'an owner without an organisation keeps the project org-less');
});

test('a project that already holds sealed content keeps its key: it is not stamped', async () => {
    assert.strictEqual(await orgOf('sealed'), '', 'a team chat is sealed under the project key');
    assert.strictEqual(await orgOf('sealed-conv'), '', 'so is a conversation shared into the project');
    assert.strictEqual(await orgOf('today'), 'bee-flow2', 'a conversation kept by its owner does not block it');
});

test('a second run changes nothing', async () => {
    assert.strictEqual(await up({ db: facade, resolveOrg, initSchema: async () => {} }), 0);
});
