'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgliteDb } = require('../testUtils/pgliteDb');
const { createAzureSyncMembershipStore } = require('./azureSyncMembershipStore');
const { pg, db } = pgliteDb();
const store = createAzureSyncMembershipStore({ withTransaction: db.tx });
const group = { id: 'azure-group', organizationId: 'org-B', azureTenantId: 'tenant-B' };
before(async () => { await pg.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,groups TEXT,"organizationId" TEXT,"azureTenantId" TEXT,"azureUserId" TEXT);
    CREATE TABLE groups(id TEXT PRIMARY KEY,"organizationId" TEXT,"azureTenantId" TEXT,source TEXT);
    CREATE TABLE azure_sync_memberships(user_id TEXT,group_id TEXT,organization_id TEXT,tenant_id TEXT,PRIMARY KEY(user_id,group_id));
    INSERT INTO groups VALUES('azure-group','org-B','tenant-B','azure'),('org-A-group','org-A',NULL,'manual'),('manual-B','org-B',NULL,'manual');
    INSERT INTO users VALUES('manual','["azure-group","org-A-group"]','org-B','tenant-B','oid'),('synced','["org-A-group"]','org-B','tenant-B','oid'),('multi','["org-A-group","manual-B"]','org-A','tenant-B','oid');`); });
after(() => pg.close());
async function groups(id) { return JSON.parse((await pg.query('SELECT groups FROM users WHERE id=$1', [id])).rows[0].groups); }
test('manual grants remain manual and cannot be removed by sync', async () => {
    await store.add('manual', group, 'oid'); await store.remove('manual', group, 'oid');
    assert.deepEqual(await groups('manual'), ['azure-group','org-A-group']);
    assert.equal((await pg.query('SELECT * FROM azure_sync_memberships')).rows.length, 0);
});
test('sync-owned membership is scoped to a binding and never deletes another organization grant', async () => {
    await store.add('synced', group, 'oid'); await store.add('synced', group, 'oid');
    await store.remove('synced', { ...group, organizationId: 'org-A' }, 'oid');
    assert.deepEqual(await groups('synced'), ['org-A-group','azure-group']);
    await store.remove('synced', group, 'oid');
    assert.deepEqual(await groups('synced'), ['org-A-group']);
});
test('authorization is rechecked under the user lock; explicit multi-organization grants remain supported', async () => {
    await store.add('multi', group, 'oid');
    assert.ok((await groups('multi')).includes(group.id));
    await store.remove('multi', group, 'oid');
    await pg.query('UPDATE users SET groups=$1 WHERE id=$2', ['["org-A-group"]','multi']);
    await assert.rejects(store.add('multi', group, 'oid'), /authorization changed/);
    assert.deepEqual(await groups('multi'), ['org-A-group']);
    await assert.rejects(store.add('synced', { ...group, azureTenantId: 'another-tenant' }, 'oid'), /authorization changed/);
});

test('cleanup cannot remove a group moved to another organization or an identity changed since the snapshot', async () => {
    await store.add('synced', group, 'oid');
    await pg.query('UPDATE groups SET "organizationId"=$1 WHERE id=$2', ['org-A', group.id]);
    await store.remove('synced', group, 'oid');
    assert.deepEqual(await groups('synced'), ['org-A-group','azure-group']);
    assert.equal((await pg.query('SELECT * FROM azure_sync_memberships WHERE user_id=$1', ['synced'])).rows.length, 1);
    await pg.query('UPDATE groups SET "organizationId"=$1 WHERE id=$2', ['org-B', group.id]);
    await pg.query('UPDATE users SET "azureUserId"=$1 WHERE id=$2', ['new-oid','synced']);
    await store.remove('synced', group, 'oid');
    assert.deepEqual(await groups('synced'), ['org-A-group','azure-group']);
    await assert.rejects(store.add('synced', group, 'oid'), /authorization changed/);
    await pg.query('UPDATE users SET "azureUserId"=$1 WHERE id=$2', ['oid','synced']);
    await store.remove('synced', group, 'oid');
    assert.deepEqual(await groups('synced'), ['org-A-group']);
});
