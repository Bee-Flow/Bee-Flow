// @typecheck strict
/**
 * Tenant-isolation fixtures: a meeting-summary template of org B (the meetingNotes module).
 * What a fixture is and how the matrix drives it is in testUtils/tenantFixtures.js, which
 * finds this file in testUtils/tenantFixtures/ and puts its kinds in the matrix's order.
 */

'use strict';

const { present } = require('./helpers');

/** @type {import('../tenantFixtures').TenantFixture[]} */
const FIXTURES = [
    {
        // A meeting-summary template of org B (routes/summaryTemplates.js): changed by an admin of org B only.
        kind: 'summaryTemplate',
        mount: '/api/summary-templates',
        router: () => require('../../routes/summaryTemplates'),
        create: async ({ orgId, userId, index }) => {
            await require('./organisation').makeOwnerOrgAdmin(userId);
            const tpl = await require('../../stores/summaryTemplateStore').create({
                scope: 'org', name: `Summary ${index}`, prompt: 'Summarise the meeting.', organizationId: orgId, createdBy: userId,
            });
            return present(tpl, 'create summary template').id;
        },
        routes: ['PATCH /api/summary-templates/:id', 'DELETE /api/summary-templates/:id'],
        bodies: { 'PATCH /api/summary-templates/:id': { name: 'A name that must not land here' } },
        orgAdminCaller: true,
    },
];

module.exports = { FIXTURES };
