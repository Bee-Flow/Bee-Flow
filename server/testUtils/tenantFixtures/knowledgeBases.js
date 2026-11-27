// @typecheck strict
/**
 * Tenant-isolation fixtures: a knowledge base of org B and a knowledge-base category.
 * What a fixture is and how the matrix drives it is in testUtils/tenantFixtures.js, which
 * finds this file in testUtils/tenantFixtures/ and puts its kinds in the matrix's order.
 */

'use strict';

/** @type {import('../tenantFixtures').TenantFixture[]} */
const FIXTURES = [
    {
        // A knowledge base of org B (unpublished, owned by B) and the routes that look it up by id,
        // the query-log routes included (routes/knowledgeBases/queryLog.js). Both orgs hold a plan with
        // `kb_query_log`, so the answer a member of org A gets is the base's own gate, not the licence.
        kind: 'knowledgeBase',
        mount: '/api/kb',
        router: () => require('../../routes/knowledgeBases'),
        create: async ({ orgId, userId, index }) => {
            const kbStore = require('../../stores/knowledgeBases');
            const kb = await kbStore.createKB(userId, `KB ${index}`, 'matrix fixture', orgId, {});
            return kb.id;
        },
        routes: [
            'GET /api/kb/:id', 'GET /api/kb/:id/documents', 'GET /api/kb/:id/usage', 'GET /api/kb/:id/sources',
            // The kept original file of a document: the base's gate answers before any document is looked up.
            'GET /api/kb/:id/documents/:docId/original',
            'PUT /api/kb/:id/query-log/settings', 'GET /api/kb/:id/query-log/settings', 'GET /api/kb/:id/query-log', 'GET /api/kb/:id/query-log/export.csv',
            'GET /api/kb/:id/query-log/:entryId', 'PATCH /api/kb/:id/query-log/:entryId/review', 'DELETE /api/kb/:id/query-log',
            // Documents, sources and threads under the base's id: the base's gate answers a member of org A before
            // any of them is looked up; the owner gets the 404 of the document, source or thread that does not exist.
            'GET /api/kb/:id/documents/:docId/chunks', 'GET /api/kb/:id/documents/:docId/content', 'GET /api/kb/:id/sources/:sid/documents',
            'GET /api/kb/:id/sources/:sid/documents/:docId', 'GET /api/kb/:id/threads', 'GET /api/kb/:id/threads/:threadId/documents',
            // The base's own writes and the content writes: manage_knowledge answers a plain member of org A its 403
            // first; an admin of org A holds it in A only, and the base's manage check refuses them on B's base.
            'PATCH /api/kb/:id', 'DELETE /api/kb/:id', 'PATCH /api/kb/:id/publish', 'POST /api/kb/:id/ask', 'POST /api/kb/:id/duplicate',
            'POST /api/kb/:id/documents/bulk-delete', 'DELETE /api/kb/:id/documents/:docId', 'POST /api/kb/:id/ingest/text',
            'POST /api/kb/:id/ingest/url', 'POST /api/kb/:id/ingest/file', 'POST /api/kb/:id/ingest/n8n', 'POST /api/kb/:id/ingest/sitemap',
            'POST /api/kb/:id/reindex', 'POST /api/kb/:id/sources', 'POST /api/kb/:id/sources/:sid/files', 'PATCH /api/kb/:id/sources/:sid',
            'DELETE /api/kb/:id/sources/:sid', 'POST /api/kb/:id/sources/:sid/refresh',
            // Favouriting needs read access to the base.
            'PUT /api/kb/:id/favorite',
        ],
        bodies: {
            'PATCH /api/kb/:id/publish': { isPublished: true },
            'POST /api/kb/:id/ask': { question: 'What must not be asked here?' },
            'POST /api/kb/:id/documents/bulk-delete': { documentIds: ['00000000-0000-4000-8000-000000000000'] },
            'POST /api/kb/:id/ingest/text': { content: 'Text that must not land here.', title: 'Matrix' },
            'POST /api/kb/:id/ingest/url': { url: 'https://example.com/' },
            'POST /api/kb/:id/ingest/n8n': { workflowId: 'wf-matrix' },
            'POST /api/kb/:id/ingest/sitemap': { url: 'https://example.com/' },
            'POST /api/kb/:id/sources': { kind: 'manual', name: 'Matrix source' },
        },
    },
    {
        // A knowledge-base category of org B: a category of another organisation answers as an unknown id. The
        // organisation admin of A, who holds manage_knowledge in A only, is the dedicated case in the matrix test.
        kind: 'kbCategory',
        mount: '/api/kb',
        router: () => require('../../routes/knowledgeBases'),
        create: async ({ orgId, index }) => {
            const kbStore = require('../../stores/knowledgeBases');
            const category = await kbStore.createKBCategory({ id: `cat-matrix-${index}`, organizationId: orgId, name: `Category ${index}`, icon: null, color: null });
            return category.id;
        },
        routes: ['DELETE /api/kb/categories/:id'],
    },
];

module.exports = { FIXTURES };
