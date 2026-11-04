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
        routes: ['GET /agents/:id', 'PUT /agents/:id', 'DELETE /agents/:id'],
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
        routes: ['GET /api/webpages/:id', 'PUT /api/webpages/:id', 'DELETE /api/webpages/:id', 'PUT /api/webpages/:id/grants/db'],
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
        routes: ['GET /api/datatables/:id', 'GET /api/datatables/:id/rows', 'DELETE /api/datatables/:id'],
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
        routes: ['GET /api/notebooks/:id', 'PUT /api/notebooks/:id', 'DELETE /api/notebooks/:id'],
    },
    {
        // The data/schema/members routes of an App Studio app (routes/studioAppData.js). An app of
        // org B is unpublished, so a member of org A cannot even see it: 404 on every route.
        kind: 'studioApp',
        mount: '/api/studio-apps',
        router: () => require('../routes/studioAppData'),
        create: async ({ orgId, userId, index }) => {
            const studioAppStore = require('../stores/studioAppStore');
            const app = await studioAppStore.createStudioApp({ userId, organizationId: orgId, name: `App ${index}` });
            return app.id;
        },
        routes: [
            // PUT schema and POST members validate their body before the gate, so an empty body is a 400.
            'GET /api/studio-apps/:id/schema', 'GET /api/studio-apps/:id/members',
            'DELETE /api/studio-apps/:id/members/:userId', 'POST /api/studio-apps/:id/data/empty',
        ],
    },
    {
        // The runtime routes of an App Studio app (routes/studioAppsRun.js): background jobs and
        // the automation bridge. The app of org B is unpublished: a member of org A gets the
        // app gate's 404 on every route before any body, job or action is looked at. /step is
        // not here: its body names a step index, which is validated before the gate.
        kind: 'studioAppRuntime',
        mount: '/api/studio-apps',
        router: () => require('../routes/studioAppsRun'),
        create: async ({ orgId, userId, index }) => {
            const studioAppStore = require('../stores/studioAppStore');
            const app = await studioAppStore.createStudioApp({ userId, organizationId: orgId, name: `Runtime app ${index}` });
            return app.id;
        },
        routes: [
            'GET /api/studio-apps/:id/actions/jobs', 'GET /api/studio-apps/:id/actions/jobs/:jobId',
            'POST /api/studio-apps/:id/actions/:actionId/background', 'POST /api/studio-apps/:id/actions/:actionId/run',
            'GET /api/studio-apps/:id/actions/runs/:runId', 'POST /api/studio-apps/:id/actions/:actionId/runs/end',
        ],
    },
    {
        // The run log of an App Studio app (routes/studioApps/runLog.js): owner only, so a member
        // of org A gets 404 on the list and on a run, and the owner the list.
        kind: 'studioAppRunLog',
        mount: '/api/studio-apps',
        router: () => require('../routes/studioApps/runLog'),
        create: async ({ orgId, userId, index }) => {
            const studioAppStore = require('../stores/studioAppStore');
            const app = await studioAppStore.createStudioApp({ userId, organizationId: orgId, name: `Run log app ${index}` });
            return app.id;
        },
        routes: ['GET /api/studio-apps/:id/runs', 'GET /api/studio-apps/:id/runs/:runId'],
    },
];

module.exports = { FIXTURES };
