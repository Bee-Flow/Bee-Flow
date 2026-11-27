// @typecheck strict
/**
 * Tenant-isolation fixtures: the data-subject routes of the KB query log, the id a person of org B
 * (the compliance module).
 * What a fixture is and how the matrix drives it is in testUtils/tenantFixtures.js, which
 * finds this file in testUtils/tenantFixtures/ and puts its kinds in the matrix's order.
 */

'use strict';


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
];

module.exports = { FIXTURES };
