/**
 * configStore.listKeysWithPrefix — key-only prefix listing.
 *
 * Contract: returns FULL keys (callers strip the prefix — see
 * auth/connectorJwt._listTenantOrgIds), never reads values, and escapes
 * LIKE metacharacters so a prefix containing % / _ / \ cannot widen the
 * match. Fake pg layer injected into require.cache — no Postgres.
 *
 * Run: node --test server/stores/configStore.listKeys.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const issued = [];
let rows = [];

const dbResolved = require.resolve(path.join(__dirname, '..', 'db.js'));
require.cache[dbResolved] = {
    id: dbResolved, filename: dbResolved, loaded: true,
    exports: {
        run: async () => ({ rows: [], rowCount: 0 }),
        exec: async () => ({ rows: [], rowCount: 0 }),
        getOne: async () => null,
        getAll: async (sql, params = []) => {
            issued.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
            if (/SELECT key FROM config WHERE key LIKE/.test(sql)) return rows;
            return [];
        },
        withTransaction: async (fn) => fn({ query: async () => ({ rows: [] }) }),
        getRedis: () => null,
        pool: { connect: async () => { throw new Error('no db in tests'); }, query: async () => ({ rows: [] }) },
    },
};

const configStore = require('./configStore');

beforeEach(() => {
    issued.length = 0;
    rows = [];
});

test('returns FULL keys from a key-only query', async () => {
    rows = [{ key: 'connector_tenant_key_org1' }, { key: 'connector_tenant_key_org2' }];
    const keys = await configStore.listKeysWithPrefix('connector_tenant_key_');
    assert.deepEqual(keys, ['connector_tenant_key_org1', 'connector_tenant_key_org2']);
    const q = issued.find(i => /SELECT key FROM config WHERE key LIKE/.test(i.sql));
    assert.ok(q, 'must query keys only');
    assert.ok(!/value/.test(q.sql), 'must not read values — that is what made getAllConfig a per-request table scan');
    // Underscores are LIKE metacharacters ("any single char") — they must be
    // escaped or `connector_tenant_key_` would also match rogue keys like
    // `connectorXtenant…`. The pattern is the escaped prefix plus a trailing %.
    assert.equal(q.params[0], 'connector\\_tenant\\_key\\_%');
});

test('escapes LIKE metacharacters in the prefix', async () => {
    await configStore.listKeysWithPrefix('a%b_c\\d');
    const q = issued.find(i => /SELECT key FROM config WHERE key LIKE/.test(i.sql));
    assert.equal(q.params[0], 'a\\%b\\_c\\\\d%');
    assert.match(q.sql, /ESCAPE/, 'the escape character must be declared');
});

test('empty or non-string prefix returns [] without touching the DB', async () => {
    assert.deepEqual(await configStore.listKeysWithPrefix(''), []);
    assert.deepEqual(await configStore.listKeysWithPrefix(null), []);
    assert.deepEqual(await configStore.listKeysWithPrefix(42), []);
    assert.equal(issued.filter(i => /WHERE key LIKE/.test(i.sql)).length, 0);
});
