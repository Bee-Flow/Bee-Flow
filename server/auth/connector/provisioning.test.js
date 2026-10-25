/**
 * Unit tests for connector/provisioning.js: the provisioning-mode policy, the
 * secondary-admin selection and applyNcDefaultPlanIfConfigured's fallback
 * chain (nc_recommended plan -> (existing subscription? keep) -> default org
 * plan -> community fallback). Every applied plan writes an access-audit row
 * and emits bootstrap.plan_applied + resolves; the nothing-could-be-applied
 * path emits bootstrap.community_fallback; failures emit
 * bootstrap.plan_apply_failed and NEVER throw out of bootstrap.
 *
 * Also ensureOrgAdminUser's nc_uid regression (see the section header below).
 *
 * Dependencies are stubbed via require-cache injection scoped to
 * provisioning.js and serviceDeps.js (pattern:
 * adminRoutes.users.authz.test.js): no DB, no fetch.
 *
 * Run: cd server && node --test auth/connector/provisioning.test.js
 */

const test = require('node:test');
const { beforeEach } = test;
const assert = require('node:assert/strict');
const Module = require('module');

// ── Mutable fixtures ─────────────────────────────────────────────────
const fx = {
    ncPlan: null,             // getDefaultNcPlan() result
    existingSub: null,        // getOrgSubscription() result
    defaultPlanId: null,      // getDefaultOrgPlanId() result
    setSubThrows: false,
    calls: [],                // [name, ...args] recorder
};

// Users and orgs for the ensureOrgAdminUser (nc_uid) tests.
const state = { usersByEmail: new Map(), usersById: new Map(), orgs: new Map(), updates: [] };

function callsOf(name) {
    return fx.calls.filter(c => c[0] === name);
}

