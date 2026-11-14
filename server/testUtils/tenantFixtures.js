// @typecheck strict
/**
 * Tenant-isolation fixtures — one entry per resource kind the matrix test
 * (tenantIsolation.matrix.test.js) drives: how to create one in an org, and
 * which routes look it up by id.
 *
 * The matrix creates every kind in org B as user B, then calls each route as
 * user A of org A with B's id and expects 403 or 404; it also calls the first
 * route as B and expects 200, so a kind whose routes refuse everyone cannot
 * pass by accident.
 *
 * A kind names its router and mount so the test serves the REAL router behind
 * the real gates (testUtils/routeHarness.js serve): the only thing the harness
 * supplies is the session, exactly what express-session would.
 *
 * Adding a kind: `create` returns the id; `routes` lists `METHOD /mounted/path/:id`
 * exactly as auth/routes.contract.json spells them, with `:id` as the hole;
 * `router()` requires the router lazily (the stores must be initialised on the
 * PGlite pool first, which the test does).
 *
 * `orgAdminCaller: true` also runs the kind's routes as a second caller: the
 * organisation admin of org A who is a plain member of a group of org B. That
 * person belongs to org B but does not administer it, so every route must
 * still answer 403 or 404. Set it on kinds whose routes are gated on
 * org-admin; kinds gated on a flat permission are outside it.
 *
 * The kinds of a project, of an App Studio app and of an organisation and its
 * people sit in testUtils/tenantFixtures/, one file each; the list below keeps
 * the order the matrix creates them in.
 *
 * tenantIsolation.exemptions.json lists the routes with a parameter that no kind
 * covers yet, with a reason; lint:tenant-matrix-ratchet keeps that list from
 * growing.
 */

'use strict';

const { oneFile } = require('./tenantFixtures/helpers');

/**
 * @typedef {{
 *   kind: string,
 *   mount: string,
 *   router: () => import('express').Router,
 *   create: (ctx: { orgId: string, userId: string, index: number }) => Promise<string>,
 *   routes: string[],
 *   bodies?: Record<string, unknown>,
 *   params?: Record<string, string>,
 *   queries?: Record<string, string>,
 *   ownerStatus?: number,
 *   orgAdminCaller?: boolean,
 * }} TenantFixture
 *   `bodies`: per route, the body a member of org A sends where the schema is
 *   validated before the gate (an empty one would be the 400 of the schema, not
 *   the gate's answer).
 *   `params`: a fixed value for a named path parameter (every other one is the
 *   kind's id), where a sub-resource is named by a word such as `current`.
 *   `queries`: per route, a query string its schema requires before the gate.
 */

/**
 * An agent of org B, owned by user B: the fixture of the agent and the versions kinds.
 * @param {{ orgId: string, userId: string, index: number }} ctx
 */
async function createAgentFixture({ orgId, userId, index }) {
    const agentStore = require('../stores/agentStore');
    // The store's JSDoc types the organisation parameter from its `= null` default,
    // so the id (a string at runtime) is handed over through unknown.
    const organizationId = /** @type {null} */ (/** @type {unknown} */ (orgId));
    const agent = await agentStore.createAgent(`Agent ${index}`, 'matrix fixture', 'You are a test.', userId, null, [], true, true, false, {}, organizationId);
    return agent.id;
}

