// @typecheck strict
/**
 * Tenant-isolation fixtures: a playbook of a person of org B (the playbooks module).
 * What a fixture is and how the matrix drives it is in testUtils/tenantFixtures.js, which
 * finds this file in testUtils/tenantFixtures/ and puts its kinds in the matrix's order.
 */

'use strict';

const { present } = require('./helpers');

/** @type {import('../tenantFixtures').TenantFixture[]} */
const FIXTURES = [
    {
        // A playbook of user B in org B (routes/playbooks): a member of org A gets the 403 of manage_apps on the
        // writes and the playbook's 404 on the read; the admin of A, who holds manage_apps in A, the 404.
        kind: 'playbook',
        mount: '/api/playbooks',
        router: () => require('../../routes/playbooks'),
        create: async ({ orgId, userId, index }) => {
            const pb = await require('../../stores/playbookStore').createPlaybook({
                userId, organizationId: orgId, recipeId: 'invoice_tracker', title: `Playbook ${index}`,
                options: { tableMode: 'new' }, phases: [{ key: 'table', status: 'ready' }], currentPhase: 'table',
            });
            return present(pb, 'createPlaybook').id;
        },
        params: { key: 'table' },
        routes: [
            'GET /api/playbooks/:id', 'PATCH /api/playbooks/:id', 'POST /api/playbooks/:id/phases/:key/access-plan',
            'POST /api/playbooks/:id/phases/:key/register', 'POST /api/playbooks/:id/phases/:key/resolve-plan',
            'POST /api/playbooks/:id/phases/:key/retention-preview', 'POST /api/playbooks/:id/phases/:key/retry',
            'POST /api/playbooks/:id/phases/:key/run', 'POST /api/playbooks/:id/phases/:key/skip', 'DELETE /api/playbooks/:id',
        ],
        orgAdminCaller: true,
    },
];

module.exports = { FIXTURES };
