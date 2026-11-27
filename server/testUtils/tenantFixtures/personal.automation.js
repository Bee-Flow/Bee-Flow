// @typecheck strict
/**
 * Tenant-isolation fixtures: a reusable Step of a person of org B (the automation module).
 * What a fixture is and how the matrix drives it is in testUtils/tenantFixtures.js, which
 * finds this file in testUtils/tenantFixtures/ and puts its kinds in the matrix's order.
 */

'use strict';

const { present } = require('./helpers');

/** @type {import('../tenantFixtures').TenantFixture[]} */
const FIXTURES = [
    {
        // A reusable Step (an automation of kind block) of user B in org B (routes/step.js).
        kind: 'step',
        mount: '/api/step',
        router: () => require('../../routes/step'),
        create: async ({ orgId, userId, index }) => {
            const step = await require('../../stores/automationStore').createStep({
                userId, organizationId: orgId, title: `Step ${index}`, description: '',
                definition: {
                    schemaVersion: 2, trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [] },
                    steps: [{ id: 'out', type: 'layer_output', fields: {} }], edges: [],
                },
            });
            return present(step, 'createStep').id;
        },
        routes: [
            'GET /api/step/:id', 'GET /api/step/:id/versions', 'PUT /api/step/:id', 'POST /api/step/:id/publish',
            'POST /api/step/:id/test', 'PUT /api/step/:id/expose', 'PUT /api/step/:id/sharing', 'DELETE /api/step/:id',
        ],
        bodies: {
            'PUT /api/step/:id': { title: 'A title that must not land here' },
            'PUT /api/step/:id/expose': { exposeAsTool: true },
            'PUT /api/step/:id/sharing': { isPublished: true, sharedGroups: [] },
        },
        orgAdminCaller: true,
    },
];

module.exports = { FIXTURES };
