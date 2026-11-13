// @typecheck strict
/**
 * Tenant-isolation fixtures: the people of an organisation and the
 * organisation itself. What a fixture is and how the matrix drives
 * it is in testUtils/tenantFixtures.js, which puts these in its list.
 */

'use strict';

/**
 * Make the owner of the fixture org B's admin, so the first route of an
 * org-admin-gated kind answers 200 for them.
 * @param {string} userId
 */
async function makeOwnerOrgAdmin(userId) {
    await require('../../stores/userStore').updateUser(userId, { orgRole: 'org_admin' });
}

/** @type {import('../tenantFixtures').TenantFixture[]} */
const FIXTURES = [
    {
        // The data-subject routes of the KB query log (routes/compliance/kbQueryLog.js). The id is a
        // PERSON of org B (the owner, made an org admin so the first route answers 200 for them); a
        // member of org A has no `admin_compliance` and gets the permission gate's 403.
        kind: 'kbQueryLogSubject',
        mount: '/api/compliance',
        router: () => require('../../routes/compliance/kbQueryLog'),
        create: async ({ userId }) => {
            await require('../../stores/userStore').updateUser(userId, { orgRole: 'org_admin' });
            return userId;
        },
        routes: [
            'GET /api/compliance/kb-query-log/subjects/:userId', 'GET /api/compliance/kb-query-log/subjects/:userId/content',
            'GET /api/compliance/kb-query-log/subjects/:userId/export', 'DELETE /api/compliance/kb-query-log/subjects/:userId',
        ],
    },
    {
        // A person of org B and the user-management routes that take them by id
        // (auth/admin/userRoutes.js, requireOrgAdminForUser). The MFA reset is first:
        // for org B's admin it answers 200 without a body.
        kind: 'orgUser',
        mount: '/auth',
        router: () => require('../../auth/adminRoutes'),
        create: async ({ orgId, userId, index }) => {
            await makeOwnerOrgAdmin(userId);
            const id = `u-matrix-member-${index}`;
            await require('../../stores/userStore').createUser({
                id, username: id, email: `${id}@matrix.test`, organizationId: orgId,
                role: 'user', orgRole: 'member', groups: [], passwordHash: 'x',
            });
            return id;
        },
        routes: [
            'POST /auth/users/:id/mfa/reset', 'PUT /auth/users/:id', 'DELETE /auth/users/:id',
            'POST /auth/users/:id/avatar', 'DELETE /auth/users/:id/avatar',
        ],
        orgAdminCaller: true,
    },
    {
        // Org B itself: its settings, logo and encryption status (auth/admin/orgRoutes.js)
        // and its access grants (auth/admin/featureAccessRoutes.js). The id is the org's.
        // PUT encryption and POST encryption/backfill validate their body before the
        // org-admin check, so an empty body is a 400 there; they stay exempt.
        kind: 'organization',
        mount: '/auth',
        router: () => require('../../auth/adminRoutes'),
        create: async ({ orgId, userId }) => {
            await makeOwnerOrgAdmin(userId);
            return orgId;
        },
        routes: [
            'GET /auth/organizations/:id', 'PUT /auth/organizations/:id', 'DELETE /auth/organizations/:id',
            'POST /auth/organizations/:id/logo', 'DELETE /auth/organizations/:id/logo',
            'GET /auth/organizations/:id/encryption', 'GET /auth/organizations/:id/encryption/backfill',
            'GET /auth/organizations/:orgId/group-access', 'PUT /auth/organizations/:orgId/org-access',
            'GET /auth/organizations/:orgId/active-integrations', 'PUT /auth/organizations/:orgId/active-integrations',
            'GET /auth/organizations/:orgId/active-beta-features', 'PUT /auth/organizations/:orgId/active-beta-features',
            'PUT /auth/organizations/:orgId/beta-features',
            'GET /auth/organizations/:orgId/org-availability', 'PUT /auth/organizations/:orgId/org-availability',
        ],
        orgAdminCaller: true,
    },
];

module.exports = { FIXTURES };