const MOCKS = {
    '../../stores/userStore': {
        getDefaultNcPlan: async () => fx.ncPlan,
        getOrgSubscription: async (orgId) => { fx.calls.push(['getOrgSubscription', orgId]); return fx.existingSub; },
        getDefaultOrgPlanId: async () => fx.defaultPlanId,
        setOrgSubscription: async (orgId, data) => {
            fx.calls.push(['setOrgSubscription', orgId, data]);
            if (fx.setSubThrows) throw new Error('boom: subscription write failed');
            return true;
        },
        logAccessAudit: async (...args) => { fx.calls.push(['logAccessAudit', ...args]); },
        getUserByEmail: async (email) => state.usersByEmail.get(email) || null,
        getUser: async (id) => state.usersById.get(id) || null,
        getOrganization: async (id) => state.orgs.get(id) || null,
        updateUser: async (id, updates) => { state.updates.push({ id, updates }); },
        createUserWithSeatCheck: async () => ({ created: true }),
    },
    '../../stores/configStore': {
        getConfig: async () => null,
        getSecret: async () => null,
        setSecretIfAbsent: async (_k, v) => v,
    },
    '../connectorJwt': {
        invalidateTenantKeyCache: () => { },
    },
    '../../services/planEntitlements': {
        applyPlanToOrg: async (...args) => { fx.calls.push(['applyPlanToOrg', ...args]); },
    },
    '../../services/orgHealth': {
        problem: (code, opts) => { fx.calls.push(['problem', code, opts]); return Promise.resolve(); },
        event: (code, opts) => { fx.calls.push(['event', code, opts]); return Promise.resolve(); },
        resolve: (subject, codes, opts) => { fx.calls.push(['resolve', subject, codes, opts]); return Promise.resolve(0); },
        touchLiveness: (orgId, kind, opts) => { fx.calls.push(['touchLiveness', orgId, kind, opts]); return Promise.resolve(); },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:connector-provisioning:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /auth[\\/]connector[\\/](provisioning|serviceDeps)\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const helpers = require('./provisioning');

test.after(() => { Module._resolveFilename = originalResolve; });

function resetFx() {
    fx.ncPlan = null;
    fx.existingSub = null;
    fx.defaultPlanId = null;
    fx.setSubThrows = false;
    fx.calls = [];
}

test('defaultProvisioningMode: official Cloud hosts default to open', () => {
    const prev = process.env.SERVER_PUBLIC_HOST;
    process.env.SERVER_PUBLIC_HOST = 'server.beeflow.nl';
    assert.equal(helpers.defaultProvisioningMode(), 'open');
    process.env.SERVER_PUBLIC_HOST = 'server.dev.beeflow.nl';
    assert.equal(helpers.defaultProvisioningMode(), 'open');
    // case-insensitive
    process.env.SERVER_PUBLIC_HOST = 'Server.BeeFlow.NL';
    assert.equal(helpers.defaultProvisioningMode(), 'open');
    if (prev === undefined) delete process.env.SERVER_PUBLIC_HOST; else process.env.SERVER_PUBLIC_HOST = prev;
});

test('defaultProvisioningMode: self-host / unset fails closed to pairing_only', () => {
    const prev = process.env.SERVER_PUBLIC_HOST;
    process.env.SERVER_PUBLIC_HOST = 'ai.acme.example';
    assert.equal(helpers.defaultProvisioningMode(), 'pairing_only');
    delete process.env.SERVER_PUBLIC_HOST;
    assert.equal(helpers.defaultProvisioningMode(), 'pairing_only');
    if (prev !== undefined) process.env.SERVER_PUBLIC_HOST = prev;
});

test('PROVISIONING_MODES is the closed set the admin route also enforces', () => {
    assert.deepEqual(helpers.PROVISIONING_MODES, ['open', 'pairing_only']);
});

// _selectSecondaryAdmins — which extra NC admins get provisioned besides the
// primary (the rest of the `admin` group, so any admin can onboard).
const sel = helpers._selectSecondaryAdmins;

test('selectSecondaryAdmins: drops the primary, keeps the rest (lower-cased email)', () => {
    const admins = [
        { uid: 'alice', email: 'Alice@EX.com', displayName: 'Alice' },
        { uid: 'bob', email: 'bob@ex.com', displayName: 'Bob' },
    ];
    assert.deepEqual(sel(admins, 'alice'), [{ uid: 'bob', email: 'bob@ex.com', displayName: 'Bob' }]);
});

test('selectSecondaryAdmins: drops email-less and blank-uid entries, dedups by uid', () => {
    const admins = [
        { uid: 'bob', email: 'bob@ex.com' },
        { uid: 'carol', email: '' },          // no email → dropped
        { uid: '', email: 'x@ex.com' },        // no uid → dropped
        { uid: 'bob', email: 'dupe@ex.com' },  // duplicate uid → dropped
    ];
    assert.deepEqual(sel(admins, 'alice'), [{ uid: 'bob', email: 'bob@ex.com', displayName: 'bob' }]);
});

test('selectSecondaryAdmins: missing/empty list → []', () => {
    assert.deepEqual(sel(undefined, 'alice'), []);
    assert.deepEqual(sel([], 'alice'), []);
    assert.deepEqual(sel(null, 'alice'), []);
});

test('selectSecondaryAdmins: displayName falls back to uid', () => {
    assert.deepEqual(sel([{ uid: 'bob', email: 'bob@ex.com' }], 'alice'),
        [{ uid: 'bob', email: 'bob@ex.com', displayName: 'bob' }]);
});

// ═══ applyNcDefaultPlanIfConfigured ══════════════════════════════════

test('nc_recommended plan present → subscription + entitlements reset + audit + emits', async () => {
    resetFx();
    fx.ncPlan = { id: 'plan-nc', name: 'NC Enterprise' };
    await helpers.applyNcDefaultPlanIfConfigured('org1', 'fresh_org');

    assert.deepEqual(callsOf('setOrgSubscription')[0].slice(1), ['org1', { plan_id: 'plan-nc', status: 'active' }]);
    assert.deepEqual(callsOf('applyPlanToOrg')[0].slice(1), ['org1', 'plan-nc', { mode: 'reset' }]);

    const audit = callsOf('logAccessAudit')[0];
    assert.equal(audit[1], 'nc_default_plan_applied');
    assert.equal(audit[2], 'organization');
    assert.equal(audit[3], 'org1');
    assert.equal(audit[4], 'system:connector_bootstrap');
    assert.deepEqual(audit[6], { plan_id: 'plan-nc', source: 'fresh_org', fallback: false });
    assert.equal(audit[7], 'org1');

    const ev = callsOf('event')[0];
    assert.equal(ev[1], 'bootstrap.plan_applied');
    assert.deepEqual(ev[2].meta, { planId: 'plan-nc', fallback: false });

    const rs = callsOf('resolve')[0];
    assert.equal(rs[1], 'org1');
    assert.deepEqual(rs[2], ['bootstrap.community_fallback', 'chat.subscription_blocked']);

    assert.equal(callsOf('problem').length, 0);
});

test('no nc plan + subscription already exists → no-op (no write, no audit, no emits)', async () => {
    resetFx();
    fx.existingSub = { plan_id: 'plan-existing', status: 'active' };
    await helpers.applyNcDefaultPlanIfConfigured('org2', 'pairing_code');

    assert.equal(callsOf('setOrgSubscription').length, 0);
    assert.equal(callsOf('applyPlanToOrg').length, 0);
    assert.equal(callsOf('logAccessAudit').length, 0);
    assert.equal(callsOf('event').length, 0);
    assert.equal(callsOf('problem').length, 0);
});

test('no nc plan + no subscription + default plan → fallback subscription WITHOUT applyPlanToOrg', async () => {
    resetFx();
    fx.defaultPlanId = 'plan-free';
    await helpers.applyNcDefaultPlanIfConfigured('org3', 'email_verification');

    assert.deepEqual(callsOf('setOrgSubscription')[0].slice(1), ['org3', { plan_id: 'plan-free', status: 'active' }]);
    // Fallback path is plan-defaults only — entitlements must not be reset.
    assert.equal(callsOf('applyPlanToOrg').length, 0);

    const audit = callsOf('logAccessAudit')[0];
    assert.equal(audit[1], 'nc_default_plan_applied');
    assert.deepEqual(audit[6], { plan_id: 'plan-free', source: 'email_verification', fallback: true });

    const ev = callsOf('event')[0];
    assert.equal(ev[1], 'bootstrap.plan_applied');
    assert.deepEqual(ev[2].meta, { planId: 'plan-free', fallback: true });
    assert.deepEqual(callsOf('resolve')[0][2], ['bootstrap.community_fallback', 'chat.subscription_blocked']);
    assert.equal(callsOf('problem').length, 0);
});

test('no nc plan, no subscription, no default → community_fallback problem, nothing applied', async () => {
    resetFx();
    await helpers.applyNcDefaultPlanIfConfigured('org4', 'fresh_org');

    assert.equal(callsOf('setOrgSubscription').length, 0);
    assert.equal(callsOf('logAccessAudit').length, 0);
    assert.equal(callsOf('event').length, 0);

    const p = callsOf('problem')[0];
    assert.equal(p[1], 'bootstrap.community_fallback');
    assert.equal(p[2].orgId, 'org4');
    assert.deepEqual(p[2].meta, { source: 'fresh_org', reason: 'no_nc_recommended_plan_and_no_default' });
});

test('subscription write throws → never throws out of bootstrap, emits plan_apply_failed', async () => {
    resetFx();
    fx.ncPlan = { id: 'plan-nc', name: 'NC Enterprise' };
    fx.setSubThrows = true;
    await assert.doesNotReject(helpers.applyNcDefaultPlanIfConfigured('org5', 'fresh_org'));

    const p = callsOf('problem')[0];
    assert.equal(p[1], 'bootstrap.plan_apply_failed');
    assert.equal(p[2].orgId, 'org5');
    assert.equal(p[2].meta.source, 'fresh_org');
    // No success artefacts on the failure path.
    assert.equal(callsOf('logAccessAudit').length, 0);
    assert.equal(callsOf('event').length, 0);
});

// ═══ ensureOrgAdminUser: nc_uid must never be overwritten ═══════════
//
// Regression: the guard read `user.ncUid` (camelCase) on the RAW row that
// userStore.getUserByEmail returns, whose column is `nc_uid` — so the guard
// was always true and EVERY bootstrap stamped admins[0]'s uid over the
// existing binding. connectorJwt prefers the stored uid when minting the
// session, so an affected user's WebDAV calls impersonated the wrong
// Nextcloud account: a cross-user data path, not just a denial.

const ORG = { id: 'org-1' };
const EMAIL = 'admin@example.com';

function seedExistingAdmin(row = {}) {
    const user = {
        id: 'u-admin', email: EMAIL, organizationId: ORG.id, orgRole: 'org_admin',
        provider: 'nextcloud_connector',
        ...row,
    };
    state.usersByEmail.set(EMAIL, user);
    state.usersById.set(user.id, user);
    return user;
}

beforeEach(() => {
    state.usersByEmail.clear();
    state.usersById.clear();
    state.orgs.clear();
    state.updates.length = 0;
});

test('an existing snake_case nc_uid is never overwritten by a re-bootstrap', async () => {
    seedExistingAdmin({ nc_uid: 'alice' });
    await helpers.ensureOrgAdminUser(ORG, {
        ncAdminEmail: EMAIL, ncAdminUid: 'bob', ncAdminDisplayName: 'Bob',
    });
    const ncUidWrites = state.updates.filter(u => 'ncUid' in u.updates);
    assert.deepEqual(ncUidWrites, [],
        `re-bootstrap overwrote nc_uid: ${JSON.stringify(state.updates)} — `
        + 'the stored uid wins in connectorJwt, so this rebinds the user to another NC account');
});

test('a camelCase-only ncUid alias also blocks the overwrite', async () => {
    seedExistingAdmin({ ncUid: 'alice' });
    await helpers.ensureOrgAdminUser(ORG, {
        ncAdminEmail: EMAIL, ncAdminUid: 'bob',
    });
    const ncUidWrites = state.updates.filter(u => 'ncUid' in u.updates);
    assert.deepEqual(ncUidWrites, []);
});

test('a user with no nc uid at all gets bound to the bootstrapping admin uid', async () => {
    seedExistingAdmin();
    await helpers.ensureOrgAdminUser(ORG, {
        ncAdminEmail: EMAIL, ncAdminUid: 'bob',
    });
    const ncUidWrites = state.updates.filter(u => 'ncUid' in u.updates);
    assert.equal(ncUidWrites.length, 1);
    assert.equal(ncUidWrites[0].updates.ncUid, 'bob');
});

test('orgRole is still repaired on re-bootstrap (the fix must not freeze other updates)', async () => {
    seedExistingAdmin({ nc_uid: 'alice', orgRole: 'agent_editor' });
    await helpers.ensureOrgAdminUser(ORG, {
        ncAdminEmail: EMAIL, ncAdminUid: 'bob',
    });
    assert.equal(state.updates.length, 1);
    assert.deepEqual(state.updates[0].updates, { orgRole: 'org_admin' });
});

test('resolveProvisioningMode fails closed to pairing_only when the stored mode cannot be read, even on an open-by-default host', async () => {
    const prevHost = process.env.SERVER_PUBLIC_HOST;
    const prevEnv = process.env.BEEFLOW_CONNECTOR_PROVISIONING;
    const prevGet = MOCKS['../../stores/configStore'].getConfig;
    process.env.SERVER_PUBLIC_HOST = 'server.beeflow.nl';
    delete process.env.BEEFLOW_CONNECTOR_PROVISIONING;
    try {
        assert.equal(await helpers.resolveProvisioningMode(), 'open');
        MOCKS['../../stores/configStore'].getConfig = async () => { throw new Error('db down'); };
        assert.equal(await helpers.resolveProvisioningMode(), 'pairing_only');
    } finally {
        MOCKS['../../stores/configStore'].getConfig = prevGet;
        if (prevHost === undefined) delete process.env.SERVER_PUBLIC_HOST; else process.env.SERVER_PUBLIC_HOST = prevHost;
        if (prevEnv !== undefined) process.env.BEEFLOW_CONNECTOR_PROVISIONING = prevEnv;
    }
});
