// @typecheck strict
/**
 * Tenant-isolation fixtures: a webpage of org B (the webpages module).
 * What a fixture is and how the matrix drives it is in testUtils/tenantFixtures.js, which
 * finds this file in testUtils/tenantFixtures/ and puts its kinds in the matrix's order.
 */

'use strict';

const { oneFile } = require('./helpers');

/** @type {import('../tenantFixtures').TenantFixture[]} */
const FIXTURES = [
    {
        kind: 'webpage',
        mount: '/api/webpages',
        router: () => require('../../routes/webpages'),
        create: async ({ userId, index }) => {
            const webpageStore = require('../../stores/webpageStore');
            const page = await webpageStore.createWebpage({ userId, name: `Page ${index}`, description: '', instructions: '', knowledgeBaseIds: [], settings: {} });
            return page.id;
        },
        routes: [
            'GET /api/webpages/:id', 'PUT /api/webpages/:id', 'DELETE /api/webpages/:id', 'PUT /api/webpages/:id/grants/db',
            // The other routes under the page's id. The owner gets past the gate on each (a 200, the 400 of an empty
            // body, or the 404 of a source, version or share that does not exist); a member of org A gets the page's 404.
            'GET /api/webpages/:id/audience', 'GET /api/webpages/:id/bindings', 'DELETE /api/webpages/:id/chat',
            'POST /api/webpages/:id/clone', 'GET /api/webpages/:id/data-cards', 'DELETE /api/webpages/:id/db',
            'GET /api/webpages/:id/db/schema', 'GET /api/webpages/:id/draft-document', 'GET /api/webpages/:id/files',
            'GET /api/webpages/:id/grants', 'DELETE /api/webpages/:id/grants/automations/:automationId',
            'DELETE /api/webpages/:id/grants/integrations/:tool', 'POST /api/webpages/:id/preview-token',
            'GET /api/webpages/:id/public-shares', 'DELETE /api/webpages/:id/public-shares/:shareId',
            'POST /api/webpages/:id/public-shares/:shareId/refresh', 'GET /api/webpages/:id/sources',
            'DELETE /api/webpages/:id/sources/:sid', 'POST /api/webpages/:id/sources/:sid/cancel',
            'POST /api/webpages/:id/sources/:sid/retry', 'POST /api/webpages/:id/sources/file', 'GET /api/webpages/:id/usage',
            'GET /api/webpages/:id/versions', 'POST /api/webpages/:id/versions', 'DELETE /api/webpages/:id/versions/:vid',
            'GET /api/webpages/:id/versions/:vid', 'POST /api/webpages/:id/versions/:vid/restore',
            'DELETE /api/webpages/:id/files', 'GET /api/webpages/:id/thumbnail', 'PATCH /api/webpages/:id/public-shares/:shareId',
            'PATCH /api/webpages/:id/publish', 'POST /api/webpages/:id/assets', 'POST /api/webpages/:id/assets/move',
            'POST /api/webpages/:id/db/exec', 'POST /api/webpages/:id/db/query', 'POST /api/webpages/:id/export/pdf',
            'POST /api/webpages/:id/grants/automations', 'POST /api/webpages/:id/grants/integrations',
            'POST /api/webpages/:id/public-shares', 'POST /api/webpages/:id/sources/drive', 'POST /api/webpages/:id/sources/text',
            'POST /api/webpages/:id/sources/url', 'PUT /api/webpages/:id/audience/public', 'PUT /api/webpages/:id/chat',
            'PUT /api/webpages/:id/files',
        ],
        queries: { 'DELETE /api/webpages/:id/files': 'path=matrix.html' },
        bodies: {
            'PATCH /api/webpages/:id/public-shares/:shareId': { expiresAt: null },
            'PATCH /api/webpages/:id/publish': { isPublished: true },
            'POST /api/webpages/:id/assets': oneFile('file', { path: 'assets/matrix.txt' }),
            'POST /api/webpages/:id/assets/move': { from: 'assets/a.txt', to: 'assets/b.txt' },
            'POST /api/webpages/:id/db/exec': { sql: 'DELETE FROM matrix_rows' },
            'POST /api/webpages/:id/db/query': { sql: 'SELECT 1' },
            'POST /api/webpages/:id/grants/automations': { automationId: 'a-matrix' },
            'POST /api/webpages/:id/grants/integrations': { tool: 'matrix_tool' },
            'POST /api/webpages/:id/public-shares': { accessMode: 'unlisted' },
            'POST /api/webpages/:id/sources/drive': { provider: 'google', files: [{ name: 'matrix.txt', content: 'Text that must not land here.' }] },
            'POST /api/webpages/:id/sources/text': { text: 'Text that must not land here.' },
            'POST /api/webpages/:id/sources/url': { url: 'https://example.com/' },
            'PUT /api/webpages/:id/audience/public': { on: false },
            'PUT /api/webpages/:id/chat': { messages: [] },
            'PUT /api/webpages/:id/files': { path: 'matrix.html', content: '<p>Text that must not land here.</p>' },
        },
    },
];

module.exports = { FIXTURES };
