'use strict';
/**
 * The cross-tenant guard of organisation-wide import: every reason of the
 * coverage rule, a member of another organisation that shares the tenant,
 * another tenant, a deactivated or moved user, a revoked capability, the
 * tenant link moving after it was switched on, and the counts.
 *
 * Run: cd server && node --test core/meetingNotes/teamsAppImport/coverage.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const coverage = require('./coverage.mts');

const T = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-2222-3333-4444-555555555555';
const OID = 'aaaaaaaa-0000-0000-0000-000000000001';
const CONFIG = { providers: { microsoft: { clientId: 'cccccccc-0000-0000-0000-000000000001', clientSecret: 'fixture-not-a-secret', tenantId: 'common' } } };
const ON = { enabled: true, coverage: 'selected', selectedUserIds: ['u-amy', 'u-b'], tenantId: T, enabledAt: null, enabledBy: null, updatedAt: null, updatedBy: null };
const BOUND = { ok: true, tenantId: T, source: 'directory_binding' };
const AMY = { id: 'u-amy', status: 'active', organizationId: 'org-a', azureTenantId: T.toUpperCase(), azureUserId: OID };

const cov = (over = {}) => coverage.coverageFor({
    user: AMY, orgId: 'org-a', settings: ON, orgTenant: BOUND, config: CONFIG, hasCapability: async () => true, ...over,
});
const reason = async (over) => { const r = await cov(over); return r.covered ? 'covered' : r.reason; };

test.afterEach(() => { delete process.env.TEAMS_APP_IMPORT; coverage.init(); });

test('a covered member: the tenant and the object id', async () => {
    assert.deepEqual(await cov(), { covered: true, tenantId: T, objectId: OID });
});

test('every reason of the rule, in order', async () => {
    process.env.TEAMS_APP_IMPORT = '0';
    assert.equal(await reason(), 'instance_disabled');
    delete process.env.TEAMS_APP_IMPORT;
    assert.equal(await reason({ settings: { ...ON, enabled: false } }), 'not_enabled');
    assert.equal(await reason({ orgTenant: { ok: false, reason: 'tenant_mismatch_sso' } }), 'tenant_not_bound');
    assert.equal(await reason({ settings: { ...ON, tenantId: OTHER } }), 'tenant_changed');
    assert.equal(await reason({ settings: { ...ON, tenantId: null } }), 'tenant_changed');
    assert.equal(await reason({ user: null }), 'inactive');
    assert.equal(await reason({ user: { ...AMY, status: 'deactivated' } }), 'inactive');
    assert.equal(await reason({ user: { ...AMY, organizationId: 'org-b' } }), 'other_organisation');
    assert.equal(await reason({ orgId: null }), 'tenant_not_bound');
    assert.equal(await reason({ user: { ...AMY, azureTenantId: null } }), 'no_identity');
    assert.equal(await reason({ user: { ...AMY, azureUserId: 'not-a-guid' } }), 'no_identity');
    assert.equal(await reason({ user: { ...AMY, azureTenantId: OTHER } }), 'other_tenant');
    assert.equal(await reason({ settings: { ...ON, selectedUserIds: ['u-b'] } }), 'not_selected');
    assert.equal(await reason({ settings: { ...ON, coverage: 'all', selectedUserIds: [] } }), 'covered');
    assert.equal(await reason({ hasCapability: async () => false }), 'no_access');
    assert.equal(await reason({ hasCapability: async () => { throw new Error('entitlements down'); } }), 'no_access', 'a failed check is a refusal');
    assert.equal(await reason({ access: false }), 'no_access');
    assert.equal(await reason({ config: { providers: {} } }), 'app_not_configured');
});

test("a member of org B with tenant T is not covered for org A, even when A's settings select them", async () => {
    const bMember = { id: 'u-b', status: 'active', organizationId: 'org-b', azureTenantId: T, azureUserId: 'bbbbbbbb-0000-0000-0000-000000000002' };
    assert.equal(await reason({ user: bMember }), 'other_organisation');
    assert.equal(await reason({ user: bMember, settings: { ...ON, coverage: 'all' } }), 'other_organisation');
});

/** coverageForUser with stored state; `fx` is what the stores answer. */
function setupStored(fx) {
    const calls = { orgTenant: [], settings: [], users: 0 };
    coverage.init({
        readSettings: async (orgId, opts) => { calls.settings.push([orgId, opts]); return fx.settings[orgId] || { ...ON, enabled: false }; },
        orgTenant: async (orgId, opts) => { calls.orgTenant.push([orgId, opts]); return fx.tenants[orgId] || { ok: false, reason: 'tenant_not_bound' }; },
        getUser: async (id) => { calls.users++; return fx.users[id] || null; },
        loadConfig: async () => CONFIG,
        hasCapability: async (_cap, { userId }) => fx.capable.has(userId),
        log: { warn: () => {} },
    });
    return calls;
}

test('coverageForUser reads everything now; a deactivated, moved or revoked user is not covered; fresh is passed on', async () => {
    const fx = { settings: { 'org-a': ON }, tenants: { 'org-a': BOUND }, users: { 'u-amy': AMY }, capable: new Set(['u-amy']) };
    const calls = setupStored(fx);
    assert.equal((await coverage.coverageForUser('u-amy', 'org-a', { fresh: true })).covered, true);
    assert.deepEqual(calls.settings[0], ['org-a', { fresh: true }]);
    assert.deepEqual(calls.orgTenant[0], ['org-a', { fresh: true }]);
    fx.users['u-amy'] = { ...AMY, status: 'inactive' };
    assert.equal((await coverage.coverageForUser('u-amy', 'org-a')).reason, 'inactive');
    fx.users['u-amy'] = { ...AMY, organizationId: 'org-b' };
    assert.equal((await coverage.coverageForUser('u-amy', 'org-a')).reason, 'other_organisation');
    fx.users['u-amy'] = AMY;
    fx.capable.clear();
    assert.equal((await coverage.coverageForUser('u-amy', 'org-a')).reason, 'no_access');
    assert.equal((await coverage.coverageForUser('u-amy', null)).reason, 'other_organisation');
});

