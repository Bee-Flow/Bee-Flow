'use strict';

process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { usePglitePool } = require('../../testUtils/pglitePool');
const { pg, close } = usePglitePool();
const { initDB } = require('./schema');
const { searchOrgDirectoryNames } = require('./directoryNames.mts');

before(async () => {
    await initDB();
    await pg.exec(`
        INSERT INTO users (id, username, "organizationId")
        SELECT 'a' || n, 'Person ' || n, 'org1' FROM generate_series(1, 510) AS n;
        INSERT INTO users (id, username, "displayName", "organizationId", status) VALUES
          ('z', 'zoe', 'Zoe', 'org1', 'active'),
          ('gone', 'gone', 'Zoe', 'org1', 'inactive'),
          ('other', 'other', 'Zoe', 'org2', 'active'),
          ('sso1', 'address@example.test', NULL, 'org1', 'active');
    `);
});
after(close);

test('finds a colleague past the first 500 directory entries and caps broad searches', async () => {
    assert.deepEqual(await searchOrgDirectoryNames('org1', 'ZO', 20), [{ id: 'z', name: 'Zoe' }]);
    assert.equal((await searchOrgDirectoryNames('org1', '', 20)).length, 20);
});

test('searches only the visible label, even when an SSO username is an address', async () => {
    assert.deepEqual(await searchOrgDirectoryNames('org1', 'address', 20), []);
    assert.deepEqual(await searchOrgDirectoryNames('org1', 'sso1', 20), [{ id: 'sso1', name: 'sso1' }]);
    assert.deepEqual(await searchOrgDirectoryNames('org1', '%', 20), []);
});
