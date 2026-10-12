'use strict';
process.env.MASTER_ENCRYPTION_KEY = 'test-master-key-for-transactional-oauth';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgliteDb } = require('../testUtils/pgliteDb');
const { createAuthConfigStore } = require('./authConfigStore');
const crypto = require('./configEncryption');
const { pg, db } = pgliteDb();
const invalidations = [];
const configStore = { ...crypto, initDB: async () => {}, CONFIG_INVALIDATE_CHANNEL: 'test_config', _applyInvalidation: key => invalidations.push(key) };
let failKey, commitGate;
const store = createAuthConfigStore({ configStore, db: {
    withTransaction: fn => db.tx(async client => {
        const result = await fn({ query: async (sql, params) => {
            if (sql.includes('INSERT INTO config') && params[0] === failKey) throw new Error('disk write failed');
            return client.query(sql, params);
        } });
        if (commitGate) await commitGate;
        return result;
    }),
} });
before(async () => { await pg.exec('CREATE TABLE config (key TEXT PRIMARY KEY,value TEXT,updated_at TIMESTAMPTZ DEFAULT NOW())'); });
after(() => pg.close());
async function raw(key) { return (await pg.query('SELECT value FROM config WHERE key=$1', [key])).rows[0]?.value; }
test('existing installations migrate three distinct plaintext secrets transactionally and repeatedly', async () => {
    await pg.query('INSERT INTO config(key,value) VALUES ($1,$2),($3,$4)', ['providers', JSON.stringify({ microsoft: { tenantId: 'common', clientId: 'ms', clientSecret: 'ms-legacy' }, google: { clientId: 'google', clientSecret: 'google-legacy' }, nextcloud: { clientSecret: 'nc-legacy' } }), 'oauth', JSON.stringify({ nextcloudUrl: 'https://nc.invalid', clientId: 'nc', clientSecret: 'nc-legacy' })]);
    const result = await store.load();
    assert.equal(result.providers.microsoft.clientSecret, 'ms-legacy');
    assert.equal(result.oauth.clientSecret, 'nc-legacy');
    for (const [key, expected] of [['oauth_microsoft_client_secret','ms-legacy'],['oauth_google_client_secret','google-legacy'],['oauth_nextcloud_client_secret','nc-legacy']]) {
        assert.equal(JSON.parse(await raw(key))._encrypted, 'config-v1');
        assert.equal(crypto.decryptValue(await raw(key)), expected);
    }
    assert.ok(!(await raw('providers')).includes('legacy'));
    assert.ok(!(await raw('oauth')).includes('legacy'));
    const snapshot = await pg.query('SELECT * FROM config ORDER BY key');
    await store.migrate(); await store.migrate();
    assert.deepEqual((await pg.query('SELECT * FROM config ORDER BY key')).rows, snapshot.rows);
});
test('blank or omitted secrets preserve credentials and omitted metadata', async () => {
    await store.save({ providers: { microsoft: { clientSecret: '', tenantId: 'organizations', clientId: undefined } } });
    await store.save({ providers: { microsoft: { clientSecret: '   ' } } });
    const config = await store.load();
    assert.equal(config.providers.microsoft.clientSecret, 'ms-legacy');
    assert.equal(config.providers.microsoft.clientId, 'ms');
    assert.equal(config.providers.microsoft.tenantId, 'organizations');
    assert.equal(config.providers.google.clientSecret, 'google-legacy');
});
test('write failures roll back metadata and rotated credentials, without cache invalidation', async () => {
    const before = (await pg.query('SELECT * FROM config ORDER BY key')).rows;
    invalidations.length = 0; failKey = 'providers';
    await assert.rejects(store.save({ providers: { microsoft: { clientId: 'changed', clientSecret: 'rotated' } } }), /disk write/);
    failKey = null;
    assert.deepEqual((await pg.query('SELECT * FROM config ORDER BY key')).rows, before);
    assert.deepEqual(invalidations, []);
});
test('save resolves only after commit and invalidates only after commit', async () => {
    let release;
    commitGate = new Promise(resolve => { release = resolve; });
    invalidations.length = 0;
    let completed = false;
    const saving = store.save({ providers: { microsoft: { clientSecret: 'rotated' } } }).then(() => { completed = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(completed, false); assert.deepEqual(invalidations, []);
    commitGate = null; release(); await saving;
    assert.ok(completed); assert.ok(invalidations.includes('providers'));
    assert.equal((await store.load()).providers.microsoft.clientSecret, 'rotated');
});
test('migration verifies the database readback before removing legacy plaintext', async () => {
    await pg.exec(`CREATE FUNCTION corrupt_oauth_secret() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.key='oauth_google_client_secret' THEN NEW.value='corrupt-storage'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER corrupt_secret BEFORE INSERT OR UPDATE ON config FOR EACH ROW EXECUTE FUNCTION corrupt_oauth_secret();`);
    const before = (await pg.query('SELECT * FROM config ORDER BY key')).rows;
    await assert.rejects(store.save({ providers: { google: { clientSecret: 'new-google-secret' } } }), /verification failed/);
    assert.deepEqual((await pg.query('SELECT * FROM config ORDER BY key')).rows, before);
    await pg.exec('DROP TRIGGER corrupt_secret ON config');
});
test('corrupt metadata or encrypted credentials fail without writing defaults or plaintext fallback', async () => {
    await pg.query('UPDATE config SET value=$1 WHERE key=$2', ['{bad', 'providers']);
    await assert.rejects(store.load());
    assert.equal(await raw('providers'), '{bad');
    await pg.query('UPDATE config SET value=$1 WHERE key=$2', [JSON.stringify({ microsoft: { clientSecret: 'plaintext-fallback' } }), 'providers']);
    await pg.query('UPDATE config SET value=$1 WHERE key=$2', [JSON.stringify({ _encrypted: 'config-v1', iv: 'bad' }), 'oauth_microsoft_client_secret']);
    await assert.rejects(store.load());
    assert.ok((await raw('providers')).includes('plaintext-fallback'));
});