test('switched off: answered from the setting alone, nothing else is read', async () => {
    const fx = { settings: {}, tenants: { 'org-a': BOUND }, users: { 'u-amy': AMY }, capable: new Set(['u-amy']) };
    const calls = setupStored(fx);
    assert.equal((await coverage.coverageForUser('u-amy', 'org-a')).reason, 'not_enabled');
    assert.equal(calls.orgTenant.length, 0);
    assert.equal(calls.users, 0);
});

test('tenant_changed after the binding moved to another tenant', async () => {
    const fx = { settings: { 'org-a': ON }, tenants: { 'org-a': { ok: true, tenantId: OTHER, source: 'directory_binding' } }, users: { 'u-amy': { ...AMY, azureTenantId: OTHER } }, capable: new Set(['u-amy']) };
    setupStored(fx);
    assert.equal((await coverage.coverageForUser('u-amy', 'org-a')).reason, 'tenant_changed');
});

test('orgImportActive: the caller in their own organisation only', async () => {
    const fx = { settings: { 'org-a': ON }, tenants: { 'org-a': BOUND }, users: { 'u-amy': AMY, 'u-zed': { ...AMY, id: 'u-zed', organizationId: null } }, capable: new Set(['u-amy', 'u-zed']) };
    setupStored(fx);
    assert.equal(await coverage.orgImportActive('u-amy'), true);
    assert.equal(await coverage.orgImportActive('u-zed'), false);
    assert.equal(await coverage.orgImportActive('u-none'), false);
});

test('counts: what the setting would cover against the verified tenant, and who is covered now', async () => {
    coverage.init({ hasCapability: async (_cap, { userId }) => userId !== 'u-noaccess', log: { warn: () => {} } });
    const row = (userId, tid, oid) => ({ userId, displayName: null, username: userId, azureTenantId: tid, azureUserId: oid, credentialStatus: null, credentialScope: null });
    const rows = [
        row('u-amy', T, OID), row('u-noid', null, null), row('u-other', OTHER, OID), row('u-unsel', T, OID), row('u-noaccess', T, OID),
    ];
    const settings = { ...ON, selectedUserIds: ['u-amy', 'u-noid', 'u-other', 'u-noaccess'] };
    const on = await coverage.evaluateMembers({ orgId: 'org-a', rows, settings, orgTenant: BOUND, config: CONFIG });
    assert.deepEqual(on.counts, { eligible: 5, covered: 1, withoutIdentity: 1, otherTenant: 1, withoutAccess: 1, notSelected: 1 });
    assert.deepEqual([...on.covered], ['u-amy']);
    const off = await coverage.evaluateMembers({ orgId: 'org-a', rows, settings: { ...settings, enabled: false }, orgTenant: BOUND, config: CONFIG });
    assert.equal(off.counts.covered, 0);
    assert.equal(off.counts.withoutIdentity, 1, 'the preview still counts');
    assert.equal(off.covered.size, 0);
});

test('updateAppImport: too many, not a member (a count, never an id), deduplicated', async () => {
    process.env.TEAMS_APP_IMPORT_MAX_SELECTED_USERS = '2';
    try {
        const writes = [];
        coverage.init({
            listOrgMemberRows: async () => ({ rows: [{ userId: 'u-amy' }, { userId: 'u-bob' }], truncated: false }),
            readSettings: async () => ({ ...ON, enabled: false }),
            writeSettings: async (a) => { writes.push(a); return a.next; },
            orgTenant: async () => BOUND,
            loadConfig: async () => CONFIG,
            hasCapability: async () => true,
            log: { warn: () => {} },
        });
        const tooMany = await coverage.updateAppImport({ orgId: 'org-a', actorId: 'u-admin', body: { enabled: false, coverage: 'selected', selectedUserIds: ['u-amy', 'u-bob', 'u-cy'] } });
        assert.deepEqual([tooMany.status, tooMany.code], [400, 'too_many_selected']);
        const outsider = await coverage.updateAppImport({ orgId: 'org-a', actorId: 'u-admin', body: { enabled: false, coverage: 'selected', selectedUserIds: ['u-amy', 'org-b-member'] } });
        assert.deepEqual([outsider.status, outsider.code], [400, 'not_a_member']);
        assert.ok(!outsider.message.includes('org-b-member'), 'the message counts, never names');
        assert.match(outsider.message, /^1 of/);
        assert.equal(writes.length, 0);
        const dup = await coverage.updateAppImport({ orgId: 'org-a', actorId: 'u-admin', body: { enabled: false, coverage: 'selected', selectedUserIds: ['u-amy', 'u-amy', 'u-bob'] } });
        assert.equal(dup.ok, true, 'two distinct ids are within the cap');
        assert.deepEqual(writes[0].next.selectedUserIds, ['u-amy', 'u-bob']);
    } finally {
        delete process.env.TEAMS_APP_IMPORT_MAX_SELECTED_USERS;
    }
});
