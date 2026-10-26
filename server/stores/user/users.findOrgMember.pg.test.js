// @typecheck
/**
 * users.findOrgMemberIdByEmail, the subject lookup of the DSR discovery scan
 * (compliance/dsr/discovery.js), against a real Postgres (pglite).
 *
 * 'default' is the bucket of users without an organisation: the DSR intake
 * files their requests there (routes/dsr.js), so the scan of a 'default'
 * request must find them, whether their "organizationId" is '', NULL or the
 * literal 'default'. A real organisation still sees only its own members.
 *
 * Run: cd server && node --test stores/user/users.findOrgMember.pg.test.js
 */

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { usePglitePool } = require('../../testUtils/pglitePool');

// The real db.js over PGlite: the pool is the seam, no module mocking.
const { pg, close } = usePglitePool();
const users = require('./users');

before(async () => {
    await pg.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, "organizationId" TEXT DEFAULT '')`);
    for (const [id, email, org] of [
        ['anna', 'anna@example.test', ''],
        ['bob', 'bob@example.test', null],
        ['carl', 'carl@example.test', 'default'],
        ['dora', 'dora@example.test', 'org_a'],
    ]) await pg.query('INSERT INTO users (id, email, "organizationId") VALUES ($1, $2, $3)', [id, email, org]);
});
after(close);

test("the 'default' bucket finds users without an organisation, however it is stored", async () => {
    assert.equal(await users.findOrgMemberIdByEmail('default', 'ANNA@example.test'), 'anna', "'' is no organisation");
    assert.equal(await users.findOrgMemberIdByEmail('default', 'bob@example.test'), 'bob', 'NULL is no organisation');
    assert.equal(await users.findOrgMemberIdByEmail('default', 'carl@example.test'), 'carl');
});

test("an organisation's member is not in the 'default' bucket, and an organisation sees only its own", async () => {
    assert.equal(await users.findOrgMemberIdByEmail('default', 'dora@example.test'), null);
    assert.equal(await users.findOrgMemberIdByEmail('org_a', 'dora@example.test'), 'dora');
    assert.equal(await users.findOrgMemberIdByEmail('org_a', 'anna@example.test'), null);
    assert.equal(await users.findOrgMemberIdByEmail('org_a', 'nobody@example.test'), null);
});
