// @typecheck strict
/**
 * Tenant-isolation fixtures: the Cowork settings an organisation keeps under its id (the cowork module).
 * What a fixture is and how the matrix drives it is in testUtils/tenantFixtures.js, which
 * finds this file in testUtils/tenantFixtures/ and puts its kinds in the matrix's order.
 */

'use strict';

const { orgArea } = require('./orgSettings');

/** @type {import('../tenantFixtures').TenantFixture[]} */
const FIXTURES = [
    ...orgArea('coworkShield', '/api/cowork', () => require('../../routes/coworkShieldSettings'), {
        memberReads: ['GET /api/cowork/shield/:orgId'],
        adminRoutes: ['PUT /api/cowork/shield/:orgId'],
        bodies: { 'PUT /api/cowork/shield/:orgId': { enabled: true } },
    }),
    ...orgArea('coworkPolicy', '/api/cowork', () => require('../../routes/coworkPolicyRoutes'), {
        memberReads: ['GET /api/cowork/policy/:orgId'],
        adminRoutes: ['PUT /api/cowork/policy/:orgId', 'GET /api/cowork/policy/:orgId/audit'],
        bodies: { 'PUT /api/cowork/policy/:orgId': { readOnly: false } },
    }),
];

module.exports = { FIXTURES };
