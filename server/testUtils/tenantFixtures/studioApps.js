// @typecheck strict
/**
 * Tenant-isolation fixtures: an App Studio app, one kind per
 * router that takes its id. What a fixture is and how the matrix drives
 * it is in testUtils/tenantFixtures.js, which puts these in its list.
 */

'use strict';

/** @type {import('../tenantFixtures').TenantFixture[]} */
const FIXTURES = [
    {
        // The data/schema/members routes of an App Studio app (routes/studioAppData.js). An app of
        // org B is unpublished, so a member of org A cannot even see it: 404 on every route.
        kind: 'studioApp',
        mount: '/api/studio-apps',
        router: () => require('../../routes/studioAppData'),
        create: async ({ orgId, userId, index }) => {
            const studioAppStore = require('../../stores/studioAppStore');
            const app = await studioAppStore.createStudioApp({ userId, organizationId: orgId, name: `App ${index}` });
            return app.id;
        },
        routes: [
            // PUT schema and POST members validate their body before the gate, so an empty body is a 400.
            'GET /api/studio-apps/:id/schema', 'GET /api/studio-apps/:id/members',
            'DELETE /api/studio-apps/:id/members/:userId', 'POST /api/studio-apps/:id/data/empty',
            // The app's data API and datasets. A member of org A gets "App not found" on each; the owner gets past
            // the app gate (a 200, the 400 of an empty body, or "App has no data model").
            'GET /api/studio-apps/:id/data/export', 'POST /api/studio-apps/:id/data/query', 'GET /api/studio-apps/:id/data/tables',
            'GET /api/studio-apps/:id/data/tables/:tableId/records', 'POST /api/studio-apps/:id/data/tables/:tableId/records',
            'DELETE /api/studio-apps/:id/data/tables/:tableId/records/:recordId',
            'GET /api/studio-apps/:id/data/tables/:tableId/records/:recordId',
            'PATCH /api/studio-apps/:id/data/tables/:tableId/records/:recordId', 'GET /api/studio-apps/:id/datasets',
            'POST /api/studio-apps/:id/datasets', 'DELETE /api/studio-apps/:id/datasets/:datasetId',
            'PUT /api/studio-apps/:id/datasets/:datasetId',
        ],
    },
    {
        // The runtime routes of an App Studio app (routes/studioAppsRun.js): background jobs and
        // the automation bridge. The app of org B is unpublished: a member of org A gets the
        // app gate's 404 on every route before any body, job or action is looked at. /step is
        // not here: its body names a step index, which is validated before the gate.
        kind: 'studioAppRuntime',
        mount: '/api/studio-apps',
        router: () => require('../../routes/studioAppsRun'),
        create: async ({ orgId, userId, index }) => {
            const studioAppStore = require('../../stores/studioAppStore');
            const app = await studioAppStore.createStudioApp({ userId, organizationId: orgId, name: `Runtime app ${index}` });
            return app.id;
        },
        routes: [
            'GET /api/studio-apps/:id/actions/jobs', 'GET /api/studio-apps/:id/actions/jobs/:jobId',
            'POST /api/studio-apps/:id/actions/jobs/:jobId/cancel', 'POST /api/studio-apps/:id/actions/jobs/:jobId/resume',
            'POST /api/studio-apps/:id/actions/:actionId/background', 'POST /api/studio-apps/:id/actions/:actionId/run',
            'GET /api/studio-apps/:id/actions/runs/:runId', 'POST /api/studio-apps/:id/actions/:actionId/runs/end',
        ],
    },
    {
        // The asset store (routes/studioAppAssets.mts) and the stored files (routes/studioAppFiles.js)
        // of an App Studio app, mounted together as in index.js. The app of org B is unpublished: a
        // member of org A gets 404 from the app gate on every route, the upload before its file is
        // read. The owner lists the (empty) asset store; the file routes answer the owner 404 for an
        // id that names no file, so they are not first. The two file POSTs read their body first.
        kind: 'studioAppFiles',
        mount: '/api/studio-apps',
        router: () => {
            const router = require('express').Router();
            router.use(require('../../routes/studioAppFiles'), require('../../routes/studioAppAssets.mts').studioAppAssetsRouter);
            return router;
        },
        create: async ({ orgId, userId, index }) => {
            const studioAppStore = require('../../stores/studioAppStore');
            const app = await studioAppStore.createStudioApp({ userId, organizationId: orgId, name: `Files app ${index}` });
            return app.id;
        },
        routes: [
            'GET /api/studio-apps/:id/assets', 'POST /api/studio-apps/:id/assets',
            'GET /api/studio-apps/:id/assets/:assetId', 'DELETE /api/studio-apps/:id/assets/:assetId',
            'GET /api/studio-apps/:id/data/attachments/:fileId', 'GET /api/studio-apps/:id/data/attachments/:fileId/preview',
            'DELETE /api/studio-apps/:id/data/attachments/:fileId',
        ],
    },
    {
        // The run log of an App Studio app (routes/studioApps/runLog.js): owner only, so a member
        // of org A gets 404 on the list and on a run, and the owner the list.
        kind: 'studioAppRunLog',
        mount: '/api/studio-apps',
        router: () => require('../../routes/studioApps/runLog'),
        create: async ({ orgId, userId, index }) => {
            const studioAppStore = require('../../stores/studioAppStore');
            const app = await studioAppStore.createStudioApp({ userId, organizationId: orgId, name: `Run log app ${index}` });
            return app.id;
        },
        routes: ['GET /api/studio-apps/:id/runs', 'GET /api/studio-apps/:id/runs/:runId'],
    },
    {
        // The server triggers of an App Studio app (routes/studioApps/triggers.js): owner only, so
        // a member of org A gets 404 on the list and on the switch, and the owner the list.
        kind: 'studioAppTriggers',
        mount: '/api/studio-apps',
        router: () => require('../../routes/studioApps/triggers'),
        create: async ({ orgId, userId, index }) => {
            const studioAppStore = require('../../stores/studioAppStore');
            const app = await studioAppStore.createStudioApp({ userId, organizationId: orgId, name: `Trigger app ${index}` });
            return app.id;
        },
        routes: [
            'GET /api/studio-apps/:id/triggers', 'PUT /api/studio-apps/:id/triggers/:triggerId',
            'GET /api/studio-apps/:id/triggers/:triggerId/webhook', 'POST /api/studio-apps/:id/triggers/:triggerId/webhook/secret',
            'POST /api/studio-apps/:id/triggers/:triggerId/webhook/rotate',
        ],
    },
    {
        // The address of a webhook trigger (routes/studioAppWebhook.mts), served beside the owner's
        // trigger list so the kind has a route its owner reads. The address is not an organisation's
        // id: a session of org A (of anyone) is no credential there, and without a signature every
        // address answers the same 404. What the signature opens is driven by routes/studioAppWebhook.test.js.
        kind: 'studioAppWebhook',
        mount: '/api',
        router: () => {
            const router = require('express').Router();
            router.use('/studio-apps', require('../../routes/studioApps/triggers'));
            router.use('/app-hooks', require('../../routes/studioAppWebhook.mts').studioAppWebhookRouter);
            return router;
        },
        create: async ({ orgId, userId, index }) => {
            const studioAppStore = require('../../stores/studioAppStore');
            const app = await studioAppStore.createStudioApp({ userId, organizationId: orgId, name: `Webhook app ${index}` });
            return app.id;
        },
        routes: ['GET /api/studio-apps/:id/triggers', 'POST /api/app-hooks/:endpointId'],
    },
];

module.exports = { FIXTURES };
