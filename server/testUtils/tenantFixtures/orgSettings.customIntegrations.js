// @typecheck strict
/**
 * Tenant-isolation fixtures: the custom integrations of an organisation (the custom_integrations module).
 * What a fixture is and how the matrix drives it is in testUtils/tenantFixtures.js, which
 * finds this file in testUtils/tenantFixtures/ and puts its kinds in the matrix's order.
 */

'use strict';

const { orgArea } = require('./orgSettings');

/** @type {import('../tenantFixtures').TenantFixture[]} */
const FIXTURES = [
    ...orgArea('customIntegrations', '/api/organizations/:orgId/custom-integrations', () => require('../../routes/orgIntegrations/builder'), {
        adminRoutes: [
            'GET /api/organizations/:orgId/custom-integrations', 'POST /api/organizations/:orgId/custom-integrations',
            'GET /api/organizations/:orgId/custom-integrations/:id', 'GET /api/organizations/:orgId/custom-integrations/:id/session',
            'POST /api/organizations/:orgId/custom-integrations/:id/activate', 'POST /api/organizations/:orgId/custom-integrations/:id/deactivate',
            'POST /api/organizations/:orgId/custom-integrations/:id/refresh-tools',
            'POST /api/organizations/:orgId/custom-integrations/:id/test-call',
            'POST /api/organizations/:orgId/custom-integrations/:id/validate',
            'PUT /api/organizations/:orgId/custom-integrations/:id/credentials',
            'PUT /api/organizations/:orgId/custom-integrations/:id/definition', 'DELETE /api/organizations/:orgId/custom-integrations/:id',
        ],
    }),
];

module.exports = { FIXTURES };
