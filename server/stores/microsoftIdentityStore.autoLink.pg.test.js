'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgliteDb } = require('../testUtils/pgliteDb');
const { createMicrosoftIdentityStore } = require('./microsoftIdentityStore');
const { pg, db } = pgliteDb();
const store = createMicrosoftIdentityStore({ run: db.query, getAll: async (...args) => (await db.query(...args)).rows, withTransaction: db.tx });
const T = '11111111-1111-1111-1111-111111111111';
const OTHER_T = '99999999-9999-9999-9999-999999999999';
const oid = n => `2222222${n}-2222-2222-2222-222222222222`;
before(async () => { await pg.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY,email TEXT,"azureTenantId" TEXT,"azureUserId" TEXT,role TEXT DEFAULT 'user');
    CREATE UNIQUE INDEX identities ON users("azureTenantId","azureUserId") WHERE "azureTenantId" IS NOT NULL AND "azureUserId" IS NOT NULL;
    CREATE TABLE microsoft_sso_link_requests(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id TEXT,object_id TEXT,email TEXT,expires_at TIMESTAMPTZ,UNIQUE(tenant_id,object_id));
    CREATE TABLE microsoft_sso_binding_audit(id BIGSERIAL PRIMARY KEY,actor_id TEXT,user_id TEXT,tenant_id TEXT,object_id TEXT,action TEXT);
    INSERT INTO users(id,email,"azureUserId",role) VALUES
      ('has-oid','a@example.test','${oid(1)}','user'),
      ('dup-oid-1','b@example.test','${oid(2)}','user'), ('dup-oid-2','c@example.test','${oid(2)}','user'),
      ('email-only','d@example.test',NULL,'user'),
      ('dup-mail-1','e@example.test',NULL,'user'), ('dup-mail-2','E@example.test',NULL,'user'),
      ('admin-mail','f@example.test',NULL,'admin'),
      ('other-oid','g@example.test','${oid(8)}','user');
    INSERT INTO users(id,email,"azureTenantId","azureUserId") VALUES ('foreign','h@example.test','${OTHER_T}','${oid(7)}');
`); });
after(() => pg.close());
const link = (o, email, configuredTenantId = T, tenant = T) => store.autoLinkLegacy({ azureTenantId: tenant, azureUserId: o, email, configuredTenantId });
const row = async id => (await pg.query('SELECT "azureTenantId","azureUserId" FROM users WHERE id=$1', [id])).rows[0];

test('a stored object ID is linked at first login from the configured concrete tenant, with an audit row', async () => {
    const r = await link(oid(1), 'a@example.test');
    assert.deepEqual([r.linked, r.userId, r.basis], [true, 'has-oid', 'auto-link-oid']);
    assert.equal((await row('has-oid')).azureTenantId, T);
    const audit = (await pg.query('SELECT * FROM microsoft_sso_binding_audit')).rows;
    assert.equal(audit.length, 1); assert.equal(audit[0].actor_id, 'auto-link-oid'); assert.equal(audit[0].user_id, 'has-oid');
    assert.equal((await link(oid(1), 'a@example.test')).reason, 'already_bound');
});
test('an e-mail-only account is linked when exactly one user has that address', async () => {
    const r = await link(oid(3), 'D@Example.test');
    assert.deepEqual([r.linked, r.userId, r.basis], [true, 'email-only', 'auto-link-email']);
    assert.equal((await row('email-only')).azureUserId, oid(3));
});
test('ambiguous or risky cases are left to administrator approval', async () => {
    assert.equal((await link(oid(2), 'b@example.test')).reason, 'duplicate_object_id');
    assert.equal((await link(oid(4), 'e@example.test')).reason, 'duplicate_email');
    assert.equal((await link(oid(5), 'f@example.test')).reason, 'platform_admin_requires_approval');
    assert.equal((await link(oid(6), 'g@example.test')).reason, 'bound_to_other_identity');
    assert.equal((await link(oid(7), 'h@example.test')).reason, 'bound_to_other_tenant');
    assert.equal((await link(oid(4), 'nobody@example.test')).reason, 'no_match');
    assert.equal((await link(oid(4), 'h@example.test')).reason, 'bound_to_other_identity');
    for (const id of ['dup-oid-1', 'dup-mail-1', 'admin-mail', 'other-oid']) assert.equal((await row(id)).azureTenantId, null);
});
test('common, organizations, consumers or a different tenant never link automatically', async () => {
    await pg.query(`INSERT INTO users(id,email,"azureUserId") VALUES ('late','late@example.test','${oid(9)}')`);
    for (const configured of ['common', 'organizations', 'consumers', '', OTHER_T]) assert.equal((await link(oid(9), 'late@example.test', configured)).reason, 'tenant_not_concrete');
    assert.equal((await row('late')).azureTenantId, null);
    assert.equal((await link(oid(9), 'late@example.test')).linked, true);
});
