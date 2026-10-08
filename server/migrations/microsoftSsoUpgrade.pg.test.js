'use strict';
process.env.MASTER_ENCRYPTION_KEY = 'test-upgrade-preserving-customer-data';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgliteDb } = require('../testUtils/pgliteDb');
const { createUpgradeInspector } = require('./microsoft-sso-hardening-2026-10');
const { createAuthConfigStore } = require('../stores/authConfigStore');
const crypto = require('../stores/configEncryption');
const { pg, db } = pgliteDb();
const txDb = { withTransaction: db.tx };
const tid = '11111111-1111-1111-1111-111111111111';
const oid = '22222222-2222-2222-2222-222222222222';
const duplicate = '33333333-3333-3333-3333-333333333333';
const gid = '44444444-4444-4444-4444-444444444444';
let directoryReads = 0;
const authStore = createAuthConfigStore({ db: txDb, configStore: { ...crypto, initDB: async () => {}, CONFIG_INVALIDATE_CHANNEL: 'test', _applyInvalidation() {} } });
const inspect = createUpgradeInspector({ db: txDb, migrateSecrets: authStore.migrate,
    initialize: async () => { await pg.exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS "azureTenantId" TEXT;
        ALTER TABLE groups ADD COLUMN IF NOT EXISTS "azureTenantId" TEXT;
        CREATE UNIQUE INDEX IF NOT EXISTS identities ON users("azureTenantId","azureUserId") WHERE "azureTenantId" IS NOT NULL;
        CREATE TABLE IF NOT EXISTS microsoft_sso_binding_audit(actor_id TEXT,user_id TEXT,tenant_id TEXT,object_id TEXT,action TEXT);`); },
    tokenFor: async () => 'directory-token', request: async url => { directoryReads++; return { ok: true, json: async () => ({ id: new URL(url).pathname.split('/').at(-1) }) }; },
});
before(async () => { await pg.exec(`CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT,updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE users(id TEXT PRIMARY KEY,"azureUserId" TEXT,"organizationId" TEXT,groups TEXT);
    CREATE TABLE groups(id TEXT PRIMARY KEY,"azureGroupId" TEXT,"organizationId" TEXT,source TEXT);
    CREATE TABLE organizations(id TEXT PRIMARY KEY,name TEXT);
    CREATE TABLE conversations(id TEXT,user_id TEXT,content TEXT);
    INSERT INTO organizations VALUES('org-A','Existing organization');
    INSERT INTO conversations VALUES('conversation','local-user','existing encrypted content');`);
    for (const [id, object] of [['local-user',oid],['duplicate-one',duplicate],['duplicate-two',duplicate]]) await pg.query('INSERT INTO users VALUES($1,$2,$3,$4)', [id,object,'org-A','["manual-A","manual-B"]']);
    await pg.query('INSERT INTO groups VALUES($1,$2,$3,$4)', ['existing-group-id',gid,'org-A','azure']);
    await pg.query('INSERT INTO config(key,value) VALUES ($1,$2),($3,$4),($5,$6)', ['providers', JSON.stringify({ microsoft: { tenantId: 'common', clientId: 'app', clientSecret: 'legacy-secret' } }), 'azure_group_sync_org-A', JSON.stringify({ periodicSync: true }), 'oauth', '{}']);
});
after(() => pg.close());
async function data() { return { users: (await pg.query('SELECT id,"organizationId",groups FROM users ORDER BY id')).rows, conversations: (await pg.query('SELECT * FROM conversations')).rows }; }
test('pre-upgrade common-tenant dry run is read-only and never guesses identity or enables old timers', async () => {
    const before = (await pg.query('SELECT * FROM config ORDER BY key')).rows;
    const report = await inspect();
    assert.equal(report.schemaUpgradeRequired, true);
    assert.equal(report.verified.length, 0); assert.equal(report.unresolved.length, 3);
    assert.equal(report.duplicateIdentities.length, 1);
    assert.deepEqual(report.periodicSyncsDisabled, ['org-A']);
    assert.deepEqual(report.plaintextSecretProviders, ['microsoft']);
    assert.equal(directoryReads, 0);
    assert.deepEqual((await pg.query('SELECT * FROM config ORDER BY key')).rows, before);
    assert.equal((await pg.query("SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='azureTenantId'")).rows.length, 0);
});
test('verified concrete-directory upgrade is repeatable and preserves account, group and conversation IDs', async () => {
    const before = await data();
    await pg.query('UPDATE config SET value=$1 WHERE key=$2', [JSON.stringify({ microsoft: { tenantId: tid, clientId: 'app', clientSecret: 'legacy-secret' } }), 'providers']);
    await pg.query('INSERT INTO config(key,value) VALUES($1,$2)', ['azure_group_sync_binding', JSON.stringify({ syncOrganizationId: 'org-A', syncTenantId: tid })]);
    const preview = await inspect();
    assert.equal(preview.verified.length, 1); assert.equal(preview.groups.length, 1);
    await inspect({ apply: true }); await inspect({ apply: true });
    assert.deepEqual(await data(), before);
    assert.equal((await pg.query('SELECT "azureTenantId" FROM users WHERE id=$1', ['local-user'])).rows[0].azureTenantId, tid);
    assert.equal((await pg.query('SELECT "azureTenantId" FROM users WHERE id=$1', ['duplicate-one'])).rows[0].azureTenantId, null);
    assert.equal((await pg.query('SELECT id FROM groups')).rows[0].id, 'existing-group-id');
    assert.equal((await pg.query('SELECT "azureTenantId" FROM groups')).rows[0].azureTenantId, tid);
    assert.equal((await pg.query('SELECT * FROM microsoft_sso_binding_audit')).rows.length, 1);
    const metadata = (await pg.query('SELECT value FROM config WHERE key=$1', ['providers'])).rows[0].value;
    assert.ok(!metadata.includes('legacy-secret'));
    const encrypted = (await pg.query('SELECT value FROM config WHERE key=$1', ['oauth_microsoft_client_secret'])).rows[0].value;
    assert.equal(crypto.decryptValue(encrypted), 'legacy-secret');
});

test('a typical single-organization installation upgrades automatically on a concrete tenant, even without directory access', async () => {
    await pg.query("DELETE FROM config WHERE key IN ('azure_group_sync_binding')");
    await pg.query('UPDATE users SET "azureTenantId"=NULL');
    await pg.query('DELETE FROM microsoft_sso_binding_audit');
    const auto = createUpgradeInspector({ db: txDb, migrateSecrets: async () => {}, initialize: async () => {},
        tokenFor: async () => { throw new Error('no Graph permission'); }, request: async () => { throw new Error('unreachable'); } });
    const report = await auto({ apply: true });
    assert.deepEqual(report.verified.map(v => [v.userId, v.basis]), [['local-user', 'configured_tenant']]);
    assert.equal(report.unresolved.length, 2);
    assert.equal(report.autoBinding.syncOrganizationId, 'org-A');
    assert.deepEqual(report.periodicSyncsDisabled, []);
    const binding = JSON.parse((await pg.query("SELECT value FROM config WHERE key='azure_group_sync_binding'")).rows[0].value);
    assert.deepEqual([binding.syncOrganizationId, binding.syncTenantId], ['org-A', tid]);
    assert.equal((await pg.query('SELECT "azureTenantId" FROM users WHERE id=$1', ['local-user'])).rows[0].azureTenantId, tid);
});
test('a directory that denies the object blocks the automatic link; two sync organizations stay unbound', async () => {
    await pg.query("DELETE FROM config WHERE key='azure_group_sync_binding'");
    await pg.query('UPDATE users SET "azureTenantId"=NULL');
    await pg.query("INSERT INTO organizations VALUES('org-B','Second')");
    await pg.query("INSERT INTO config(key,value) VALUES('azure_group_sync_org-B','{}')");
    const denies = createUpgradeInspector({ db: txDb, migrateSecrets: async () => {}, initialize: async () => {},
        tokenFor: async () => 'token', request: async () => ({ ok: false, status: 404 }) });
    const report = await denies({ apply: true });
    assert.equal(report.verified.length, 0);
    assert.equal(report.autoBinding, null);
    assert.deepEqual(report.syncBindingAmbiguous.sort(), ['org-A', 'org-B']);
    assert.equal((await pg.query("SELECT 1 FROM config WHERE key='azure_group_sync_binding'")).rows.length, 0);
});