/** @type {TenantFixture[]} */
const FIXTURES = [
    {
        kind: 'agent',
        mount: '/agents',
        router: () => require('../routes/agents').router,
        create: createAgentFixture,
        routes: [
            'GET /agents/:id', 'PUT /agents/:id', 'DELETE /agents/:id',
            // The other routes under the agent's id: the owner gets past the gate on each (a 200, or the 400 of an
            // empty body) and a member of org A does not. The agent gates (auth/agentAccess.mts) answer a member of
            // org A the 404 of an unknown id (read, edit, manage) or the turn routes' 403 (chat); the routes behind
            // manage_agents answer a plain member their 403 first.
            'GET /agents/:id/conversations', 'POST /agents/:id/conversations', 'DELETE /agents/:id/history', 'PATCH /agents/:id/publish',
            'POST /agents/:id/publish-version', 'GET /agents/:id/tool-lending', 'GET /agents/:id/tools', 'GET /agents/:id/usage',
            'GET /agents/:id/history', 'POST /agents/:id/chat', 'POST /agents/:id/chat/stream', 'PUT /agents/:id/favorite',
            'POST /agents/:id/persona/parse', 'PUT /agents/:id/tools/:componentId/params', 'PUT /agents/:id/transfer',
            'GET /agents/:id/tests', 'GET /agents/:id/tests/runs', 'POST /agents/:id/tests', 'PUT /agents/:id/tests/:testId',
            'DELETE /agents/:id/tests/:testId', 'POST /agents/:id/tests/run', 'POST /agents/:id/tests/suggest',
            // The public embed page exists for a published agent with Web embed on only: a draft is its 404.
            'GET /agents/:id/embed',
            // A conversation under the agent's id: the id names no conversation, so the owner and a member of org A
            // both get the conversation's 404; the row itself is scoped on its owner (routes/agents/conversations.js).
            'GET /agents/:id/conversations/:convId', 'PATCH /agents/:id/conversations/:convId', 'DELETE /agents/:id/conversations/:convId',
            'PATCH /agents/:id/conversations/:convId/thread-titles', 'GET /agents/:id/conversations/:convId/workspace',
            'PUT /agents/:id/conversations/:convId/workspace',
        ],
        bodies: {
            'POST /agents/:id/chat': { message: 'A turn that must not land here.' },
            'POST /agents/:id/chat/stream': { message: 'A turn that must not land here.' },
            'PUT /agents/:id/tools/:componentId/params': { params: {} },
            'PUT /agents/:id/transfer': { newOwnerId: 'u-matrix-a' },
            'PATCH /agents/:id/conversations/:convId/thread-titles': { threadTitles: {} },
            'POST /agents/:id/tests': { question: 'What must not be asked here?' },
        },
    },
    {
        // The version history of an agent of org B (routes/versions.js, mounted at /versions): the agent's edit
        // gate, with `agentId` as the parameter. The owner lists an empty history; a member of org A gets the 404
        // of an unknown agent on every route, the version routes before any version is looked up.
        kind: 'versions',
        mount: '/versions',
        router: () => require('../routes/versions'),
        create: createAgentFixture,
        routes: [
            'GET /versions/:agentId', 'GET /versions/:agentId/:versionId', 'DELETE /versions/:agentId/:versionId',
            'POST /versions/:agentId/:versionId/restore', 'POST /versions/:agentId/pre-refine',
        ],
    },
    {
        kind: 'webpage',
        mount: '/api/webpages',
        router: () => require('../routes/webpages'),
        create: async ({ userId, index }) => {
            const webpageStore = require('../stores/webpageStore');
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
    ...require('./tenantFixtures/automation').FIXTURES,
    {
        kind: 'datatable',
        mount: '/api/datatables',
        router: () => require('../routes/datatables'),
        create: async ({ orgId, userId, index }) => {
            const datatableStore = require('../stores/datatableStore');
            const t = await datatableStore.createDatatable({
                scope: datatableStore.orgScope(orgId), ownerUserId: userId, key: `matrix_${index}`, name: `Table ${index}`,
                fields: [{ key: 'label', name: 'Label', type: 'text' }],
            });
            return t.id;
        },
        routes: [
            'GET /api/datatables/:id', 'GET /api/datatables/:id/rows', 'DELETE /api/datatables/:id',
            // The other routes under the table's id. A member of org A gets the table's 404 on each; the owner gets
            // past it (a 200, the 400 of an empty body, or the 403 of a permission a plain member does not hold).
            'PATCH /api/datatables/:id', 'POST /api/datatables/:id/aggregate', 'DELETE /api/datatables/:id/answers/columns/:fieldId',
            'POST /api/datatables/:id/answers/release', 'GET /api/datatables/:id/grants', 'POST /api/datatables/:id/grants',
            'DELETE /api/datatables/:id/grants/:grantId', 'GET /api/datatables/:id/health', 'PUT /api/datatables/:id/nextcloud',
            'PUT /api/datatables/:id/nextcloud/relations', 'POST /api/datatables/:id/nextcloud/relink', 'POST /api/datatables/:id/repair',
            'POST /api/datatables/:id/rows', 'GET /api/datatables/:id/rows.csv', 'DELETE /api/datatables/:id/rows/:rowId',
            'GET /api/datatables/:id/rows/:rowId', 'PUT /api/datatables/:id/rows/:rowId', 'POST /api/datatables/:id/rows/bulk',
            'POST /api/datatables/:id/rows/bulk-delete', 'GET /api/datatables/:id/schema', 'PUT /api/datatables/:id/schema',
            'PUT /api/datatables/:id/sharing', 'PUT /api/datatables/:id/source', 'PUT /api/datatables/:id/source/relations',
            'POST /api/datatables/:id/source/relink', 'GET /api/datatables/:id/usage',
            'GET /api/datatables/:id/answers/summary', 'GET /api/datatables/:id/nextcloud', 'GET /api/datatables/:id/nextcloud/pulse',
            'GET /api/datatables/:id/source', 'GET /api/datatables/:id/source/pulse', 'POST /api/datatables/:id/nextcloud/refresh',
            'POST /api/datatables/:id/source/refresh',
        ],
    },
    {
        kind: 'notebook',
        mount: '/api/notebooks',
        // index.js mounts the notebook routes and the export routes under the same path; the kind serves both.
        router: () => require('express').Router().use(require('../routes/notebooks')).use(require('../routes/notebookExport')),
        create: async ({ orgId, userId, index }) => {
            const notebookStore = require('../stores/notebookStore');
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
    {
        // The same notebook in the Documents library (routes/studioDocuments: its sharing and its filing), where
        // the store answers the owner only; a member of org A gets the notebook's 404.
        kind: 'notebookLibrary',
        mount: '/api/studio-documents',
        router: () => require('../routes/studioDocuments'),
        create: async ({ orgId, userId, index }) => {
            const notebookStore = require('../stores/notebookStore');
            const nb = await notebookStore.createNotebook({ userId, organizationId: orgId, name: `Library notebook ${index}`, description: '', instructions: '', knowledgeBaseIds: [], settings: {} });
            return nb.id;
        },
        routes: [
            'GET /api/studio-documents/notebooks/:id/sharing', 'GET /api/studio-documents/notebooks/:id/sharing/principals',
            'PUT /api/studio-documents/notebooks/:id/sharing', 'PATCH /api/studio-documents/notebooks/:id/filing',
        ],
        bodies: {
            'PUT /api/studio-documents/notebooks/:id/sharing': { audience: 'private' },
            'PATCH /api/studio-documents/notebooks/:id/filing': { folderId: null },
        },
    },
    ...require('./tenantFixtures/projects').FIXTURES,
    ...require('./tenantFixtures/studioApps').FIXTURES,
    ...require('./tenantFixtures/studioDocuments').FIXTURES,
    {
        // A knowledge base of org B (unpublished, owned by B) and the routes that look it up by id,
        // the query-log routes included (routes/knowledgeBases/queryLog.js). Both orgs hold a plan with
        // `kb_query_log`, so the answer a member of org A gets is the base's own gate, not the licence.
        kind: 'knowledgeBase',
        mount: '/api/kb',
        router: () => require('../routes/knowledgeBases'),
        create: async ({ orgId, userId, index }) => {
            const kbStore = require('../stores/knowledgeBases');
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
        router: () => require('../routes/knowledgeBases'),
        create: async ({ orgId, index }) => {
            const kbStore = require('../stores/knowledgeBases');
            const category = await kbStore.createKBCategory({ id: `cat-matrix-${index}`, organizationId: orgId, name: `Category ${index}`, icon: null, color: null });
            return category.id;
        },
        routes: ['DELETE /api/kb/categories/:id'],
    },
    ...require('./tenantFixtures/organisation').FIXTURES,
    ...require('./tenantFixtures/orgSettings').FIXTURES,
    ...require('./tenantFixtures/meetings').FIXTURES,
    ...require('./tenantFixtures/personal').FIXTURES,
    ...require('./tenantFixtures/chat').FIXTURES,
    ...require('./tenantFixtures/compliance').FIXTURES,
    ...require('./tenantFixtures/support').FIXTURES,
    ...require('./tenantFixtures/authAdmin').FIXTURES,
];

module.exports = { FIXTURES };
