// @typecheck
/**
 * users.replacePasswordHash: the write behind the bcrypt → argon2id upgrade at
 * sign-in (auth/login/passwordRehash.js), against a real Postgres (pglite).
 *
 *   - it replaces the hash only while the row still holds the verified one, so
 *     a password reset that lands in between keeps the newer hash;
 *   - it does not touch password_changed_at: the password did not change.
 *
 * Run: cd server && node --test stores/user/users.replacePasswordHash.pg.test.js
 */

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { installResolveStub } = require('../../testUtils/stubRequire');
const { pgliteDb } = require('../../testUtils/pgliteDb');

const { pg, db } = pgliteDb();
const restore = installResolveStub({
    '../../db': {
        run: (sql, params) => db.query(sql, params),
        getOne: async (sql, params) => (await db.query(sql, params)).rows[0] || null,
        getAll: async (sql, params) => (await db.query(sql, params)).rows,
        getClient: async () => { throw new Error('not used'); },
    },
    './schema': { initDB: async () => {} },
    './subscriptions': { getEffectiveLimits: async () => ({ max_users: null }) },
});
const users = require('./users');

const CHANGED_AT = '2025-01-02T03:04:05.000Z';

before(async () => {
    await pg.exec('CREATE TABLE users (id TEXT PRIMARY KEY, "passwordHash" TEXT, password_changed_at TIMESTAMPTZ)');
    await pg.query('INSERT INTO users VALUES ($1,$2,$3)', ['anna', '$2b$10$old', CHANGED_AT]);
});
after(async () => { restore(); await pg.close(); });

const row = async (id) => (await pg.query('SELECT "passwordHash", password_changed_at FROM users WHERE id=$1', [id])).rows[0];

test('a hash that is no longer the verified one is left alone', async () => {
    assert.equal(await users.replacePasswordHash('anna', '$2b$10$someone-else', '$argon2id$new'), false);
    assert.equal((await row('anna')).passwordHash, '$2b$10$old');
});

test('the verified hash is replaced and the password date stays where it was', async () => {
    assert.equal(await users.replacePasswordHash('anna', '$2b$10$old', '$argon2id$new'), true);
    const r = await row('anna');
    assert.equal(r.passwordHash, '$argon2id$new');
    assert.equal(new Date(r.password_changed_at).toISOString(), CHANGED_AT);
});

test('an unknown user or an empty argument writes nothing', async () => {
    assert.equal(await users.replacePasswordHash('nobody', '$2b$10$old', '$argon2id$x'), false);
    assert.equal(await users.replacePasswordHash('anna', '', '$argon2id$x'), false);
    assert.equal(await users.replacePasswordHash('anna', '$argon2id$new', ''), false);
    assert.equal((await row('anna')).passwordHash, '$argon2id$new');
});
