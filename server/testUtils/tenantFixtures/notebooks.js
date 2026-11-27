// @typecheck strict
/**
 * Tenant-isolation fixtures: a notebook of org B and its export routes (the notebooks module).
 * What a fixture is and how the matrix drives it is in testUtils/tenantFixtures.js, which
 * finds this file in testUtils/tenantFixtures/ and puts its kinds in the matrix's order.
 */

'use strict';

/** @type {import('../tenantFixtures').TenantFixture[]} */
const FIXTURES = [
    {
        kind: 'notebook',
        mount: '/api/notebooks',
        // index.js mounts the notebook routes and the export routes under the same path; the kind serves both.
        router: () => require('express').Router().use(require('../../routes/notebooks')).use(require('../../routes/notebookExport')),
        create: async ({ orgId, userId, index }) => {
            const notebookStore = require('../../stores/notebookStore');
            const nb = await notebookStore.createNotebook({ userId, organizationId: orgId, name: `Notebook ${index}`, description: '', instructions: '', knowledgeBaseIds: [], settings: {} });
            return nb.id;
        },
        routes: [
            'GET /api/notebooks/:id', 'PUT /api/notebooks/:id', 'DELETE /api/notebooks/:id',
            // The other routes under the notebook's id. The owner gets past the gate on each (a 200, the 400 of an
            // empty body, or the 404 of a source or version that does not exist); a member of org A gets the notebook's 404.
            'DELETE /api/notebooks/:id/conversation', 'GET /api/notebooks/:id/conversation', 'POST /api/notebooks/:id/generate/:type',
            'POST /api/notebooks/:id/images', 'POST /api/notebooks/:id/import-file', 'GET /api/notebooks/:id/sources',
            'DELETE /api/notebooks/:id/sources/:sid', 'POST /api/notebooks/:id/sources/:sid/cancel',
            'GET /api/notebooks/:id/sources/:sid/content', 'POST /api/notebooks/:id/sources/:sid/retry',
            'POST /api/notebooks/:id/sources/file', 'GET /api/notebooks/:id/versions', 'DELETE /api/notebooks/:id/versions/:ref',
            'GET /api/notebooks/:id/versions/:ref', 'POST /api/notebooks/:id/versions/:ref/restore',
            // The routes whose schema runs before the role gate, with the body it accepts, so the answer a member
            // of org A gets is the gate's 404 and not the schema's 400; the exports (routes/notebookExport.js) gate first.
            'PATCH /api/notebooks/:id/sources/:sid', 'PATCH /api/notebooks/:id/sources/reorder', 'POST /api/notebooks/:id/ai-fill',
            'POST /api/notebooks/:id/sources/bulk-delete', 'POST /api/notebooks/:id/sources/drive', 'POST /api/notebooks/:id/sources/meeting',
            'POST /api/notebooks/:id/sources/text', 'POST /api/notebooks/:id/sources/url', 'POST /api/notebooks/:id/versions',
            'POST /api/notebooks/:id/versions/kept', 'PUT /api/notebooks/:id/versions/:ref/name',
            'POST /api/notebooks/:id/export/pdf', 'POST /api/notebooks/:id/export/docx', 'POST /api/notebooks/:id/export/nextcloud',
            'POST /api/notebooks/:id/export/signrequest',
        ],
        bodies: {
            'PATCH /api/notebooks/:id/sources/:sid': { name: 'Matrix source' },
            'PATCH /api/notebooks/:id/sources/reorder': { orderedIds: ['s-matrix'] },
            'POST /api/notebooks/:id/ai-fill': { documentContent: '<p>Text that must not land here.</p>' },
            'POST /api/notebooks/:id/sources/bulk-delete': { ids: ['s-matrix'] },
            'POST /api/notebooks/:id/sources/drive': { files: [{ name: 'matrix.txt', driveFileId: 'd-matrix', content: 'Text that must not land here.' }] },
            'POST /api/notebooks/:id/sources/meeting': { meetingId: 'm-matrix' },
            'POST /api/notebooks/:id/sources/text': { text: 'Text that must not land here.' },
            'POST /api/notebooks/:id/sources/url': { url: 'https://example.com/' },
            'POST /api/notebooks/:id/versions': { name: 'Matrix version' },
            'POST /api/notebooks/:id/versions/kept': { html: '<p>Text that must not land here.</p>' },
            'PUT /api/notebooks/:id/versions/:ref/name': { name: 'Matrix version' },
            'POST /api/notebooks/:id/export/pdf': { content: '<p>Text that must not land here.</p>' },
            'POST /api/notebooks/:id/export/docx': { content: '<p>Text that must not land here.</p>' },
            'POST /api/notebooks/:id/export/nextcloud': { content: '<p>Text that must not land here.</p>' },
            'POST /api/notebooks/:id/export/signrequest': { content: '<p>Text that must not land here.</p>', signers: [{ email: 'signer@matrix.test' }] },
        },
    },
];

module.exports = { FIXTURES };
