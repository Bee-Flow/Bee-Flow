// @typecheck strict
/**
 * Tenant-isolation fixtures: a Cowork template of org B (routes/coworkTemplateRoutes.js), saved by user B for their
 * organisation. Every member of org B sees it; a member of org A, or an administrator of org A who sits in a group
 * of org B, reads, uses and deletes nothing of it (404: it does not exist for them). What a fixture is and how the
 * matrix drives it is in testUtils/tenantFixtures.js, which puts this in its list.
 */

'use strict';

/** @type {import('../tenantFixtures').TenantFixture[]} */
const FIXTURES = [
    {
        kind: 'coworkTemplate',
        mount: '/api/cowork',
        router: () => require('../../routes/cowork'),
        create: async ({ orgId, userId, index }) => {
            const { coworkTemplates } = require('../../stores/coworkTemplates.mts');
            const template = await coworkTemplates().create({
                organizationId: orgId, createdBy: userId, title: `Template ${index}`, brief: 'Summarise the week.',
                repeatInterval: 'weekly', definition: null, fingerprint: null,
            });
            return template.id;
        },
        routes: [
            'GET /api/cowork/templates/:id', 'POST /api/cowork/templates/:id/use', 'DELETE /api/cowork/templates/:id',
        ],
        orgAdminCaller: true,
    },
];

module.exports = { FIXTURES };
