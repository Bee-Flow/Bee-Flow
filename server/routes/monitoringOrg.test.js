/**
 * routes/monitoringOrg.mts: the one organisation an org-scoped monitoring
 * view reads, over the real admin-dashboard decision (auth/adminOrg.mts) with
 * doubles for the stores; and the `scope` block a response carries.
 *
 *   - an organisation admin of A who sits in an admin group of B reads A, and
 *     naming B is a 403;
 *   - a member without admin rights is a 403;
 *   - a platform admin reads ?orgId, else the organisation on their record,
 *     else 403 `no_organisation`; the Access panel's session key does not
 *     choose.
 *
 * Run: cd server && node --test routes/monitoringOrg.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMonitoringOrg, coveredScope } = require('./monitoringOrg.mts');
const { createAdminOrgGate } = require('../auth/adminOrg.mts');

const USERS = {
    adminA: { id: 'adminA', organizationId: 'orgA', orgRole: 'org_admin', groups: ['gB'] },
    memberA: { id: 'memberA', organizationId: 'orgA', orgRole: 'member', groups: [] },
    op: { id: 'op', role: 'admin', organizationId: 'orgOp' },
    opOrgless: { id: 'opOrgless', role: 'admin', organizationId: '' },
};
const GROUPS = [{ id: 'gB', organizationId: 'orgB', roles: ['org_admin'], permissions: [] }];
const ORGS = { orgA: { name: 'Org A' }, orgB: { name: 'Org B' }, orgOp: { name: 'Operator' } };

const getUser = async (id) => USERS[id] || null;
const { resolveAdminOrgId } = createAdminOrgGate({
    isSuperAdmin: (req) => !!(req.session?.isAdmin || req.session?.user?.role === 'admin'),
    evalOrgAdmin: (user, groups, orgId) => (user.organizationId === orgId && user.orgRole === 'org_admin')
        || groups.some((g) => (user.groups || []).includes(g.id) && g.organizationId === orgId && g.roles.includes('org_admin')),
    getUser,
    getAllGroups: async () => GROUPS,
    getOrganization: async (id) => ORGS[id] || null,
});
const { monitoringOrgId } = createMonitoringOrg({ resolveAdminOrgId, getUser });

const as = (id, { query = {}, ...extra } = {}) => ({
    session: { isAuthenticated: true, user: { id, role: USERS[id]?.role }, isAdmin: USERS[id]?.role === 'admin', ...extra },
    query,
});
const refused = (status, code) => (e) => e?.status === status && e?.code === code;

test('an organisation admin of A in an admin group of B reads A, and naming B is refused', async () => {
    assert.equal(await monitoringOrgId(as('adminA')), 'orgA');
    assert.equal(await monitoringOrgId(as('adminA', { query: { orgId: 'orgA' } })), 'orgA');
    await assert.rejects(monitoringOrgId(as('adminA', { query: { orgId: 'orgB' } })), refused(403, 'org_admin_required'));
});

test('a member without admin rights is refused', async () => {
    await assert.rejects(monitoringOrgId(as('memberA')), refused(403, 'org_admin_required'));
});

test('a platform admin reads ?orgId, else their own organisation; the Access panel\'s session key does not choose', async () => {
    assert.equal(await monitoringOrgId(as('op', { query: { orgId: 'orgB' } })), 'orgB');
    assert.equal(await monitoringOrgId(as('op', { adminSelectedOrgId: 'orgA' })), 'orgOp');
    assert.equal(await monitoringOrgId(as('op')), 'orgOp');
    await assert.rejects(monitoringOrgId(as('op', { query: { orgId: 'orgGone' } })), refused(404, 'organization_not_found'));
});

test('a platform admin with no organisation anywhere is refused: these views read one organisation', async () => {
    await assert.rejects(monitoringOrgId(as('opOrgless')), refused(403, 'no_organisation'));
});

test('coveredScope names one organisation, all of them, or neither; a failed name lookup is a missing name', async () => {
    const lookup = async (id) => ORGS[id] || null;
    assert.deepEqual(await coveredScope('orgA', false, lookup), { organizationId: 'orgA', organizationName: 'Org A', allOrganizations: false });
    assert.deepEqual(await coveredScope(null, true, lookup), { organizationId: null, organizationName: null, allOrganizations: true });
    assert.deepEqual(await coveredScope(null, false, lookup), { organizationId: null, organizationName: null, allOrganizations: false });
    const boom = () => { throw new Error('organizations table gone'); };
    assert.deepEqual(await coveredScope('orgA', false, boom), { organizationId: 'orgA', organizationName: null, allOrganizations: false });
});
