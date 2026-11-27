// @typecheck strict
/**
 * Tenant-isolation fixtures: a notebook of org B in the Documents library (routes/studioDocuments,
 * core; the notebook itself is the core's notebook store).
 * What a fixture is and how the matrix drives it is in testUtils/tenantFixtures.js, which
 * finds this file in testUtils/tenantFixtures/ and puts its kinds in the matrix's order.
 */

'use strict';

/** @type {import('../tenantFixtures').TenantFixture[]} */
const FIXTURES = [
    {
        // The same notebook in the Documents library (routes/studioDocuments: its sharing, its filing, its archive
        // and its delete for good), where the store answers the owner only; a member of org A gets the notebook's 404.
        kind: 'notebookLibrary',
        mount: '/api/studio-documents',
        router: () => require('../../routes/studioDocuments'),
        create: async ({ orgId, userId, index }) => {
            const notebookStore = require('../../stores/notebookStore');
            const nb = await notebookStore.createNotebook({ userId, organizationId: orgId, name: `Library notebook ${index}`, description: '', instructions: '', knowledgeBaseIds: [], settings: {} });
            return nb.id;
        },
        routes: [
            'GET /api/studio-documents/notebooks/:id/sharing', 'GET /api/studio-documents/notebooks/:id/sharing/principals',
            'PUT /api/studio-documents/notebooks/:id/sharing', 'PATCH /api/studio-documents/notebooks/:id/filing',
            'POST /api/studio-documents/notebooks/:id/archive', 'POST /api/studio-documents/notebooks/:id/unarchive',
            'DELETE /api/studio-documents/notebooks/:id',
        ],
        bodies: {
            'PUT /api/studio-documents/notebooks/:id/sharing': { audience: 'private' },
            'PATCH /api/studio-documents/notebooks/:id/filing': { folderId: null },
        },
    },
];

module.exports = { FIXTURES };
