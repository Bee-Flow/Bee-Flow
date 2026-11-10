/**
 * auth/adminOrg.mts: which organisation the admin dashboard acts on, built
 * with fake collaborators and the real strict org-admin check.
 * Run: cd server && node --test auth/adminOrg.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdminOrgGate, ADMIN_ORG_GATE } = require('./adminOrg.mts');
const { readGate } = require('./gateMeta');
const { _evalOrgAdmin } = require('./permissions');

const ORGS = new Set(['org-a', 'org-b']);
const GROUPS = [
    { id: 'g-a-admins', organizationId: 'org-a', permissions: ['all'] },
    { id: 'g-b-admins', organizationId: 'org-b', roles: ['org_admin'] },
    { id: 'g-b-staff', organizationId: 'org-b', permissions: ['read'] },
];
const USERS = {
    orgAdminA: { id: 'orgAdminA', organizationId: 'org-a', orgRole: 'org_admin', groups: [] },
    // Admin of org-a by orgRole and of org-b through a group in org-b.
    orgAdminAGroupAdminB: { id: 'orgAdminAGroupAdminB', organizationId: 'org-a', orgRole: 'org_admin', groups: ['g-b-admins'] },
    // A plain member of org-a who is admin of org-b through a group only.
    memberAGroupAdminB: { id: 'memberAGroupAdminB', organizationId: 'org-a', orgRole: 'member', groups: ['g-b-admins'] },
    // A plain member of org-a who is admin of org-a through a group in org-a.
    memberAGroupAdminA: { id: 'memberAGroupAdminA', organizationId: 'org-a', orgRole: 'member', groups: ['g-a-admins'] },
    memberA: { id: 'memberA', organizationId: 'org-a', orgRole: 'member', groups: ['g-b-staff'] },
    noHomeOrg: { id: 'noHomeOrg', organizationId: null, orgRole: 'org_admin', groups: ['g-b-admins'] },
};

function build() {
    return createAdminOrgGate({
        isSuperAdmin: (req) => !!(req.session?.isAdmin || req.session?.user?.role === 'admin'),
        evalOrgAdmin: _evalOrgAdmin,
        getUser: async (id) => USERS[id] || null,
        getAllGroups: async () => GROUPS,
        getOrganization: async (id) => (ORGS.has(id) ? { id } : null),
    });
}

function platformReq({ query = {}, selected } = {}) {
    const session = { isAuthenticated: true, isAdmin: true, user: { id: 'admin', role: 'admin' } };
    if (selected !== undefined) session.adminSelectedOrgId = selected;
    return { session, query };
}

function userReq(id, query = {}) {
    // The session carries a stale organizationId on purpose: the user row decides.
    return { session: { isAuthenticated: true, user: { id, organizationId: 'org-b' } }, query };
}

async function statusOf(promise) {
    try {
        await promise;
        return 'resolved';
    } catch (err) {
        return err.status;
    }
}

async function runMiddleware(gate, req) {
    let nextArg = 'not called';
    await gate.requireAdminOrg(req, {}, (err) => { nextArg = err; });
    return nextArg;
}

test('platform admin without orgId: null, meaning all organisations', async () => {
    assert.equal(await build().resolveAdminOrgId(platformReq()), null);
});

test('platform admin with ?orgId: that organisation, whatever the session holds', async () => {
    const gate = build();
    assert.equal(await gate.resolveAdminOrgId(platformReq({ query: { orgId: 'org-b' } })), 'org-b');
    assert.equal(await gate.resolveAdminOrgId(platformReq({ query: { orgId: 'org-b' }, selected: 'org-a' })), 'org-b');
});

test('the Access panel\'s session key never names the dashboard organisation', async () => {
    const gate = build();
    // The Access panel stores its entitlement context there on its own; only ?orgId chooses.
    assert.equal(await gate.resolveAdminOrgId(platformReq({ selected: 'org-a' })), null);
    // An organisation deleted after it was stored there is not a 404 either.
    assert.equal(await gate.resolveAdminOrgId(platformReq({ selected: 'org-x' })), null);
});

test('platform admin naming an organisation that does not exist: 404', async () => {
    assert.equal(await statusOf(build().resolveAdminOrgId(platformReq({ query: { orgId: 'org-x' } }))), 404);
});

test('a repeated ?orgId is a 400', async () => {
    assert.equal(await statusOf(build().resolveAdminOrgId(platformReq({ query: { orgId: ['org-a', 'org-b'] } }))), 400);
    assert.equal(await statusOf(build().resolveAdminOrgId(userReq('orgAdminA', { orgId: ['org-a'] }))), 400);
});

test('organisation admin: their home organisation, with or without a matching ?orgId', async () => {
    const gate = build();
    assert.equal(await gate.resolveAdminOrgId(userReq('orgAdminA')), 'org-a');
    assert.equal(await gate.resolveAdminOrgId(userReq('orgAdminA', { orgId: 'org-a' })), 'org-a');
});

test('admin rights through a group in the home organisation count for that organisation', async () => {
    assert.equal(await build().resolveAdminOrgId(userReq('memberAGroupAdminA')), 'org-a');
});

test('organisation admin naming another organisation: 403', async () => {
    assert.equal(await statusOf(build().resolveAdminOrgId(userReq('orgAdminA', { orgId: 'org-b' }))), 403);
});

test('admin of another organisation through a group: that organisation is not given, home only', async () => {
    const gate = build();
    assert.equal(await gate.resolveAdminOrgId(userReq('orgAdminAGroupAdminB')), 'org-a');
    assert.equal(await statusOf(gate.resolveAdminOrgId(userReq('orgAdminAGroupAdminB', { orgId: 'org-b' }))), 403);
    assert.equal(await statusOf(gate.resolveAdminOrgId(userReq('memberAGroupAdminB'))), 403);
    assert.equal(await statusOf(gate.resolveAdminOrgId(userReq('memberAGroupAdminB', { orgId: 'org-b' }))), 403);
});

test('an admin orgRole without a home organisation: 403', async () => {
    assert.equal(await statusOf(build().resolveAdminOrgId(userReq('noHomeOrg'))), 403);
});

test('a plain member: 403', async () => {
    assert.equal(await statusOf(build().resolveAdminOrgId(userReq('memberA'))), 403);
});

test('a session whose user row is gone: 403', async () => {
    assert.equal(await statusOf(build().resolveAdminOrgId(userReq('deleted'))), 403);
});

test('the middleware stores the resolved organisation on req.adminOrgId', async () => {
    const gate = build();
    const orgReq = userReq('orgAdminA');
    assert.equal(await runMiddleware(gate, orgReq), undefined);
    assert.equal(orgReq.adminOrgId, 'org-a');
    const allReq = platformReq();
    assert.equal(await runMiddleware(gate, allReq), undefined);
    assert.equal(allReq.adminOrgId, null);
});

test('the middleware hands a refusal to next and leaves req.adminOrgId unset', async () => {
    const req = userReq('memberA');
    const err = await runMiddleware(build(), req);
    assert.equal(err.status, 403);
    assert.equal(err.code, 'org_admin_required');
    assert.equal('adminOrgId' in req, false);
});

test('no authenticated session: the middleware answers 401', async () => {
    const gate = build();
    for (const req of [{}, { session: {} }, { session: { isAuthenticated: false, user: { id: 'orgAdminA' } } }, { session: { isAuthenticated: true } }]) {
        const err = await runMiddleware(gate, req);
        assert.equal(err.status, 401);
        assert.equal('adminOrgId' in req, false);
    }
});

test('the middleware carries the scope tag the route contract reads', () => {
    assert.deepEqual(readGate(build().requireAdminOrg), { axis: 'scope', kind: 'adminOrg' });
    assert.deepEqual({ ...ADMIN_ORG_GATE }, { axis: 'scope', kind: 'adminOrg' });
    const { chainClass } = require('./routeContract');
    assert.deepEqual(chainClass({ method: 'GET', path: '/x', gates: [readGate(build().requireAdminOrg)], middleware: [] }), { gate: 'scope', via: 'adminOrg' });
});

test('the permissions barrel exports the gate built with the real collaborators', () => {
    const permissions = require('./permissions');
    assert.equal(typeof permissions.resolveAdminOrgId, 'function');
    assert.deepEqual(readGate(permissions.requireAdminOrg), { axis: 'scope', kind: 'adminOrg' });
});
