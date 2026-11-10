'use strict';
/**
 * GET /api/teams-notes-settings/user/me says whether the caller's own
 * organisation imports their Teams meetings with its app token (option B):
 * `orgImport.active`, decided from stored state by the coverage rule, without
 * asking Microsoft anything, and false when it cannot be decided.
 *
 * Run: cd server && node --test routes/teamsNotesSettings.orgImport.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'teams-notes-orgimport-test-session-secret-0123456789';
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'teams-notes-orgimport-test-master-key-0123456789abcdef';

const { usePglitePool } = require('../testUtils/pglitePool');
const { close: closePg } = usePglitePool();
const h = require('../testUtils/routeHarness');
const coverage = require('../core/meetingNotes/teamsAppImport/coverage.mts');
const entraToken = require('../core/meetingNotes/teamsSetup/entraToken.mts');

const T = '11111111-2222-3333-4444-555555555555';
const OID = 'aaaaaaaa-0000-0000-0000-000000000001';
const CONFIG = { providers: { microsoft: { clientId: 'cccccccc-0000-0000-0000-000000000001', clientSecret: 'fixture-not-a-secret', tenantId: 'common' } } };
const AMY = { id: 'u-amy', username: 'amy', email: 'amy@fixture.test', organizationId: 'org-a', role: 'user', orgRole: 'member', groups: [] };

const fx = {};
let api;
const outbound = [];

function reset() {
    fx.users = { 'u-amy': { id: 'u-amy', status: 'active', organizationId: 'org-a', azureTenantId: T, azureUserId: OID } };
    fx.settings = { 'org-a': { enabled: true, coverage: 'all', selectedUserIds: [], tenantId: T } };
    fx.tenant = { ok: true, tenantId: T, source: 'directory_binding' };
    fx.capable = true;
    fx.fail = null;
    outbound.length = 0;
}

before(async () => {
    const userStore = require('../stores/userStore');
    await userStore.initDB();
    await userStore.createOrganization({ id: 'org-a', name: 'org-a' }, { autoGrantTrial: false });
    await userStore.createUser({ ...AMY, passwordHash: 'x' });
    entraToken.init({ safeFetch: async (url) => { outbound.push(url); throw new Error('no outbound call expected'); } });
    coverage.init({
        getUser: async (id) => { if (fx.fail) throw fx.fail; return fx.users[id] || null; },
        readSettings: async (orgId) => fx.settings[orgId] || { enabled: false, coverage: 'selected', selectedUserIds: [], tenantId: null },
        orgTenant: async () => fx.tenant,
        loadConfig: async () => CONFIG,
        hasCapability: async () => fx.capable,
        log: { warn: () => {} },
    });
    api = h.serve('/api/teams-notes-settings', require('./teamsNotesSettings'), { user: AMY });
}, { timeout: 120_000 });

after(async () => {
    coverage.init();
    entraToken.init();
    await api.close();
    await closePg();
});

beforeEach(reset);

const get = async () => {
    const res = await api.call('GET', '/api/teams-notes-settings/user/me', { user: AMY });
    assert.equal(res.status, 200, res.text);
    return res.body;
};

test('active when the organisation app import covers the caller; no outbound call', async () => {
    const body = await get();
    assert.deepEqual(body.orgImport, { active: true });
    assert.ok(body.connection, 'the existing fields are still there');
    assert.deepEqual(outbound, []);
});

test('not active: switched off, another tenant, no Meeting Notes, moved to another organisation, deactivated', async () => {
    const changes = [
        () => { fx.settings['org-a'].enabled = false; },
        () => { fx.users['u-amy'].azureTenantId = '99999999-2222-3333-4444-555555555555'; },
        () => { fx.capable = false; },
        () => { fx.users['u-amy'].organizationId = 'org-b'; },
        () => { fx.users['u-amy'].status = 'disabled'; },
        () => { fx.tenant = { ok: false, reason: 'tenant_not_bound' }; },
    ];
    for (const change of changes) {
        reset();
        change();
        assert.deepEqual((await get()).orgImport, { active: false }, change.toString());
    }
    assert.deepEqual(outbound, []);
});

test('a coverage that cannot be read is not active, and the settings still load', async () => {
    fx.fail = new Error('db down');
    const body = await get();
    assert.deepEqual(body.orgImport, { active: false });
});
