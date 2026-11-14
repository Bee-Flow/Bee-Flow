// @typecheck strict
/**
 * Tenant-isolation fixtures: an App Studio app, one kind per
 * router that takes its id. What a fixture is and how the matrix drives
 * it is in testUtils/tenantFixtures.js, which puts these in its list.
 */

'use strict';

const { oneFile } = require('./helpers');

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
    {
        // The app itself and the rest of the routes under its id, served by the routers index.js mounts at
        // /api/studio-apps (crud, publish, versions, public pages, runtime, connectors, large datasets, the
        // browse step and the document viewer). The app of org B is unpublished: a member of org A gets the
        // app's 404 on every route, or the 403 of manage_apps on the authoring routes; the organisation admin
        // of A, who holds manage_apps in A, gets the app's 404. The owner reads the app. The bodies and query
        // strings are what each schema accepts, so the answer is the gate's and not the schema's 400.
        kind: 'studioAppCore',
        mount: '/api/studio-apps',
        router: () => require('express').Router()
            .use(require('../../routes/studioApps'))
            .use(require('../../routes/studioAppsRun'))
            .use(require('../../routes/studioAppData'))
            .use(require('../../routes/studioAppConnectors'))
            .use(require('../../routes/studioAppFiles'), require('../../routes/studioAppAssets.mts').studioAppAssetsRouter)
            .use(require('../../routes/studioAppDatasets'))
            .use(require('../../routes/studioAppBrowse'), require('../../routes/studioAppDocuments')),
        create: async ({ orgId, userId, index }) => {
            const studioAppStore = require('../../stores/studioAppStore');
            const app = await studioAppStore.createStudioApp({ userId, organizationId: orgId, name: `Core app ${index}` });
            return app.id;
        },
        routes: [
            'GET /api/studio-apps/:id', 'GET /api/studio-apps/:id/data/connectors',
            'GET /api/studio-apps/:id/data/connectors/sync-status', 'GET /api/studio-apps/:id/documents',
            'GET /api/studio-apps/:id/documents/:docId', 'GET /api/studio-apps/:id/documents/:docId/versions',
            'GET /api/studio-apps/:id/large-datasets', 'GET /api/studio-apps/:id/large-datasets/:datasetId',
            'GET /api/studio-apps/:id/public-pages', 'GET /api/studio-apps/:id/runtime',
            'GET /api/studio-apps/:id/runtime/connectors/status', 'GET /api/studio-apps/:id/versions',
            'PATCH /api/studio-apps/:id/nextcloud-menu', 'PATCH /api/studio-apps/:id/publish',
            'POST /api/studio-apps/:id/actions/:actionId/step', 'POST /api/studio-apps/:id/actions/:actionId/step/stream',
            'POST /api/studio-apps/:id/ai/chat', 'POST /api/studio-apps/:id/check',
            'POST /api/studio-apps/:id/data/attachments', 'POST /api/studio-apps/:id/data/attachments/materialize',
            'POST /api/studio-apps/:id/data/batch', 'POST /api/studio-apps/:id/data/connectors/:connectorId/inspect',
            'POST /api/studio-apps/:id/data/connectors/:connectorId/run',
            'POST /api/studio-apps/:id/data/connectors/:connectorId/sync',
            'POST /api/studio-apps/:id/data/connectors/:connectorId/verify', 'POST /api/studio-apps/:id/documents/compare',
            'POST /api/studio-apps/:id/large-datasets', 'POST /api/studio-apps/:id/large-datasets/:datasetId/complete',
            'POST /api/studio-apps/:id/public-pages', 'POST /api/studio-apps/:id/runtime/connectors/:connectorId/refresh',
            'POST /api/studio-apps/:id/template-upgrade', 'POST /api/studio-apps/:id/versions/:versionId/restore',
            'PUT /api/studio-apps/:id', 'PUT /api/studio-apps/:id/definition',
            'PUT /api/studio-apps/:id/large-datasets/:datasetId/parts/:n',
            'DELETE /api/studio-apps/:id/large-datasets/:datasetId', 'DELETE /api/studio-apps/:id/public-pages/:token',
            'DELETE /api/studio-apps/:id',
        ],
        params: { n: '0' },
        queries: {
            'GET /api/studio-apps/:id/documents': 'node=n-matrix',
            'GET /api/studio-apps/:id/documents/:docId': 'node=n-matrix',
            'GET /api/studio-apps/:id/documents/:docId/versions': 'node=n-matrix',
        },
        bodies: {
            'PATCH /api/studio-apps/:id/nextcloud-menu': { enabled: true },
            'PATCH /api/studio-apps/:id/publish': { isPublished: true },
            'POST /api/studio-apps/:id/actions/:actionId/step': { stepIndex: 0 },
            'POST /api/studio-apps/:id/actions/:actionId/step/stream': { stepIndex: 0 },
            'POST /api/studio-apps/:id/ai/chat': { nodeId: 'n-matrix', messages: [] },
            'POST /api/studio-apps/:id/data/attachments': oneFile(),
            'POST /api/studio-apps/:id/data/attachments/materialize': { attachmentId: 'att-matrix' },
            'POST /api/studio-apps/:id/data/batch': { reads: [{ tableId: 't-matrix' }] },
            'POST /api/studio-apps/:id/documents/compare': { node: 'n-matrix', left: { documentId: 'd-matrix' }, right: { documentId: 'd-matrix' } },
            'POST /api/studio-apps/:id/large-datasets': { name: 'matrix.vcf', bytes: 10 },
            'PUT /api/studio-apps/:id': { name: 'A name that must not land here' },
            'PUT /api/studio-apps/:id/definition': { definition: require('../../appStudio/componentSpecs').emptyDefinition('Matrix'), baseVersion: 1 },
        },
        orgAdminCaller: true,
    },
    {
        // A captured template in org B's gallery (routes/studioApps/templates.js). A member of org A gets the
        // template's 404, or the 403 of manage_apps on export and delete. Not run as the admin of A who is a
        // plain group member of B: being in B, they see B's gallery, as every member of B does.
        kind: 'studioAppTemplate',
        mount: '/api/studio-apps',
        router: () => require('../../routes/studioApps'),
        create: async ({ orgId, userId, index }) => {
            const template = await require('../../stores/studioAppTemplateStore').saveTemplate({
                organizationId: orgId, createdBy: userId, title: `Template ${index}`,
                payload: { definition: { screens: [] } },
            });
            if (!template) throw new Error('saveTemplate answered nothing');
            return template.id;
        },
        routes: [
            'GET /api/studio-apps/templates/:templateId', 'GET /api/studio-apps/templates/:templateId/export',
            'DELETE /api/studio-apps/templates/:templateId',
        ],
    },
    {
        // The App Studio builder's saved session of an app of org B (routes/ai/appStudioBuilder): kept per
        // app and owner, so a member of org A gets the 404 of no session.
        kind: 'studioAppBuilderSession',
        mount: '/api/studio-apps/builder',
        router: () => require('../../routes/ai/appStudioBuilder'),
        create: async ({ orgId, userId, index }) => {
            const studioAppStore = require('../../stores/studioAppStore');
            const app = await studioAppStore.createStudioApp({ userId, organizationId: orgId, name: `Builder app ${index}` });
            await studioAppStore.setBuilderSession(app.id, userId, { sessionId: `s-matrix-${index}`, appId: app.id, messages: [] });
            return app.id;
        },
        routes: ['GET /api/studio-apps/builder/session/:appId'],
    },
];

module.exports = { FIXTURES };
