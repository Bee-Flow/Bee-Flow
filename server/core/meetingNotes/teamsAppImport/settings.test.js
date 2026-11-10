'use strict';
/**
 * The organisation-wide import setting: off by default, its key, the tenant
 * snapshot taken when it is switched on (and kept while it stays on), the
 * audit row (switch, coverage, a count and the tenant; never a user id or a
 * name) and the erasure helper.
 *
 * Run: cd server && node --test core/meetingNotes/teamsAppImport/settings.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const settings = require('./settings.mts');
const coverage = require('./coverage.mts');

const TENANT = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-2222-3333-4444-555555555555';

function fakeConfigStore() {
    const docs = new Map();
    return {
        docs,
        getConfig: async (k) => (docs.has(k) ? structuredClone(docs.get(k)) : null),
        getConfigFresh: async (k) => (docs.has(k) ? structuredClone(docs.get(k)) : null),
        setConfig: async (k, v) => { docs.set(k, structuredClone(v)); return true; },
        listKeysWithPrefix: async (p) => [...docs.keys()].filter((k) => k.startsWith(p)),
    };
}

function setup({ orgTenant = { ok: true, tenantId: TENANT, source: 'directory_binding' } } = {}) {
    const store = fakeConfigStore();
    const audits = [];
    settings.init({ configStore: store, logAccessAudit: async (...args) => { audits.push(args); } });
    const fx = { orgTenant };
    coverage.init({
        listOrgMemberRows: async () => ({ rows: [
            { userId: 'u-amy', displayName: 'Amy Fixture', username: 'amy', azureTenantId: TENANT, azureUserId: 'aaaaaaaa-0000-0000-0000-000000000001', credentialStatus: null, credentialScope: null },
            { userId: 'u-bob', displayName: 'Bob Fixture', username: 'bob', azureTenantId: null, azureUserId: null, credentialStatus: null, credentialScope: null },
        ], truncated: false }),
        orgTenant: async () => fx.orgTenant,
        loadConfig: async () => ({ providers: { microsoft: { clientId: 'cccccccc-0000-0000-0000-000000000001', clientSecret: 'fixture-not-a-secret', tenantId: 'common' } } }),
        hasCapability: async () => true,
        log: { warn: () => {} },
    });
    return { store, audits, fx };
}

test.afterEach(() => { settings.init(); coverage.init(); });

test('the key is org_<id>_teams_app_import, and an absent document is off with nobody selected', async () => {
    setup();
    assert.equal(settings.appImportKey('org-a'), 'org_org-a_teams_app_import');
    assert.deepEqual(await settings.readAppImportSettings('org-a'), {
        enabled: false, coverage: 'selected', selectedUserIds: [], tenantId: null, enabledAt: null, enabledBy: null, updatedAt: null, updatedBy: null,
    });
    assert.equal((await settings.readAppImportSettings(null)).enabled, false);
});

test('only enabled === true is on; junk reads as the default', () => {
    for (const enabled of ['true', 1, 'yes', null, undefined]) assert.equal(settings.normalizeAppImportSettings({ enabled }).enabled, false);
    assert.equal(settings.normalizeAppImportSettings({ enabled: true }).enabled, true);
    assert.equal(settings.normalizeAppImportSettings('x').enabled, false);
    const s = settings.normalizeAppImportSettings({ coverage: 'everyone', selectedUserIds: ['a', 'a', '', 7, 'b'], tenantId: 'common' });
    assert.equal(s.coverage, 'selected');
    assert.deepEqual(s.selectedUserIds, ['a', 'b']);
    assert.equal(s.tenantId, null, 'common is never a tenant');
});

test('switching on takes the verified tenant; the audit row has a count and the tenant, never an id or a name', async () => {
    const { store, audits } = setup();
    const res = await coverage.updateAppImport({ orgId: 'org-a', actorId: 'u-admin', body: { enabled: true, coverage: 'selected', selectedUserIds: ['u-amy', 'u-amy'] }, now: new Date('2026-11-10T08:00:00Z') });
    assert.equal(res.ok, true);
    const stored = store.docs.get('org_org-a_teams_app_import');
    assert.equal(stored.enabled, true);
    assert.equal(stored.tenantId, TENANT);
    assert.equal(stored.enabledAt, '2026-11-10T08:00:00.000Z');
    assert.equal(stored.enabledBy, 'u-admin');
    assert.deepEqual(stored.selectedUserIds, ['u-amy'], 'deduplicated');
    assert.equal(audits.length, 1);
    const [action, targetType, targetId, changedBy, oldValues, newValues, orgId] = audits[0];
    assert.equal(action, 'teams_app_import_enabled');
    assert.equal(targetType, 'organization');
    assert.equal(targetId, 'org-a');
    assert.equal(changedBy, 'u-admin');
    assert.equal(orgId, 'org-a');
    assert.deepEqual(oldValues, { enabled: false, coverage: 'selected', selectedCount: 0, tenantId: null });
    assert.deepEqual(newValues, { enabled: true, coverage: 'selected', selectedCount: 1, tenantId: TENANT });
    const text = JSON.stringify([oldValues, newValues]);
    for (const leak of ['u-amy', 'Amy', 'u-admin']) assert.ok(!text.includes(leak), `audit values contain ${leak}`);
});

test('while it stays on, a later save keeps the snapshot even when the tenant link moved; off clears it', async () => {
    const { store, audits, fx } = setup();
    await coverage.updateAppImport({ orgId: 'org-a', actorId: 'u-admin', body: { enabled: true, coverage: 'all', selectedUserIds: [] } });
    fx.orgTenant = { ok: true, tenantId: OTHER, source: 'directory_binding' };
    await coverage.updateAppImport({ orgId: 'org-a', actorId: 'u-admin2', body: { enabled: true, coverage: 'selected', selectedUserIds: ['u-bob'] } });
    let stored = store.docs.get('org_org-a_teams_app_import');
    assert.equal(stored.tenantId, TENANT, 'not silently moved to the new tenant');
    assert.equal(stored.enabledBy, 'u-admin');
    assert.equal(stored.updatedBy, 'u-admin2');
    assert.equal(audits[1][0], 'teams_app_import_updated');

    await coverage.updateAppImport({ orgId: 'org-a', actorId: 'u-admin', body: { enabled: false, coverage: 'selected', selectedUserIds: ['u-bob'] } });
    stored = store.docs.get('org_org-a_teams_app_import');
    assert.equal(stored.enabled, false);
    assert.equal(stored.tenantId, null);
    assert.equal(stored.enabledBy, null);
    assert.equal(audits[2][0], 'teams_app_import_disabled');

    await coverage.updateAppImport({ orgId: 'org-a', actorId: 'u-admin', body: { enabled: true, coverage: 'selected', selectedUserIds: ['u-bob'] } });
    assert.equal(store.docs.get('org_org-a_teams_app_import').tenantId, OTHER, 'switching on again takes the tenant of now');
});

test('switching on without a verified tenant is refused and writes nothing; switching off always works', async () => {
    const { store, audits } = setup({ orgTenant: { ok: false, reason: 'tenant_not_bound' } });
    const res = await coverage.updateAppImport({ orgId: 'org-a', actorId: 'u-admin', body: { enabled: true, coverage: 'all', selectedUserIds: [] } });
    assert.deepEqual({ ok: res.ok, status: res.status, code: res.code }, { ok: false, status: 409, code: 'app_import_unavailable' });
    assert.match(res.message, /tenant_not_bound/);
    assert.equal(store.docs.size, 0);
    assert.equal(audits.length, 0);
    const off = await coverage.updateAppImport({ orgId: 'org-a', actorId: 'u-admin', body: { enabled: false, coverage: 'all', selectedUserIds: [] } });
    assert.equal(off.ok, true);
    assert.equal(audits[0][0], 'teams_app_import_updated');
});

test('forgetUserInAppImport takes the user out of the selection and the stamps, and leaves others alone', async () => {
    const { store } = setup();
    store.docs.set('org_org-a_teams_app_import', { enabled: true, coverage: 'selected', selectedUserIds: ['u-amy', 'u-bob'], tenantId: TENANT, enabledBy: 'u-amy', updatedBy: 'u-admin' });
    assert.equal(await settings.forgetUserInAppImport('u-amy', 'org-a'), true);
    const s = store.docs.get('org_org-a_teams_app_import');
    assert.deepEqual(s.selectedUserIds, ['u-bob']);
    assert.equal(s.enabledBy, null);
    assert.equal(s.updatedBy, 'u-admin');
    assert.equal(s.enabled, true);
    assert.equal(await settings.forgetUserInAppImport('u-zed', 'org-a'), false);
    assert.equal(await settings.forgetUserInAppImport('u-amy', 'org-none'), false);
});

test('erasure sweeps every organisation that names the user, and nothing else', async () => {
    const { store } = setup();
    store.docs.set('org_org-a_teams_app_import', { enabled: true, coverage: 'selected', selectedUserIds: ['u-amy', 'u-bob'], tenantId: TENANT, enabledBy: 'u-admin', updatedBy: 'u-amy' });
    store.docs.set('org_org-old_teams_app_import', { enabled: false, coverage: 'selected', selectedUserIds: ['u-amy'] });
    store.docs.set('org_org-c_teams_app_import', { enabled: true, coverage: 'all', selectedUserIds: ['u-bob'], tenantId: TENANT, enabledBy: 'u-bob' });
    const other = { selectedUserIds: ['u-amy'] };
    store.docs.set('org_org-a_teams_notes', other);
    assert.equal(await settings.forgetUserInAllAppImports('u-amy'), 2);
    assert.deepEqual(store.docs.get('org_org-a_teams_app_import').selectedUserIds, ['u-bob']);
    assert.equal(store.docs.get('org_org-a_teams_app_import').updatedBy, null);
    assert.equal(store.docs.get('org_org-a_teams_app_import').enabledBy, 'u-admin');
    assert.deepEqual(store.docs.get('org_org-old_teams_app_import').selectedUserIds, [], 'an organisation the account left too');
    assert.equal(store.docs.get('org_org-c_teams_app_import').enabledBy, 'u-bob');
    assert.deepEqual(store.docs.get('org_org-a_teams_notes'), other, 'other org documents are not touched');
    assert.equal(await settings.forgetUserInAllAppImports('u-amy'), 0, 'idempotent');
    assert.equal(await settings.forgetUserInAllAppImports(''), 0);
});
