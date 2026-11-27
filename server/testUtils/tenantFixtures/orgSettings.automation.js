// @typecheck strict
/**
 * Tenant-isolation fixtures: the automation image-AI setting of an organisation (the automation module).
 * What a fixture is and how the matrix drives it is in testUtils/tenantFixtures.js, which
 * finds this file in testUtils/tenantFixtures/ and puts its kinds in the matrix's order.
 */

'use strict';

const { orgArea } = require('./orgSettings');

/** @type {import('../tenantFixtures').TenantFixture[]} */
const FIXTURES = [
    ...orgArea('orgAutomationImageAi', '/api/org-automation-image-ai', () => require('../../routes/orgAutomationImageAi.mts').orgAutomationImageAiRouter, {
        memberReads: ['GET /api/org-automation-image-ai/:orgId'],
        adminRoutes: ['PUT /api/org-automation-image-ai/:orgId'],
        bodies: { 'PUT /api/org-automation-image-ai/:orgId': { enabled: false } },
    }),
];

module.exports = { FIXTURES };
