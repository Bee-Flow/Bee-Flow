'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgliteDb } = require('../testUtils/pgliteDb');
const { createMicrosoftIdentityStore } = require('./microsoftIdentityStore');
const { pg, db } = pgliteDb();
const store = createMicrosoftIdentityStore({ run: db.query, getAll: async (...args) => (await db.query(...args)).rows, withTransaction: db.tx });
const identity = { azureTenantId: '11111111-1111-1111-1111-111111111111', azureUserId: '22222222-2222-2222-2222-222222222222', email: 'person@example.test' };
before(async () => { await pg.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY,"azureTenantId" TEXT,"azureUserId" TEXT,"organizationId" TEXT,groups TEXT,role TEXT DEFAULT 'user',status TEXT DEFAULT 'active');
    CREATE UNIQUE INDEX identities ON users("azureTenantId","azureUserId") WHERE "azureTenantId" IS NOT NULL AND "azureUserId" IS NOT NULL;
    CREATE TABLE microsoft_sso_link_requests(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id TEXT,object_id TEXT,email TEXT,expires_at TIMESTAMPTZ,UNIQUE(tenant_id,object_id));
    CREATE TABLE microsoft_sso_binding_audit(id BIGSERIAL PRIMARY KEY,actor_id TEXT,user_id TEXT,tenant_id TEXT,object_id TEXT,action TEXT);
    INSERT INTO users(id,"azureTenantId","azureUserId","organizationId",groups) VALUES ('local-user',NULL,'unverified-old-oid','org-A','["manual-A","manual-B"]'),('other',NULL,NULL,'org-B','[]');
    INSERT INTO users(id,role) VALUES ('platform-admin','admin'),('admin','admin');
`); });
after(() => pg.close());
test('a recent token-free request binds atomically, preserving local IDs and multi-org memberships', async () => {
    const requestId = await store.requestLink(identity);
    const again = await store.requestLink(identity);
    assert.equal(again, requestId);
    const request = (await store.listRequests())[0];
    assert.ok(new Date(request.expires_at).getTime() - Date.now() > 6 * 86400000);
    assert.ok(!JSON.stringify(request).includes('token'));
    await store.bind('local-user', requestId, 'platform-admin');
    const user = (await pg.query('SELECT * FROM users WHERE id=$1', ['local-user'])).rows[0];
    assert.equal(user.azureTenantId, identity.azureTenantId);
    assert.equal(user.azureUserId, identity.azureUserId);
    assert.equal(user.organizationId, 'org-A');
    assert.equal(user.groups, '["manual-A","manual-B"]');
    assert.equal((await store.listRequests()).length, 0);
    assert.equal((await pg.query('SELECT action FROM microsoft_sso_binding_audit')).rows[0].action, 'bind');
});
test('expired requests and missing accounts cannot bind; conflicts return 409 without consuming the request', async () => {
    const requestId = await store.requestLink(identity);
    await assert.rejects(store.bind('other', requestId, 'admin'), e => e.status === 409);
    await assert.rejects(store.bind('local-user', requestId, 'admin'), e => e.status === 409);
    await assert.rejects(store.bind('missing', requestId, 'admin'), e => e.status === 404);
    assert.equal((await store.listRequests()).length, 1);
    await pg.query('UPDATE microsoft_sso_link_requests SET expires_at=NOW()-INTERVAL \'1 day\' WHERE id=$1', [requestId]);
    await assert.rejects(store.bind('other', requestId, 'admin'), e => e.code === 'sso_request_expired');
});
test('rebinding requires explicit unlink and keeps an audit trail', async () => {
    await store.unbind('local-user', 'admin');
    const requestId = await store.requestLink(identity);
    await store.bind('other', requestId, 'admin');
    assert.equal((await pg.query('SELECT "azureTenantId" FROM users WHERE id=$1', ['local-user'])).rows[0].azureTenantId, null);
    assert.deepEqual((await pg.query('SELECT action FROM microsoft_sso_binding_audit ORDER BY id')).rows.map(r => r.action), ['bind','unbind','bind']);
});

test('unlinking and relinking the same identity changes its session revision', async () => {
    const before = await store.getIdentityBinding('other');
    assert.equal(before.azureUserId, identity.azureUserId);
    await store.unbind('other', 'admin');
    const unbound = await store.getIdentityBinding('other');
    assert.equal(unbound.azureTenantId, null);
    assert.notEqual(unbound.revision, before.revision);
    const requestId = await store.requestLink(identity);
    await store.bind('other', requestId, 'admin');
    const after = await store.getIdentityBinding('other');
    assert.equal(after.azureUserId, before.azureUserId);
    assert.notEqual(after.revision, before.revision);
    assert.equal(await store.getIdentityBinding('missing'), null);
});

test('a demoted or suspended administrator is refused inside the binding transaction', async () => {
    const requestId = await store.requestLink({ ...identity, azureUserId: '33333333-3333-3333-3333-333333333333' });
    await assert.rejects(store.bind('local-user', requestId, 'local-user'), e => e.status === 403);
    await pg.query("UPDATE users SET status='suspended' WHERE id='admin'");
    await assert.rejects(store.bind('local-user', requestId, 'admin'), e => e.status === 403);
    await assert.rejects(store.unbind('other', 'admin'), e => e.status === 403);
});
