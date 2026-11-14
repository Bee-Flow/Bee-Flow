// @typecheck
/**
 * configStore.listKeysWithPrefix against a real Postgres (PGlite behind db.js's
 * pool, testUtils/pglitePool.js).
 *
 * Contract: returns FULL keys (callers strip the prefix — see
 * auth/connectorJwt._listTenantOrgIds), and a prefix containing % / _ / \
 * matches literally, so it cannot widen the match.
 *
 * Run: cd server && node --test stores/configStore.listKeys.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const configStore = require('./configStore');

before(async () => {
    await configStore.initDB();
    await pg.exec(`INSERT INTO config (key, value) VALUES
        ('connector_tenant_key_org1', 's1'), ('connector_tenant_key_org2', 's2'),
        ('connectorXtenantXkeyXrogue', 'r'), ('a%b_c\\d-1', 'x'), ('aXbYc\\d-2', 'y'), ('other', 'o')`);
});
after(close);

test('returns the FULL keys under the prefix', async () => {
    const keys = await configStore.listKeysWithPrefix('connector_tenant_key_');
    assert.deepEqual(keys.sort(), ['connector_tenant_key_org1', 'connector_tenant_key_org2'],
        'an underscore is not "any single char": connectorXtenant… stays out');
});

test('% , _ and \\ in the prefix match literally', async () => {
    assert.deepEqual(await configStore.listKeysWithPrefix('a%b_c\\d'), ['a%b_c\\d-1']);
});

test('an empty or non-string prefix returns []', async () => {
    assert.deepEqual(await configStore.listKeysWithPrefix(''), []);
    assert.deepEqual(await configStore.listKeysWithPrefix(/** @type {any} */ (null)), []);
    assert.deepEqual(await configStore.listKeysWithPrefix(/** @type {any} */ (42)), []);
});
