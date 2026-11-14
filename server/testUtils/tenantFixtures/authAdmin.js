// @typecheck strict
/**
 * Tenant-isolation fixtures: what an organisation administers under /auth
 * (its groups, invitations, Nextcloud pairing and connector key) and a
 * person's own security key. What a fixture is and how the matrix drives it
 * is in testUtils/tenantFixtures.js, which puts these in its list.
 *
 * The owner of the fixture is made org B's admin; the organisation admin of
 * org A, a plain member of a group of org B, runs every route too
 * (`orgAdminCaller`): administering A is not administering B.
 */

'use strict';

const { makeOwnerOrgAdmin } = require('./organisation');

const userStore = () => require('../../stores/userStore');

/** @type {import('../tenantFixtures').TenantFixture[]} */
const FIXTURES = [
    {
        // A group of org B (auth/admin/groupRoleRoutes.js, auth/admin/featureAccessRoutes.js).
        kind: 'orgGroup',
        mount: '/auth',
        router: () => require('../../auth/adminRoutes'),
        create: async ({ orgId, userId, index }) => {
            await makeOwnerOrgAdmin(userId);
            const id = `g-matrix-group-${index}`;
            await userStore().createGroup({ id, organizationId: orgId, name: `Group ${index}`, permissions: [], roles: [] });
            return id;
        },
        // The member routes name the owner, a person of org B.
        params: { userId: 'u-matrix-b' },
        routes: [
            'PUT /auth/groups/:id', 'PUT /auth/groups/:id/access', 'POST /auth/groups/:id/members',
            'DELETE /auth/groups/:id/members/:userId', 'DELETE /auth/groups/:id',
        ],
        bodies: {
            'PUT /auth/groups/:id': { description: 'A description that must not land here' },
            'PUT /auth/groups/:id/access': { granted: [] },
            'POST /auth/groups/:id/members': { userId: 'u-matrix-b' },
        },
        orgAdminCaller: true,
    },
    {
        // A pending invitation of org B (auth/admin/invitationRoutes.js): the organisation is the caller's own.
        kind: 'orgInvitation',
        mount: '/auth',
        router: () => require('../../auth/adminRoutes'),
        create: async ({ orgId, userId, index }) => {
            await makeOwnerOrgAdmin(userId);
            const invitation = await require('../../stores/invitationStore').createInvitation({ email: `invitee-${index}@matrix.test`, organizationId: orgId, invitedBy: userId, role: 'member' });
            if (!invitation) throw new Error('createInvitation answered nothing');
            return String(invitation.id);
        },
        routes: ['DELETE /auth/invitations/:id'],
        orgAdminCaller: true,
    },
    {
        // Org B's Nextcloud connector settings, taken by the organisation's id: the tenant key
        // (auth/connectorAdminRoutes.js), the user sync, the integrations per group and the
        // connector health (routes/admin/ncSync.js, ncIntegrations.js, connectorHealth.js).
        kind: 'orgConnector',
        mount: '/auth',
        router: () => require('express').Router()
            .use(require('../../auth/connectorAdminRoutes'))
            .use(require('../../routes/admin/ncSync'))
            .use(require('../../routes/admin/ncIntegrations'))
            .use(require('../../routes/admin/connectorHealth')),
        create: async ({ orgId, userId }) => {
            await makeOwnerOrgAdmin(userId);
            return orgId;
        },
        params: { groupId: 'g-matrix-b-plain' },
        routes: [
            'GET /auth/admin/connector/tenants/:orgId/key', 'POST /auth/admin/connector/tenants/:orgId/key',
            'GET /auth/admin/connector-health/:orgId/problems', 'GET /auth/admin/connector-health/:orgId/events',
            'GET /auth/admin/:orgId/nc-sync', 'PUT /auth/admin/:orgId/nc-sync', 'POST /auth/admin/:orgId/nc-sync/run',
            'GET /auth/admin/:orgId/nc-sync/groups', 'GET /auth/admin/:orgId/nc-sync/users',
            'POST /auth/admin/:orgId/nc-onboarding/complete', 'GET /auth/admin/:orgId/nc-integrations',
            'PUT /auth/admin/:orgId/nc-integrations', 'GET /auth/admin/:orgId/nc-integrations/groups',
            'PUT /auth/admin/:orgId/nc-integrations/groups/:groupId', 'DELETE /auth/admin/connector/tenants/:orgId/key',
        ],
        orgAdminCaller: true,
    },
    {
        // A Nextcloud pairing code of org B (auth/ncBindingRoutes.js): revoked only in the caller's own organisation.
        kind: 'ncPairingCode',
        mount: '/auth',
        router: () => require('../../auth/ncBindingRoutes'),
        create: async ({ orgId, userId }) => {
            await makeOwnerOrgAdmin(userId);
            const minted = await userStore().createOrgPairingCode(orgId, { mintedByUserId: userId });
            return String(minted.id);
        },
        routes: ['DELETE /auth/admin/nc-bindings/pairing-codes/:id'],
        orgAdminCaller: true,
    },
    {
        // A pending Nextcloud binding of org B: approved or denied only by an admin of that organisation.
        kind: 'ncPendingBinding',
        mount: '/auth',
        router: () => require('../../auth/ncBindingRoutes'),
        create: async ({ orgId, userId, index }) => {
            await makeOwnerOrgAdmin(userId);
            const row = await userStore().createPendingNcBinding({
                orgId, ncInstanceId: `nc-matrix-${index}`, ncBaseUrl: 'https://nc.matrix.test', ncAdminUid: 'admin', ncAdminEmail: 'nc-admin@matrix.test',
            });
            if (!row) throw new Error('createPendingNcBinding answered nothing');
            return String(row.id);
        },
        routes: ['POST /auth/admin/nc-bindings/:id/deny', 'POST /auth/admin/nc-bindings/:id/approve'],
        orgAdminCaller: true,
    },
    {
        // A security key of user B (auth/securityKeys/managementRoutes.js, mounted at /auth/mfa): the
        // key is looked up under the caller's own account.
        kind: 'securityKey',
        mount: '/auth/mfa',
        router: () => require('../../auth/securityKeys').managementRouter,
        create: async ({ userId, index }) => {
            const key = await userStore().addSecurityKey({
                userId, credentialId: `cred-matrix-${index}`, publicKey: 'pk-matrix', signCount: 0, transports: [], rpId: 'matrix.test', name: `Key ${index}`,
            });
            if (!key) throw new Error('addSecurityKey answered nothing');
            return key.id;
        },
        routes: ['PATCH /auth/mfa/security-keys/:id', 'DELETE /auth/mfa/security-keys/:id'],
        bodies: { 'PATCH /auth/mfa/security-keys/:id': { name: 'A name that must not land here' } },
        orgAdminCaller: true,
    },
];

module.exports = { FIXTURES };
