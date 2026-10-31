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
            // The store's JSDoc types the organisation parameter from its null default; the id is a string.
            const agent = await agentStore.createAgent(`Agent ${index}`, 'matrix fixture', 'You are a test.', userId, null, [], true, true, false, {}, /** @type {any} */ (orgId));
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
        routes: ['GET /api/webpages/:id', 'PUT /api/webpages/:id', 'DELETE /api/webpages/:id'],
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
        routes: ['GET /api/automation/:id', 'PUT /api/automation/:id', 'DELETE /api/automation/:id', 'GET /api/automation/:id/runs'],
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
];

module.exports = { FIXTURES };
