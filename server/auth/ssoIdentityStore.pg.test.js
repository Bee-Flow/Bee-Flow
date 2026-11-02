// @typecheck
'use strict';
/**
 * sso_identities against a real Postgres (PGlite): one owner per (provider,
 * subject), a subject is never moved, rows go with the account.
 * Run: cd server && node --test auth/ssoIdentityStore.pg.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../testUtils/pgliteDb');
const { makeSsoIdentityStore, SSO_IDENTITY_DDL } = require('./ssoIdentityStore.mts');

const { pg, db } = pgliteDb();
const store = makeSsoIdentityStore(db);

before(async () => {
    await pg.exec(`CREATE TABLE users (
        id TEXT PRIMARY KEY, email TEXT, role TEXT DEFAULT 'user', "passwordHash" TEXT, "opaqueRecord" TEXT,
        mfa_enabled BOOLEAN DEFAULT FALSE)`);
    for (const sql of SSO_IDENTITY_DDL) await pg.exec(sql);
});
after(async () => { await pg.close(); });
beforeEach(async () => {
    await pg.exec('DELETE FROM sso_identities; DELETE FROM users;');
    await pg.exec(`INSERT INTO users (id) VALUES ('alice'), ('bob')`);
});

test('link records once, answers already for the owner and taken for anyone else', async () => {
    assert.strictEqual(await store.link('alice', 'google', 'sub-1'), 'linked');
    assert.strictEqual(await store.link('alice', 'google', 'sub-1'), 'already');
    assert.strictEqual(await store.link('bob', 'google', 'sub-1'), 'taken');
    assert.strictEqual(await store.findUserId('google', 'sub-1'), 'alice');
    assert.strictEqual(await store.findUserId('nextcloud', 'sub-1'), null);
});

test('hasOtherSubject and listForUser', async () => {
    await store.link('alice', 'google', 'sub-1');
    assert.strictEqual(await store.hasOtherSubject('alice', 'google', 'sub-1'), false);
    assert.strictEqual(await store.hasOtherSubject('alice', 'google', 'sub-2'), true);
    assert.strictEqual(await store.hasOtherSubject('alice', 'nextcloud', 'x'), false);
    assert.deepStrictEqual((await store.listForUser('alice')).map((r) => r.provider), ['google']);
});

test('identities go with the account', async () => {
    await store.link('bob', 'nextcloud', 'bob');
    await pg.exec(`DELETE FROM users WHERE id = 'bob'`);
    assert.strictEqual(await store.findUserId('nextcloud', 'bob'), null);
});
