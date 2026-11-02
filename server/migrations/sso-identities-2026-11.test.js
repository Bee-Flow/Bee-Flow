// @typecheck
'use strict';
/**
 * The sso_identities backfill on a real Postgres (PGlite): only identities
 * the account id names with certainty, only on rows with no credential of
 * their own, and a rerun adds nothing.
 * Run: cd server && node --test migrations/sso-identities-2026-11.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../testUtils/pgliteDb');
const migration = require('./sso-identities-2026-11');

const { pg, db } = pgliteDb();
const migrationDb = {
    exec: (/** @type {string} */ sql) => pg.exec(sql),
    run: (/** @type {string} */ sql) => db.query(sql),
};

before(async () => {
    await pg.exec(`CREATE TABLE users (
        id TEXT PRIMARY KEY, email TEXT, role TEXT DEFAULT 'user', "passwordHash" TEXT, "opaqueRecord" TEXT,
        mfa_enabled BOOLEAN DEFAULT FALSE)`);
});
after(async () => { await pg.close(); });

test('the migration records nextcloud-<uid> and 21-digit Google ids of credential-less rows only, idempotently', async () => {
    await pg.exec(`INSERT INTO users (id, "passwordHash", role) VALUES
        ('nextcloud-carol', NULL, 'user'), ('nextcloud-dave', 'hash', 'user'), ('nextcloud-root', NULL, 'admin'),
        ('109876543210987654321', NULL, 'user'), ('12345', NULL, 'user')`);
    await migration.up(migrationDb);
    await migration.up(migrationDb);
    const { rows } = await pg.query('SELECT user_id, provider, subject FROM sso_identities ORDER BY user_id');
    assert.deepStrictEqual(rows.map((r) => ({ ...r })), [
        { user_id: '109876543210987654321', provider: 'google', subject: '109876543210987654321' },
        { user_id: 'nextcloud-carol', provider: 'nextcloud', subject: 'carol' },
    ]);
});
