// @typecheck strict
/**
 * users.hasMirroredNcUsers, against a real Postgres (pglite): does an
 * organisation have users mirrored from Nextcloud? The user and group sync
 * asks this to tell an organisation that already synchronises from one whose
 * sync mode is not chosen yet (services/ncSyncStart.mts).
 *
 * The administrators provisioned when the organisation is bound are not
 * mirrored users, and neither are accounts that did not come from Nextcloud.
 *
 * Run: cd server && node --test stores/user/users.mirroredNcUsers.pg.test.js
 */

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { usePglitePool } = require('../../testUtils/pglitePool');

// The real db.js over PGlite: the pool is the seam, no module mocking.
const { pg, close } = usePglitePool();
const users = require('./users');

before(async () => {
    await pg.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, "organizationId" TEXT DEFAULT '', provider TEXT, "nc_uid" TEXT, "orgRole" TEXT)`);
    for (const row of [
        ['a_admin', 'org_admins_only', 'nextcloud_connector', 'root', 'org_admin'],
        ['a_legacy', 'org_admins_only', 'nextcloud_connector', 'boss', 'admin'],
        ['a_local', 'org_admins_only', 'local', null, ''],
        ['a_sso', 'org_admins_only', 'azure', null, null],
        ['b_admin', 'org_mirrored', 'nextcloud_connector', 'root', 'org_admin'],
        ['b_user', 'org_mirrored', 'nextcloud_connector', 'alice', ''],
        ['c_user', 'org_null_role', 'nextcloud_connector', 'bob', null],
        ['d_user', 'org_no_uid', 'nextcloud_connector', null, ''],
    ]) await pg.query('INSERT INTO users (id, "organizationId", provider, "nc_uid", "orgRole") VALUES ($1, $2, $3, $4, $5)', row);
});
after(close);

test('administrators and accounts from elsewhere are not mirrored users', async () => {
    assert.equal(await users.hasMirroredNcUsers('org_admins_only'), false);
    assert.equal(await users.hasMirroredNcUsers('org_no_uid'), false, 'without a Nextcloud uid the account was not mirrored');
});

test('a regular user that came from Nextcloud is one, with or without a stored role', async () => {
    assert.equal(await users.hasMirroredNcUsers('org_mirrored'), true);
    assert.equal(await users.hasMirroredNcUsers('org_null_role'), true);
});

test('an organisation sees only its own users', async () => {
    assert.equal(await users.hasMirroredNcUsers('org_empty'), false);
    assert.equal(await users.hasMirroredNcUsers(''), false);
});
