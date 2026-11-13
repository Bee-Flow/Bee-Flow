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

/**
 * @typedef {{
 *   kind: string,
 *   mount: string,
 *   router: () => import('express').Router,
 *   create: (ctx: { orgId: string, userId: string, index: number }) => Promise<string>,
 *   routes: string[],
 *   ownerStatus?: number,
 *   orgAdminCaller?: boolean,
 * }} TenantFixture
 */

/** @type {TenantFixture[]} */
const FIXTURES = [
    {
        kind: 'agent',
        mount: '/agents',
        router: () => require('../routes/agents').router,
        create: async ({ orgId, userId, index }) => {
            const agentStore = require('../stores/agentStore');
            // The store's JSDoc types the organisation parameter from its `= null` default,
            // so the id (a string at runtime) is handed over through unknown.
            const organizationId = /** @type {null} */ (/** @type {unknown} */ (orgId));
            const agent = await agentStore.createAgent(`Agent ${index}`, 'matrix fixture', 'You are a test.', userId, null, [], true, true, false, {}, organizationId);
            return agent.id;
        },
        routes: [
            'GET /agents/:id', 'PUT /agents/:id', 'DELETE /agents/:id',
            // The other routes under the agent's id: the owner gets past the gate on each (a 200, or the 400 of an
            // empty body) and a member of org A does not.
            'GET /agents/:id/conversations', 'POST /agents/:id/conversations', 'DELETE /agents/:id/history', 'PATCH /agents/:id/publish',
            'POST /agents/:id/publish-version', 'GET /agents/:id/tool-lending', 'GET /agents/:id/tools', 'GET /agents/:id/usage',
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
        ],
    },
    {
        kind: 'automation',
        mount: '/api/automation',
        router: () => require('../routes/automation'),
        create: async ({ orgId, userId, index }) => {
            const automationStore = require('../stores/automationStore');
            const a = await automationStore.createAutomation({
                userId, organizationId: orgId, title: `Automation ${index}`,
                definition: { steps: [], edges: [] }, triggerType: 'manual',
            });
            if (!a) throw new Error('createAutomation answered nothing');
            return a.id;
        },
        routes: [
            'GET /api/automation/:id', 'PUT /api/automation/:id', 'DELETE /api/automation/:id', 'GET /api/automation/:id/runs',
            // The builder's form test and the form's test link: `edit` is checked before the body is read.
            'POST /api/automation/:id/form-test', 'POST /api/automation/:id/form-test/upload',
            'GET /api/automation/forms/:automationId/test-link', 'POST /api/automation/forms/:automationId/test-link',
            'DELETE /api/automation/forms/:automationId/test-link', 'PUT /api/automation/forms/:automationId/test-link/audience',
            // "Describe the look" (a model call): `edit` is checked before the body is read.
            'POST /api/automation/:id/forms/style-assist',
            // The other routes under the automation's id. The owner gets past the gate on each (a 200, the 400 of
            // an empty body, or the 404 of a version, case or webhook that does not exist); a member of org A does not.
            'POST /api/automation/:id/activate', 'GET /api/automation/:id/agent-bindings', 'POST /api/automation/:id/agent-invoke',
            'GET /api/automation/:id/ai-act', 'PUT /api/automation/:id/ai-act', 'PUT /api/automation/:id/ai-act/answers',
            'GET /api/automation/:id/ai-act/check', 'GET /api/automation/:id/ai-act/suggestion', 'GET /api/automation/:id/caller-notice',
            'GET /api/automation/:id/counts', 'POST /api/automation/:id/deactivate', 'POST /api/automation/:id/diagnose-trigger',
            'POST /api/automation/:id/dry-run', 'POST /api/automation/:id/duplicate', 'GET /api/automation/:id/export',
            'POST /api/automation/:id/form', 'GET /api/automation/:id/form-scenarios',
            'DELETE /api/automation/:id/form-scenarios/:scenarioId', 'GET /api/automation/:id/form-scenarios/:scenarioId',
            'POST /api/automation/:id/form-scenarios/:scenarioId/dry-run', 'DELETE /api/automation/:id/form/:token',
            'POST /api/automation/:id/form/:token/rotate', 'GET /api/automation/:id/forms', 'GET /api/automation/:id/goldens',
            'POST /api/automation/:id/goldens/replay', 'GET /api/automation/:id/notifications', 'GET /api/automation/:id/principals',
            'POST /api/automation/:id/publish', 'GET /api/automation/:id/readiness', 'POST /api/automation/:id/run',
            'POST /api/automation/:id/runs/:runId/retry', 'POST /api/automation/:id/save-as-template', 'GET /api/automation/:id/shares',
            'POST /api/automation/:id/steps/:stepId/run', 'POST /api/automation/:id/suggest-description',
            'GET /api/automation/:id/test-cases', 'DELETE /api/automation/:id/test-cases/:caseId',
            'GET /api/automation/:id/test-cases/:caseId', 'PUT /api/automation/:id/test-cases/:caseId', 'GET /api/automation/:id/usage',
            'GET /api/automation/:id/versions', 'GET /api/automation/:id/versions/:versionId',
            'GET /api/automation/:id/versions/:versionId/diff/:otherVersionId',
            'GET /api/automation/:id/versions/:versionId/fielddiff/:other', 'PUT /api/automation/:id/versions/:versionId/name',
            'POST /api/automation/:id/versions/:versionId/restore', 'POST /api/automation/:id/webhook',
            'DELETE /api/automation/:id/webhook/:slug', 'POST /api/automation/:id/webhook/:slug/rotate',
            'POST /api/automation/:id/webhook/:slug/test', 'GET /api/automation/:id/webhooks',
            'POST /api/automation/forms/:automationId/answers-table',
        ],
    },
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
        ],
    },
    {
        kind: 'notebook',
        mount: '/api/notebooks',
        router: () => require('../routes/notebooks'),
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
        ],
    },
    ...require('./tenantFixtures/projects').FIXTURES,
    ...require('./tenantFixtures/studioApps').FIXTURES,
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
        ],
    },
    ...require('./tenantFixtures/organisation').FIXTURES,
];

module.exports = { FIXTURES };
