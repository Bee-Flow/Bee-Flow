// @typecheck strict
/**
 * Tenant-isolation fixtures: the AI participation and collaboration settings of an organisation (the projects module).
 * What a fixture is and how the matrix drives it is in testUtils/tenantFixtures.js, which
 * finds this file in testUtils/tenantFixtures/ and puts its kinds in the matrix's order.
 */

'use strict';

const { orgArea } = require('./orgSettings');

/** @type {import('../tenantFixtures').TenantFixture[]} */
const FIXTURES = [
    ...orgArea('aiParticipation', '/api/ai-participation', () => require('../../routes/aiParticipation'), {
        memberReads: ['GET /api/ai-participation/org/:orgId'],
        adminRoutes: ['PUT /api/ai-participation/org/:orgId'],
        bodies: { 'PUT /api/ai-participation/org/:orgId': { autoAllowed: true, alwaysAllowed: true, commentsAutoAllowed: true } },
    }),
    ...orgArea('orgCollab', '/api/org-collab', () => require('../../routes/orgCollab'), {
        memberReads: ['GET /api/org-collab/:orgId'],
        adminRoutes: ['PUT /api/org-collab/:orgId'],
        bodies: { 'PUT /api/org-collab/:orgId': { collabEnabled: true } },
    }),
];

module.exports = { FIXTURES };
